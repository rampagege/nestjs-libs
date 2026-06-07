import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';

import { SysEnv } from '@app/env';
import { validateLLMConfiguration } from '@app/features/llm';
import { BootModule } from '@app/nest/boot/boot.module';
import { addDescriptorSetReflection } from '@app/nest/boot/grpc-bootstrap';
import { addGrpcHealthService } from '@app/nest/boot/grpc-health';
import { runApp } from '@app/nest/boot/lifecycle';
import { setGrpcMicroserviceRef, shutdownState } from '@app/nest/boot/shutdown-state';
import { doMigration } from '@app/nest/common/migration';
import { AnyExceptionFilter } from '@app/nest/exceptions/any-exception.filter';
import { GrpcExceptionFilter } from '@app/nest/exceptions/grpc-exception.filter';
import { Oops } from '@app/nest/exceptions/oops';

import '@app/nest/exceptions/oops-factories';

import { GrpcServiceTokenGuard } from '@app/nest/guards';
import { GraphqlAwareClassSerializerInterceptor } from '@app/nest/interceptors/graphql-aware-class-serializer.interceptor';
import { LoggerInterceptor } from '@app/nest/interceptors/logger.interceptor';
import { VisitorInterceptor } from '@app/nest/interceptors/visitor.interceptor';
import { configureLogging, LogtapeNestLogger } from '@app/nest/logging';
import { otelTraceMiddleware } from '@app/nest/middleware/otel-trace.middleware';
import { getAppLogger } from '@app/utils/app-logger';
import { normalizeTimezone } from '@app/utils/datetime';
import { maskSecret } from '@app/utils/security';

import os from 'node:os';

import { Temporal } from '@js-temporal/polyfill';
import compression from 'compression';
import { RedisStore } from 'connect-redis';
import cookieParser from 'cookie-parser';
import { json } from 'express';
import session from 'express-session';
import { graphqlUploadExpress } from 'graphql-upload-ts';
import helmet from 'helmet';
import Redis from 'ioredis';
import morgan from 'morgan';
import responseTime from 'response-time';

import type { Server } from '@grpc/grpc-js';
import type { PackageDefinition } from '@grpc/proto-loader';
import type { DynamicModule, ForwardReference, INestApplication, LogLevel, Type } from '@nestjs/common';
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import type { MicroserviceOptions } from '@nestjs/microservices';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

const bootstrapLogger = getAppLogger('boot', 'Bootstrap');

type IEntryNestModule = Type<unknown> | DynamicModule | ForwardReference | Promise<IEntryNestModule>;

/**
 * 包装用户的 AppModule，自动注入 BootModule
 */
export function wrapWithBootModule(AppModule: IEntryNestModule): Type<unknown> {
  @Module({
    imports: [BootModule, AppModule as Type<unknown>],
  })
  class WrappedAppModule {}
  return WrappedAppModule;
}

const allLogLevels: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];

type BootstrapMode = 'api' | 'grpc' | 'scheduler';

export interface BootstrapOptions {
  /** 启动模式：api（默认）、grpc、scheduler */
  mode?: BootstrapMode;
  packageJson?: {
    name: string;
    version: string;
  };
  /** gRPC 微服务配置。api 模式下可选，grpc 模式下必需 */
  grpc?: {
    package: string | string[];
    protoPath: string | string[];
    /** 预编译 FileDescriptorSet 路径（启用 reflection + health） */
    descriptorSetPath?: string;
    /** gRPC 服务端口，默认从 SysEnv.GRPC_PORT 读取 */
    port?: number;
    /** proto-loader 选项 */
    loader?: object;
    /** 是否启用 gRPC reflection，默认 true */
    reflection?: boolean;
  };
  /** 服务提供者标识（grpc 模式，用于异常追踪），默认从 grpc.package 提取 */
  grpcProvider?: string;
  /** HTTP 端口（grpc 模式下用于健康检查），默认从 SysEnv.PORT 读取 */
  httpPort?: number;
}

export async function bootstrap(
  AppModule: IEntryNestModule,
  onInit?: (app: INestApplication) => Promise<void>,
  options?: BootstrapOptions,
) {
  const mode: BootstrapMode = options?.mode ?? 'api';
  const isApi = mode === 'api';
  const isGrpc = mode === 'grpc';

  // --- NODE_ENV 检查（api / grpc 必须设置） ---
  if ((isApi || isGrpc) && !process.env.NODE_ENV) throw new Error('NODE_ENV is not set');

  // --- gRPC 服务间鉴权硬门 ---
  // GrpcServiceTokenGuard 在 GRPC_SERVICE_TOKEN 未配置时 fail-open（warn + 放行）。
  // 生产环境绝不允许 fail-open，否则服务间 gRPC 无鉴权。stg/dev 是可信部署，不卡启动
  // （guard 运行时降 warn 放行）。
  if (SysEnv.environment.isProd && !process.env.GRPC_SERVICE_TOKEN) {
    throw Oops.Panic.Config(
      'GRPC_SERVICE_TOKEN is required in production — gRPC service-to-service auth would otherwise fail open',
    );
  }

  const now = Date.now();

  // --- 日志级别 ---
  const logLevel: LogLevel = SysEnv.LOG_LEVEL;
  const levels = allLogLevels.slice(allLogLevels.indexOf(logLevel), allLogLevels.length);
  const notShowLogLevels = allLogLevels.slice(0, allLogLevels.indexOf(logLevel));
  bootstrapLogger.info`[Config] Log level set to "${SysEnv.LOG_LEVEL}" - Enabled levels: ${levels.join(', ')}`;
  if (notShowLogLevels.length) {
    bootstrapLogger.warning`[Config] Disabled log levels: ${notShowLogLevels.join(', ')}`;
  }

  // --- api 专属：LLM 校验 + DB migration ---
  if (isApi) {
    const llmValidation = validateLLMConfiguration();
    if (!llmValidation.valid) {
      throw Oops.Panic.Config(`LLM configuration invalid: ${llmValidation.errors.join(', ')}`);
    }
    llmValidation.warnings.forEach((w: string) => {
      bootstrapLogger.warning`[LLM] ${w}`;
    });

    // DB migration（PRISMA_MIGRATION=true 时执行，必须在 Nest 初始化之前）
    doMigration();
  }

  // --- 创建应用 ---
  await configureLogging(logLevel);
  // NestExpressApplication 在 @nestjs/platform-express 新版本里加了 generic <Server>
  // 跟基类 INestApplication<any> 约束不兼容. 用 unknown 中转 + cast 让 NestFactory
  // 不再尝试推 NestExpressApplication 泛型; 同时下游 AnyExceptionFilter / onInit /
  // runApp 收到合适形态.
  const app = await (NestFactory.create as unknown as (...args: unknown[]) => Promise<NestExpressApplication>)(
    wrapWithBootModule(AppModule),
    {
      logger: new LogtapeNestLogger(),
    },
  );
  if (isApi) {
    app.set('query parser', 'extended');
  }

  // --- ValidationPipe（所有模式） ---
  app.useGlobalPipes(new ValidationPipe({ enableDebugMessages: true, transform: true, whitelist: true }));

  // --- ExceptionFilter ---
  if (isGrpc) {
    // gRPC 模式：提取 provider 名称用于异常追踪
    const provider =
      options?.grpcProvider ??
      (Array.isArray(options?.grpc?.package)
        ? (options.grpc.package[0]?.split('.').pop() ?? 'unknown')
        : (options?.grpc?.package.split('.').pop() ?? 'unknown'));
    app.useGlobalFilters(new GrpcExceptionFilter(provider));
    app.useGlobalGuards(new GrpcServiceTokenGuard());
  } else {
    // api / scheduler：AnyExceptionFilter — cast NestExpressApplication 到
    // INestApplication 兼容 AnyExceptionFilter 接口 (nest platform-express 版本
    // 加 generic 后两形态结构不兼容).
    app.useGlobalFilters(new AnyExceptionFilter(app as INestApplication));
    if (isApi) {
      bootstrapLogger.info`[Config] AnyExceptionFilter initialized with app reference for lazy i18n support`;
    }
  }

  // --- Interceptors ---
  app.useGlobalInterceptors(new GraphqlAwareClassSerializerInterceptor(app.get(Reflector)));
  if (!isGrpc) {
    // api / scheduler：VisitorInterceptor
    app.useGlobalInterceptors(new VisitorInterceptor());
  }
  app.useGlobalInterceptors(new LoggerInterceptor());

  // --- ShutdownHooks ---
  // 不调 app.enableShutdownHooks()：NestJS 内部会监听 SIGTERM 直接调 app.close()，
  // 与 lifecycle.ts 的 5-phase gracefulShutdown 竞争，导致 drain delay 被跳过。
  // lifecycle.ts 的 gracefulShutdown 全权控制 shutdown，Phase 4 手动调 app.close()。

  // --- api 专属：HTTP middleware ---
  if (isApi) {
    /*
    https://github.com/expressjs/cors#configuration-options
    https://github.com/expressjs/cors#configuring-cors-asynchronously
      不要盲目反射 Origin 头
      严格校验 Origin 头，避免出现权限泄露
      不要配置 Access-Control-Allow-Origin: null
      HTTPS 网站不要信任 HTTP 域
      不要信任全部自身子域，减少攻击面
      不要配置 Origin:* 和 Credentials: true，CORS 规定无法同时使用
      增加 Vary: Origin 头来区分不同来源的缓存
     */
    const isLocalhost = (origin: string) => /^https?:\/\/localhost(:\d+)?$/.test(origin);
    const allowedDomains = SysEnv.APP_WEB_DOMAINS?.split(',')
      .map((d) => d.trim())
      .filter(Boolean);

    const corsOrigin = (requestOrigin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // 无 Origin 头（如服务端调用、curl）→ 放行
      if (!requestOrigin) {
        callback(null, true);
        return;
      }
      // dev 环境 localhost 任意端口放行
      if (process.env.NODE_ENV !== 'production' && isLocalhost(requestOrigin)) {
        callback(null, true);
        return;
      }
      // 白名单匹配（支持 https://app.example.com 或 app.example.com 两种配置格式）
      if (allowedDomains?.length) {
        const allowed = allowedDomains.some(
          (domain) => requestOrigin === domain || requestOrigin === `https://${domain}`,
        );
        callback(null, allowed);
        return;
      }
      // 未配置 APP_WEB_DOMAINS → 禁止跨域
      callback(null, false);
    };

    const corsOptions: CorsOptions = { credentials: true, origin: corsOrigin };
    bootstrapLogger.info`[Config] CORS enabled: allowedDomains=${allowedDomains?.join(', ') ?? 'none (dev=localhost only)'}`;
    app.enableCors(corsOptions);

    // see https://expressjs.com/en/guide/behind-proxies.html
    // 设置以后，req.ips 是 ip 数组；如果未经过代理，则为 []. 若不设置，则 req.ips 恒为 []
    app.set('trust proxy', 1);

    if (SysEnv.SESSION_SECRET) {
      if (!SysEnv.INFRA_REDIS_URL)
        throw Oops.Panic.Config('INFRA_REDIS_URL is not set and required for session storage');
      const client = new Redis(SysEnv.INFRA_REDIS_URL, { maxRetriesPerRequest: 3 });
      bootstrapLogger.info`[Config] Session enabled with secret: "${maskSecret(SysEnv.SESSION_SECRET)}"`;

      app.use(
        session({
          store: new RedisStore({ client }),
          secret: SysEnv.SESSION_SECRET,
          resave: false,
          saveUninitialized: true,
          cookie: SysEnv.environment.isProd ? { secure: true } : {},
        }),
      );
    }

    // https://helmetjs.github.io/
    // Helmet helps secure Express apps by setting HTTP response headers.
    app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            'default-src': ["'self'"],
            'base-uri': ["'self'"],
            'block-all-mixed-content': [],
            'font-src': ["'self'", 'https:', 'data:'],
            'frame-ancestors': ["'self'"],
            // load all domains' images
            'img-src': ["'self'", 'data:', '*'],
            'object-src': ["'none'"],
            // 'unsafe-inline' used to run some iframe script like payment api
            'script-src': ["'self'", "'unsafe-inline'", '*'],
            'script-src-attr': ["'none'"],
            'style-src': ["'self'", 'https:', "'unsafe-inline'"],
            'upgrade-insecure-requests': [],
          },
        },
        referrerPolicy: {
          // IMPORTANT no-referrer is the default, but some payment api will not work
          policy: 'unsafe-url',
        },
      }),
    );

    app.use(cookieParser());

    // 标准化 X-Forwarded-For header
    // Node.js 会把多个同名 header 合并成数组，但 morgan 的 forwarded 库期望字符串
    // 按 RFC 7239，多个 header 应视为逗号分隔的列表，第一个 IP 是真实客户端
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const xff = req.headers['x-forwarded-for'];
      if (Array.isArray(xff)) {
        req.headers['x-forwarded-for'] = xff.join(', ');
      }
      next();
    });

    // combined 格式 + response-time（毫秒）
    app.use(
      morgan(
        ':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":response-time ms" ":referrer" ":user-agent"',
        {
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- boolean OR, not nullish fallback
          skip: (req) => req.url?.startsWith('/health') || req.url === '/',
        },
      ),
    );

    app.use(
      compression({
        filter: (req, res) => {
          // 设计意图：SSE 需要逐块推送，任何压缩都会导致代理/IOT 端缓存整包再吐出
          const contentTypeHeader = res.getHeader('Content-Type');
          const contentType = Array.isArray(contentTypeHeader)
            ? contentTypeHeader.join(';')
            : typeof contentTypeHeader === 'string'
              ? contentTypeHeader
              : '';
          if (contentType.toLowerCase().includes('text/event-stream')) {
            return false;
          }
          return compression.filter(req, res);
        },
      }),
    );
    app.use(responseTime());
    app.use(json({ limit: '1mb' }));

    // 只对 GraphQL 端点启用文件上传中间件，避免影响 REST API 的 multipart 处理
    app.use(
      '/graphql',
      graphqlUploadExpress({
        maxFileSize: 10 * 1024 * 1024,
        maxFiles: 10,
      }),
    );
  }

  // --- api / scheduler：disable x-powered-by ---
  if (!isGrpc) {
    app.disable('x-powered-by');
  }

  // --- api / scheduler：OTel trace header middleware ---
  // 无条件 mount：
  // - Sentry 模式下，middleware 读取 Sentry 已建的 SERVER span 写 trace header
  // - 非 Sentry 模式下，middleware 自己建 span 并写 header
  // 任一模式都需要 middleware 在 guard 之前写好 X-Trace-Id / traceparent，保证
  // 认证失败等异常路径的响应也带 trace 信息（iOS / 日志关联依赖）。
  if (!isGrpc) {
    bootstrapLogger.info`[Config] OTel trace header middleware mounted (sentry=${!!process.env.SENTRY_DSN})`;
    app.use(otelTraceMiddleware);
  }

  // --- onInit 回调 ---
  if (onInit) await onInit(app as INestApplication);

  // --- gRPC 微服务配置 ---
  let grpcPort: number | undefined;
  if (options?.grpc) {
    grpcPort = isGrpc ? (options.grpc.port ?? SysEnv.GRPC_PORT) : SysEnv.GRPC_PORT;
    const enableReflection = options.grpc.reflection !== false;

    const grpcMs = app.connectMicroservice<MicroserviceOptions>(
      {
        transport: Transport.GRPC,
        options: {
          package: options.grpc.package,
          protoPath: options.grpc.protoPath,
          url: `0.0.0.0:${grpcPort}`,
          loader: options.grpc.loader,
          gracefulShutdown: true,
          onLoadPackageDefinition: options.grpc.descriptorSetPath
            ? (_pkg: PackageDefinition, server: Pick<Server, 'addService'>) => {
                const dsPath = options.grpc?.descriptorSetPath;
                if (!dsPath) return;
                if (enableReflection) addDescriptorSetReflection(server, dsPath);
                addGrpcHealthService(server, dsPath, () => shutdownState.value);
              }
            : undefined,
        },
      },
      { inheritAppConfig: true },
    );
    setGrpcMicroserviceRef(grpcMs, grpcPort);

    await app.startAllMicroservices();
    bootstrapLogger.info`[gRPC] Microservice started on port ${grpcPort}${enableReflection ? ' (reflection enabled)' : ''}`;
  }

  // --- listen ---
  const port = isGrpc ? (options?.httpPort ?? SysEnv.PORT) : SysEnv.PORT;

  await runApp(app as INestApplication)
    .listen(port)
    .then(() => {
      printBanner(mode, { app, port, grpcPort, options, startedAt: now });
    });

  return app;
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

const BANNER_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

function toBannerZdt(instant: Temporal.Instant, timezone: string): Temporal.ZonedDateTime {
  return instant.toZonedDateTimeISO(normalizeTimezone(timezone) ?? 'UTC');
}

function formatBannerDateTime(zdt: Temporal.ZonedDateTime): string {
  const date = `${zdt.year.toString().padStart(4, '0')}-${zdt.month.toString().padStart(2, '0')}-${zdt.day.toString().padStart(2, '0')}`;
  const time = `${zdt.hour.toString().padStart(2, '0')}:${zdt.minute.toString().padStart(2, '0')}:${zdt.second.toString().padStart(2, '0')}`;
  return `${date} ${BANNER_WEEKDAYS[zdt.dayOfWeek - 1]} ${time}`;
}

function printBanner(
  mode: BootstrapMode,
  ctx: {
    app: NestExpressApplication;
    port: number;
    grpcPort: number | undefined;
    options: BootstrapOptions | undefined;
    startedAt: number;
  },
) {
  const startTime = Temporal.Now.instant();
  const nodeVersion = process.version;
  const bunVersion = 'Bun' in globalThis ? (globalThis as unknown as { Bun: { version: string } }).Bun.version : null;
  const runtimeVersions = bunVersion ? `Node ${nodeVersion} / Bun ${bunVersion}` : `Node ${nodeVersion}`;

  if (mode === 'api') {
    printApiBanner(ctx, startTime, runtimeVersions);
  } else if (mode === 'grpc') {
    printGrpcBanner(ctx, startTime, runtimeVersions);
  } else {
    printSchedulerBanner(ctx, startTime, runtimeVersions);
  }
}

function printApiBanner(
  ctx: {
    app: NestExpressApplication;
    port: number;
    grpcPort: number | undefined;
    options: BootstrapOptions | undefined;
    startedAt: number;
  },
  startTime: Temporal.Instant,
  runtimeVersions: string,
) {
  const sysEnvTime = toBannerZdt(startTime, SysEnv.TZ);
  const localTime = toBannerZdt(startTime, Temporal.Now.timeZoneId());
  const utcTime = toBannerZdt(startTime, 'UTC');
  const server = ctx.app.getHttpServer();
  const address = server.address();
  const bindAddress = address
    ? typeof address === 'string'
      ? address
      : `${address.address}:${address.port}`
    : 'unknown';

  // 环境配置安全检查：生产模式下必须明确指定业务环境
  // 设计意图：防止在生产模式(NODE_ENV=production)下误用默认的 dev 环境，导致数据混乱或安全问题
  if (process.env.NODE_ENV === 'production') {
    if (!SysEnv.ENV && !SysEnv.DOPPLER_ENVIRONMENT) {
      bootstrapLogger.warning`[Security] NODE_ENV=production 但未设置 ENV 或 DOPPLER_ENVIRONMENT，将使用默认值 "dev"`;
      bootstrapLogger.warning`建议：在 .env.production 中明确设置 ENV=prd (生产) 或 ENV=stg (预发布)`;
      bootstrapLogger.warning`风险：当前配置可能导致生产模式代码连接到测试环境数据，或测试代码连接到生产数据`;
    }
  }

  // 环境信息说明：
  // - NODE_ENV: Node.js 运行模式（技术层面）- 控制代码优化、日志详细度、热重载等
  // - ENV: 业务环境标识（业务层面）- 控制连接哪个数据库、是否真实支付、发送真实通知等
  const runtimeModeDesc =
    process.env.NODE_ENV === 'production'
      ? '生产模式(代码优化)'
      : process.env.NODE_ENV === 'development'
        ? '开发模式(热重载)'
        : '测试模式';

  const businessEnvDesc = SysEnv.environment.isProd
    ? '生产环境(真实数据)'
    : SysEnv.environment.env === 'stg'
      ? '预发布环境(测试数据)'
      : '开发环境(测试数据)';

  bootstrapLogger.info`🦋 [Server] API Server started successfully`;
  bootstrapLogger.info`┌─ 环境配置 ─────────────────────────────────────────────`;
  bootstrapLogger.info`│ Node Runtime (NODE_ENV): ${process.env.NODE_ENV ?? 'N/A'} - ${runtimeModeDesc}`;
  bootstrapLogger.info`│ Business Env (ENV): ${SysEnv.environment.env} - ${businessEnvDesc} → isProd=${SysEnv.environment.isProd}`;
  bootstrapLogger.info`│ Doppler Env: ${SysEnv.DOPPLER_ENVIRONMENT ?? 'N/A'}`;
  bootstrapLogger.info`├─ 应用信息 ─────────────────────────────────────────────`;
  bootstrapLogger.info`│ App Version: ${ctx.options?.packageJson?.name ?? 'unknown'}-v${ctx.options?.packageJson?.version ?? 'unknown'}`;
  bootstrapLogger.info`│ Host: ${os.hostname()}`;
  bootstrapLogger.info`│ Node Name: ${SysEnv.NODE_NAME}`;
  bootstrapLogger.info`│ Bind: ${bindAddress}`;
  bootstrapLogger.info`│ Port: ${ctx.port}`;
  bootstrapLogger.info`│ PID: ${process.pid}`;
  bootstrapLogger.info`├─ 运行时信息 ───────────────────────────────────────────`;
  bootstrapLogger.info`│ Platform: ${process.platform}`;
  bootstrapLogger.info`│ Runtime: ${runtimeVersions}`;
  bootstrapLogger.info`│ SysEnv.TZ Time: ${formatBannerDateTime(sysEnvTime)} (${sysEnvTime.timeZoneId})`;
  bootstrapLogger.info`│ Local Time: ${formatBannerDateTime(localTime)} (${localTime.timeZoneId})`;
  bootstrapLogger.info`│ UTC Time: ${formatBannerDateTime(utcTime)}`;
  bootstrapLogger.info`└─ Startup Time: ${Date.now() - ctx.startedAt}ms`;
}

function printGrpcBanner(
  ctx: {
    port: number;
    grpcPort: number | undefined;
    options: BootstrapOptions | undefined;
    startedAt: number;
  },
  startTime: Temporal.Instant,
  runtimeVersions: string,
) {
  const utcTime = toBannerZdt(startTime, 'UTC');
  const enableReflection = ctx.options?.grpc?.reflection !== false;

  bootstrapLogger.info`🦋 [Server] gRPC Server started successfully`;
  bootstrapLogger.info`┌─ 环境配置 ─────────────────────────────────────────────`;
  bootstrapLogger.info`│ Node Runtime (NODE_ENV): ${process.env.NODE_ENV ?? 'N/A'}`;
  bootstrapLogger.info`│ Business Env (ENV): ${SysEnv.environment.env} → isProd=${SysEnv.environment.isProd}`;
  bootstrapLogger.info`│ Doppler Env: ${SysEnv.DOPPLER_ENVIRONMENT ?? 'N/A'}`;
  bootstrapLogger.info`├─ 应用信息 ─────────────────────────────────────────────`;
  bootstrapLogger.info`│ App Version: ${ctx.options?.packageJson?.name ?? 'unknown'}-v${ctx.options?.packageJson?.version ?? 'unknown'}`;
  bootstrapLogger.info`│ Host: ${os.hostname()}`;
  bootstrapLogger.info`│ gRPC Port: ${ctx.grpcPort}${enableReflection ? ' (reflection enabled)' : ''}`;
  bootstrapLogger.info`│ HTTP Port: ${ctx.port} (health check)`;
  bootstrapLogger.info`│ Service Token: ${process.env.GRPC_SERVICE_TOKEN ? 'configured' : 'not configured'}`;
  bootstrapLogger.info`│ PID: ${process.pid}`;
  bootstrapLogger.info`├─ 运行时信息 ───────────────────────────────────────────`;
  bootstrapLogger.info`│ Platform: ${process.platform}`;
  bootstrapLogger.info`│ Runtime: ${runtimeVersions}`;
  bootstrapLogger.info`│ UTC Time: ${formatBannerDateTime(utcTime)}`;
  bootstrapLogger.info`└─ Startup Time: ${Date.now() - ctx.startedAt}ms`;
}

function printSchedulerBanner(
  ctx: {
    port: number;
    options: BootstrapOptions | undefined;
    startedAt: number;
  },
  startTime: Temporal.Instant,
  runtimeVersions: string,
) {
  const sysEnvTime = toBannerZdt(startTime, SysEnv.TZ);
  bootstrapLogger.info`🦋 [Scheduler] Scheduler process started successfully`;
  bootstrapLogger.info`┌─ 配置 ─────────────────────────────────────────────────`;
  bootstrapLogger.info`│ Mode: scheduler`;
  bootstrapLogger.info`│ Env: ${SysEnv.environment.env} (isProd=${SysEnv.environment.isProd})`;
  bootstrapLogger.info`│ Doppler: ${SysEnv.DOPPLER_ENVIRONMENT ?? 'N/A'}`;
  bootstrapLogger.info`├─ 应用 ─────────────────────────────────────────────────`;
  bootstrapLogger.info`│ App: ${ctx.options?.packageJson?.name ?? 'unknown'}-v${ctx.options?.packageJson?.version ?? 'unknown'}`;
  bootstrapLogger.info`│ Host: ${os.hostname()}`;
  bootstrapLogger.info`│ Port: ${ctx.port}`;
  bootstrapLogger.info`│ PID: ${process.pid}`;
  bootstrapLogger.info`├─ 运行时 ───────────────────────────────────────────────`;
  bootstrapLogger.info`│ Platform: ${process.platform}`;
  bootstrapLogger.info`│ Runtime: ${runtimeVersions}`;
  bootstrapLogger.info`│ Time: ${formatBannerDateTime(sysEnvTime)} (${sysEnvTime.timeZoneId})`;
  bootstrapLogger.info`└─ Startup: ${Date.now() - ctx.startedAt}ms`;
}
