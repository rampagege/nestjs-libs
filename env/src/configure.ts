import { getAppLogger } from '@app/utils/app-logger';
import { errorStack } from '@app/utils/error';

import { NODE_ENV } from './env';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { config } from '@dotenvx/dotenvx';
import { plainToInstance, Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, Min, validateSync } from 'class-validator';
import JSON5 from 'json5';
import * as _ from 'radash';

import type { TransformFnParams } from 'class-transformer';

const transformLogger = getAppLogger('Transform');
const configureLogger = getAppLogger('Configure');

export const booleanTransformFn = ({ key, obj }: TransformFnParams) => {
  // Logger.log(f`key: ${{ origin: obj[key] }}`, 'Transform');
  return [true, 'true', '1'].includes(obj[key] as string | boolean);
};
export const objectTransformFn = ({ key, value, obj }: TransformFnParams) => {
  // Logger.log(f`-[Transform]- ${{ key, value, origin: obj[key], isObject: _.isObject(obj[key]) }}`);
  try {
    return _.isObject(obj[key]) ? obj[key] : JSON5.parse((obj[key] as string) || '{}');
  } catch (e: unknown) {
    transformLogger.error`#objectTransformFn error ${{ key, value, origin: obj[key], isObject: _.isObject(obj[key]) }} ${e instanceof Error ? e.message : String(e)} ${errorStack(e) ?? ''}`;
    throw e;
  }
};
export const arrayTransformFn = ({ key, value, obj }: TransformFnParams) => {
  // Logger.log(f`-[Transform]- ${{ key, value, origin: obj[key], isArray: _.isArray(obj[key]) }}`);
  try {
    return _.isArray(obj[key]) ? obj[key] : JSON5.parse((obj[key] as string) || '[]');
  } catch (e: unknown) {
    transformLogger.error`#arrayTransformFn error ${{ key, value, origin: obj[key], isArray: _.isArray(obj[key]) }} ${e instanceof Error ? e.message : String(e)} ${errorStack(e) ?? ''}`;
    throw e;
  }
};

type HostSetVariables = {};

const DatabaseFieldSymbol = Symbol('DatabaseField');
const DatabaseFieldFormatSymbol = Symbol('DatabaseFieldFormat');
const DatabaseFieldDescriptionSymbol = Symbol('DatabaseFieldDescription');
const DatabaseFieldScopedSymbol = Symbol('DatabaseFieldScoped');

// ==================== LLM Model Field ====================

const llmModelFields = new Set<string>();

/**
 * 标记字段为 LLM Model 配置
 *
 * 被标记的字段会在启动时自动验证：
 * - Model 是否已注册
 * - 对应 Provider 的 API Key 是否已配置
 *
 * @example
 * @LLMModelField()
 * @IsString() @IsOptional()
 * DEFAULT_LLM_MODEL?: string = 'openrouter:gemini-2.5-flash';
 *
 * @LLMModelField()
 * @IsString() @IsOptional()
 * I18N_LLM_MODEL?: string;
 */
export function LLMModelField(): PropertyDecorator {
  return (_target, propertyKey) => {
    llmModelFields.add(propertyKey as string);
  };
}

/**
 * 获取所有标记为 @LLMModelField 的字段名
 */
export function getLLMModelFields(): string[] {
  return Array.from(llmModelFields);
}
/**
 * 标记字段是否需要同步到数据库, 用于配置项的动态更新
 *
 * @param format 字段格式
 * @param descriptionOrOptions 描述字符串 或 { description?, scoped? } 选项
 *
 * scoped 字段写入项目 scope（需要 AppConfigure 传 scope），否则写入 'shared'
 */
export const DatabaseField =
  (
    format: 'string' | 'number' | 'boolean' | 'json' = 'string',
    descriptionOrOptions?: string | { description?: string; scoped?: boolean },
  ) =>
  (target: object, propertyKey: string) => {
    const description =
      typeof descriptionOrOptions === 'string' ? descriptionOrOptions : descriptionOrOptions?.description;
    const scoped = typeof descriptionOrOptions === 'object' ? descriptionOrOptions.scoped === true : false;

    Reflect.defineMetadata(DatabaseFieldSymbol, true, target, propertyKey);
    Reflect.defineMetadata(DatabaseFieldFormatSymbol, format, target, propertyKey);
    if (description) {
      Reflect.defineMetadata(DatabaseFieldDescriptionSymbol, description, target, propertyKey);
    }
    if (scoped) {
      Reflect.defineMetadata(DatabaseFieldScopedSymbol, true, target, propertyKey);
    }
    if (format === 'boolean') {
      Transform(booleanTransformFn)(target, propertyKey);
      IsBoolean()(target, propertyKey);
      IsOptional()(target, propertyKey);
    }
  };

export class AbstractEnvironmentVariables implements HostSetVariables {
  // getter 而非实例属性：此类会被 structuredClone 复制，LogTape logger 不可序列化
  private get logger() {
    return getAppLogger(this.constructor.name);
  }
  private readonly hostname = os.hostname();

  // use doppler env instead
  // @IsEnum 用数组时默认错误消息不含枚举值列表，需自定义 message 明确显示允许值
  @IsEnum(['prd', 'stg', 'dev'], {
    message: 'ENV must be one of: prd, stg, dev (got: $value)',
  })
  @IsOptional()
  ENV?: 'prd' | 'stg' | 'dev';

  @IsEnum(NODE_ENV, {
    message: 'NODE_ENV must be one of: development, production, test (got: $value)',
  })
  NODE_ENV: NODE_ENV = NODE_ENV.Development;

  get isNodeDevelopment() {
    return process.env.NODE_ENV === 'development';
  }

  /**
   * 是否为 CLI 模式运行
   *
   * 用于区分 CLI 调试和正常服务运行，CLI 模式下可以：
   * - 输出调试文件（如 prompt JSON）
   * - 打印更详细的日志
   */
  get isCliMode(): boolean {
    return process.argv.some((arg) => arg.includes('cli.ts') || arg.includes('cli:'));
  }

  // 使用 @Type(() => Number) 显式指定类型转换
  // 原因：
  // 1. 环境变量中的值都是字符串类型
  // 2. TypeScript 的类型信息在编译后会丢失
  // 3. 需要显式告诉 class-transformer 如何转换类型
  // 4. 这样可以确保在所有环境下（如 bun mastra dev）都能正确转换
  @Type(() => Number) @IsNumber() @IsOptional() PORT: number = 3100;
  @Type(() => Number) @IsNumber() @IsOptional() GRPC_PORT: number = 50051;
  @IsString() TZ = 'UTC';

  // 因为 有些服务器的 hostname 是 localhost，所以需要添加一个随机数来区分
  get NODE_NAME() {
    return os.hostname() === 'localhost' ? `localhost-${Date.now()}:${this.PORT}` : `${os.hostname()}:${this.PORT}`;
  }

  @IsEnum(['verbose', 'debug', 'log', 'warn', 'error', 'fatal'], {
    message: 'LOG_LEVEL must be one of: verbose, debug, log, warn, error, fatal (got: $value)',
  })
  LOG_LEVEL: 'verbose' | 'debug' | 'log' | 'warn' | 'error' | 'fatal' = 'debug';

  @DatabaseField(
    'string',
    '系统API密钥，仅用于验证系统级内部API请求，不自行设置的话每次启动都会变更，注意: 不要外部使用',
  )
  @IsString()
  @IsOptional()
  API_KEY?: string = undefined;

  // used to debug dependency issues
  @IsString() @IsOptional() NEST_DEBUG?: string;

  @IsString() @IsOptional() DOPPLER_ENVIRONMENT?: string;

  @IsString() @IsOptional() SESSION_SECRET?: string;

  /** CORS 允许的前端域名（逗号分隔），未设置时禁止所有跨域请求 */
  @IsString() @IsOptional() APP_WEB_DOMAINS?: string;

  @IsString() @IsOptional() SERVICE_NAME?: string;
  @IsString() @IsOptional() TRACING_EXPORTER_URL?: string;

  // ==================== OpenTelemetry 配置 ====================
  @IsString() @IsOptional() OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  @IsString() @IsOptional() OTEL_LOG_LEVEL?: string;

  @IsBoolean() @IsOptional() @Transform(booleanTransformFn) APP_PROXY_ENABLED?: boolean;
  @IsString() @IsOptional() APP_PROXY_HOST?: string;
  @Type(() => Number) @IsNumber() @IsOptional() APP_PROXY_PORT?: number;

  // ==================== GraphQL ====================
  @IsBoolean() @IsOptional() @Transform(booleanTransformFn) GRAPHQL_PLAYGROUND_ENABLED?: boolean;

  // ==================== LLM ====================
  @IsString() @IsOptional() AI_OPENROUTER_API_KEY?: string;
  @IsString() @IsOptional() AI_GOOGLE_API_KEY?: string;
  /** Vertex AI API key（优先用于 Express Mode；vertex-global 也可用它发 x-goog-api-key） */
  @IsString() @IsOptional() AI_GOOGLE_VERTEX_API_KEY?: string;
  /** Vertex AI project/global mode project id；`vertex-global:*` 的官方 PayGo 路径必需 */
  @IsString() @IsOptional() GOOGLE_VERTEX_PROJECT?: string;
  /** Vertex AI location；Priority/Flex PayGo 文档要求使用 global */
  @IsString() @IsOptional() GOOGLE_VERTEX_LOCATION?: string;
  /** Google Cloud project id（Google SDK 文档变量名，作为 GOOGLE_VERTEX_PROJECT fallback） */
  @IsString() @IsOptional() GOOGLE_CLOUD_PROJECT?: string;
  /** Google Cloud location（Google SDK 文档变量名，作为 GOOGLE_VERTEX_LOCATION fallback） */
  @IsString() @IsOptional() GOOGLE_CLOUD_LOCATION?: string;
  @IsString() @IsOptional() AI_OPENAI_API_KEY?: string;
  @IsString() @IsOptional() AI_JINA_API_KEY?: string;
  @IsString() @IsOptional() AI_VOYAGE_API_KEY?: string;

  // ── 旧名字兼容（其他项目迁移前保留）──
  /** @deprecated use AI_OPENROUTER_API_KEY */
  @IsString() @IsOptional() OPENROUTER_API_KEY?: string;
  /** @deprecated use AI_GOOGLE_API_KEY */
  @IsString() @IsOptional() GOOGLE_GENERATIVE_AI_API_KEY?: string;
  /** @deprecated use AI_GOOGLE_VERTEX_API_KEY */
  @IsString() @IsOptional() GOOGLE_VERTEX_API_KEY?: string;
  /** @deprecated use AI_OPENAI_API_KEY */
  @IsString() @IsOptional() OPENAI_API_KEY?: string;
  /** @deprecated use AI_JINA_API_KEY */
  @IsString() @IsOptional() JINA_API_KEY?: string;
  /** @deprecated use AI_VOYAGE_API_KEY */
  @IsString() @IsOptional() VOYAGE_API_KEY?: string;
  /** 默认 LLM 模型，当指定模型不存在时作为 fallback（仅生产环境）。值须为已注册的 LLMModelKey（如 'openrouter:gemini-2.5-flash'） */
  @LLMModelField() @IsString() @IsOptional() DEFAULT_LLM_MODEL?: string;

  /** 默认 LLM 调用超时（毫秒），透传给 AI SDK 的 timeout 参数 */
  @DatabaseField('number', '默认 LLM 调用超时（毫秒）')
  @Type(() => Number)
  @IsNumber()
  @Min(30_000)
  AI_LLM_TIMEOUT_MS: number = 120_000;

  /** 默认 LLM 调用最大重试次数（429/5xx 自动重试，exponential backoff） */
  @DatabaseField('number', '默认 LLM 最大重试次数')
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  AI_LLM_MAX_RETRIES: number = 2;

  /** LLM fetch 详细日志（Bun verbose=true，打印 HTTP headers + TLS 到 stderr），用于诊断 provider 断连 */
  @DatabaseField('boolean', 'LLM fetch 详细日志（Bun verbose，打印 HTTP headers + TLS 到 stderr）')
  @IsBoolean()
  @IsOptional()
  @Transform(booleanTransformFn)
  LLM_FETCH_VERBOSE: boolean = false;

  @IsString() @IsOptional() INFRA_REDIS_URL?: string;

  // ==================== Cluster (node-registry) ====================
  // 对齐 modx node-registry addon：
  // - CLUSTER_ENABLED 控制整个模块是否激活（多实例部署 = true）
  // - TTL / heartbeat 间隔使用 modx 默认值（300s / 60s），env 可覆盖
  @IsBoolean() @IsOptional() @Transform(booleanTransformFn) CLUSTER_ENABLED: boolean = true;
  @IsString() @IsOptional() CLUSTER_NODE_TTL_SECONDS?: string;
  @IsString() @IsOptional() CLUSTER_HEARTBEAT_INTERVAL_MS?: string;

  @IsString() @IsOptional() DATABASE_URL?: string;
  @IsBoolean() @IsOptional() @Transform(booleanTransformFn) PRISMA_QUERY_LOGGER?: boolean;
  @IsBoolean() @IsOptional() @Transform(booleanTransformFn) PRISMA_QUERY_LOGGER_WITH_PARAMS?: boolean;
  @IsBoolean() @IsOptional() @Transform(booleanTransformFn) PRISMA_MIGRATION?: boolean;
  // 历史遗留：此开关已被 scope 隔离 + createdBy 归属机制取代。
  // 有 projectScope 时服务自动获得写权限，无需手动开启。
  // 保留字段定义仅为避免环境变量校验报错。
  @IsBoolean() @IsOptional() @Transform(booleanTransformFn) APP_CONFIG_SYNC_WRITE_ENABLED: boolean = false;
  @DatabaseField('number', 'Prisma 事务超时时间（毫秒）') @IsNumber() PRISMA_TRANSACTION_TIMEOUT: number = 30_000;

  /**
   * 是否启用异常处理器的 I18n 翻译功能
   * 【设计意图】
   * - GraphQL 上下文中获取 I18nService 会触发 NestJS ExceptionsZone 异常传播导致应用崩溃
   * - 该功能非核心，失败时应降级到原始消息而非崩溃
   * - 默认禁用，等 I18nService 在所有上下文中可用后再启用
   */
  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    return false;
  })
  @DatabaseField('boolean', '是否启用异常处理器的 I18n 翻译功能')
  I18N_EXCEPTION_ENABLED?: boolean = false;

  // ==================== Feature Flags ====================
  @IsBoolean() @IsOptional() @Transform(booleanTransformFn) FEATURE_SCHEDULER?: boolean;

  // 是否在遇到 uncaughtException 或 unhandledRejection 时自动退出进程
  @IsBoolean() @Transform(booleanTransformFn) EXIT_ON_ERROR: boolean = true;

  /**
   * 优雅关闭时等待进行中请求完成的超时时间（毫秒）
   *
   * 设计意图：
   * - SIGTERM 收到后，先停止接收新连接，然后等待现有请求完成
   * - 超过此时间后强制关闭，避免无限等待
   * - 应小于 K8s terminationGracePeriodSeconds 减去 preStop 延迟
   *
   * 计算公式：IN_FLIGHT_TIMEOUT_MS < terminationGracePeriodSeconds - preStop - DRAIN_DELAY_MS
   * 默认：60s（支持最长 1 分钟的请求如 chat API）
   */
  @Type(() => Number) @IsNumber() @IsOptional() IN_FLIGHT_TIMEOUT_MS: number = 60_000;

  /**
   * 优雅关闭时的排空延迟（毫秒）
   *
   * 设计意图：
   * - 收到 shutdown 信号后，先标记 readiness=503 / gRPC=NOT_SERVING
   * - 然后等待此时间，让 K8s / LB 传播端点变更，停止路由新流量
   * - 之后才开始关闭服务器和等待 in-flight 请求
   *
   * SIGTERM 场景：preStop(10s) 已提前执行，排空延迟可用较短值
   * SIGUSR1 场景：无 preStop，需要完整排空延迟
   *
   * 默认 10s，覆盖 K8s readiness probe 周期(3s) + endpoint 传播延迟
   */
  @Type(() => Number) @IsNumber() @IsOptional() DRAIN_DELAY_MS: number = 15_000;

  /**
   * gRPC drain grace period（毫秒）
   *
   * Phase 2.6 调用 grpc.Server.drain(port, graceTimeMs)，发送 GOAWAY 帧。
   * 已有连接在 graceTimeMs 内完成请求后被关闭，新连接立即被拒绝。
   * fire-and-forget：drain 的 grace 计时器和 Phase 3 的 in-flight timeout 并行跑。
   */
  @Type(() => Number) @IsNumber() @IsOptional() GRPC_DRAIN_MS: number = 60_000;

  get environment() {
    const env = this.ENV ?? this.DOPPLER_ENVIRONMENT ?? 'dev';
    const isProd = env === 'prd';
    return {
      env,
      isProd,
    };
  }

  static get allFields() {
    const instance = new AbstractEnvironmentVariables();
    return Object.getOwnPropertyNames(instance);
  }

  /**
   * Retrieves the value of a specified field based on the hostname of the current system.
   *
   * @template F - The type of the field to retrieve
   * @param {F} field - The field to retrieve the value from
   * @param {HostSetVariables[F][0] | boolean} [fallback] - The fallback value to use if the retrieval fails
   * @returns {HostSetVariables[F][0]} - The retrieved value of the specified field
   */
  // getByHost<F extends keyof HostSetVariables>(
  //   field: F,
  //   fallback?: HostSetVariables[F][0] | boolean,
  // ): HostSetVariables[F][0] | boolean | undefined {
  //   try {
  //     const index = this.hostIndex;
  //     if (_.isNullish(index)) {
  //       this.logger.warn(f`#getByHost (${this.hostname}) ${{ field, index }}`);
  //       return _.isBoolean(fallback) ? _.pathOr(this, [field, 0]) : fallback;
  //     }
  //     this.logger.verbose(f`#getByHost (${this.hostname}) ${{ field, index }}`);
  //     return _.isBoolean(fallback)
  //       ? (_.prop(this[field], index) ?? _.pathOr(this, [field, 0]))
  //       : (_.prop(this[field], index) ?? fallback);
  //   } catch (e: unknown) {
  //     this.logger.error(
  //       f`#getByHost (${this.hostname}) ${field} ${e instanceof Error ? e.message : String(e)}`,
  //       onelineStackFromError(e),
  //     );
  //     return _.isBoolean(fallback) ? _.pathOr(this, [field, 0]) : fallback;
  //   }
  // }

  get hostIndex() {
    const part = this.hostname.split('-').pop();
    const index = typeof part === 'string' ? +part : null;
    return typeof index === 'number' && !isNaN(index) ? index : null;
  }

  /**
   * Retrieves the unique host based on the specified host ID and accept policy.
   *
   * @param {Object} options - The options for retrieving the unique host.
   * @param {number} options.hostId - The host ID to compare with the current host.
   * @param {boolean} options.acceptWhenNoIds - Specifies whether to accept when there are no host IDs available.
   * @returns {boolean} - True if the host ID matches the current host, or if there are no host IDs available and the accepted policy allows it. False otherwise.
   */
  getUniqueHost({
    hostId,
    acceptWhenNoIds,
    key,
  }: {
    hostId?: number;
    acceptWhenNoIds?: boolean;
    key: string;
  }): boolean {
    try {
      const host = hostId ?? 0;
      this.hostKeys[host] = [...(this.hostKeys[host] ?? []), key];
      const index = this.hostIndex;
      const on = index == null ? !!acceptWhenNoIds : index === host;
      this.logger.debug`#getUniqueHost (${this.hostname}) ${{ key }} ${{ host, index, acceptWhenNoIds, on }}`;
      return on;
    } catch {
      this.logger.warning`#getUniqueHost no hostIndex for ${this.hostname}`;
    }
    return !!acceptWhenNoIds;
  }

  hostKeys: Record<number, Array<string>> = {};
}

/**
 * SysEnv / AbstractEnvironmentVariables 上可映射到 `process.env` 的配置字段名。
 *
 * - 与 class 字段同名（如 `AI_GOOGLE_VERTEX_API_KEY`），供 bootstrap `requiredEnvs` 等启动契约使用
 * - 只保留标量配置形态（string | number | boolean | nullish），排除 `environment` 等对象 getter
 * - 再排除已知非 env 的 getter / 内部字段（不可映射到 process.env）
 *
 * @example
 * ```ts
 * const keys: SysEnvConfigKey[] = ['AI_GOOGLE_VERTEX_API_KEY', 'DATABASE_URL'];
 * ```
 */
type AbstractEnvironmentScalar = string | number | boolean | undefined | null;

type AbstractEnvironmentScalarKey = {
  [K in keyof AbstractEnvironmentVariables]-?: AbstractEnvironmentVariables[K] extends AbstractEnvironmentScalar
    ? K
    : never;
}[keyof AbstractEnvironmentVariables];

/** Getters / non-env members that look scalar but are not process.env keys. */
type AbstractEnvironmentNonEnvScalarKey = 'isNodeDevelopment' | 'isCliMode' | 'NODE_NAME' | 'hostIndex';

export type SysEnvConfigKey = Exclude<AbstractEnvironmentScalarKey, AbstractEnvironmentNonEnvScalarKey> & string;

export interface ISysAppSettingRecord {
  key: string;
  scope: string;
  value: string | null;
  defaultValue: string | null;
  format: string;
  description?: string | null;
  deprecatedAt?: Date | null;
  createdBy?: string | null;
}

export interface ISysAppSettingClient {
  sysAppSetting: {
    findMany(args?: { where?: { scope?: { in: string[] } } }): Promise<ISysAppSettingRecord[]>;
    updateMany(args: {
      where: { key: { in: string[] }; scope?: string };
      data: { deprecatedAt: Date | null };
    }): Promise<{ count: number }>;
    createMany(args: {
      data: Array<{
        key: string;
        scope: string;
        defaultValue: string | null;
        format: string;
        description?: string | null;
        createdBy?: string | null;
      }>;
      skipDuplicates?: boolean;
    }): Promise<{ count: number }>;
    findUnique(args: { where: { scope_key: { scope: string; key: string } } }): Promise<ISysAppSettingRecord | null>;
    create(args: {
      data: {
        key: string;
        scope: string;
        value: string | null;
        defaultValue: string | null;
        format: string;
        description?: string | null;
      };
    }): Promise<ISysAppSettingRecord>;
    update(args: {
      where: { scope_key: { scope: string; key: string } };
      data: { defaultValue?: string | null; description?: string | null; deprecatedAt?: Date | null };
    }): Promise<ISysAppSettingRecord>;
  };
}

export interface AppConfigureOptions {
  /**
   * 无数据库模式
   *
   * 设计意图：
   * - 适用于纯 gRPC 服务、CLI 工具等无数据库连接的项目
   * - sync() 方法将跳过数据库同步，仅保留环境变量加载和验证能力
   * - 使用 createNoDBConfigure() 工厂函数创建
   */
  noDB?: boolean;

  /**
   * 项目 scope 标识
   *
   * 多项目共享 sys_app_settings 表时，用于隔离 orphan 检测和 scoped 字段。
   * @DatabaseField 默认写入 scope='shared'，{ scoped: true } 写入此 scope。
   * 未设置时所有操作仅在 'shared' scope 内。
   */
  scope?: string;
}

export class AppConfigure<T extends AbstractEnvironmentVariables> {
  private readonly logger = getAppLogger(this.constructor.name);

  /** 敏感字段 redact：匹配命名规范或精确名称，日志输出替换为 *** */
  private static isSensitive(key: string): boolean {
    return /(_KEY|_SECRET|_TOKEN|_DSN|_PASSWORD)$/.test(key) || key === 'DATABASE_URL';
  }

  public readonly vars: T;
  public readonly originalVars: T; // 添加原始副本

  /** sys 自动推断：EnvsClass === AbstractEnvironmentVariables 时为 SysEnv */
  private readonly sys: boolean;

  /**
   * 记录每个 key 的来源：'host'（K8s/系统环境变量）或 .env 文件路径
   * 用于启动日志区分 process.env vs .env 文件来源，帮助发现配置覆盖问题
   */
  private readonly envSourceMap: Map<string, string>;

  /**
   * Order of precedence:
   * process.env
   * .env.$(NODE_ENV).local
   * .env.local (Not checked when NODE_ENV is test.)
   * .env.$(NODE_ENV)
   * .env
   * @param EnvsClass - 环境变量类
   * @param options - 配置选项（scope 默认从 APP_NAME 环境变量获取）
   */
  constructor(
    readonly EnvsClass: new () => T,
    private readonly options: AppConfigureOptions = {},
  ) {
    // sys 自动推断：基类 = 系统配置，子类 = 应用配置
    this.sys = EnvsClass === (AbstractEnvironmentVariables as unknown);
    // scope 默认从 APP_NAME 环境变量获取，无需手动传
    if (!options.scope && process.env.APP_NAME) {
      options.scope = process.env.APP_NAME;
    }
    const envFilePath = (() => {
      switch (process.env.NODE_ENV) {
        case NODE_ENV.Test:
          // 测试环境应保持隔离：不要加载开发者本地的 `.env.local`（可能包含代理/证书等本机配置，甚至干扰解析）。
          // 允许使用可选的 `.env.test.local` 覆盖测试配置。
          return ['.env.test.local', '.env.test'];
        case NODE_ENV.Production:
          return ['.env.local', '.env'];
        default:
          return ['.env.development.local', '.env.local', '.env.development', '.env'];
      }
    })();

    // 在加载任何 .env 文件前，记录已有的 key（来自 K8s/系统 host 环境）
    const sourceMap = new Map<string, string>();
    for (const key of Object.keys(process.env)) {
      sourceMap.set(key, 'host');
    }

    if (this.sys) this.logger.info`load env from paths: ${envFilePath}`;
    envFilePath.forEach((env) => {
      // 使用 process.env.PWD 而不是 process.cwd() 的原因：
      // 1. process.cwd() 在 monorepo 项目中可能会指向子目录（如 .mastra/output）
      // 2. process.env.PWD 会保持原始的工作目录，即项目根目录
      // 3. 这样可以确保 .env 文件从正确的项目根目录加载，而不是从构建输出目录加载
      const fullPath = path.resolve(process.env.PWD ?? '', env);
      if (this.sys) this.logger.info`envFilePath: ${fullPath}`;
      // dotenvx 对于缺失文件会输出一条 “injecting env (0)” 的噪音日志（即使配置了 ignore MISSING_ENV_FILE）。
      // 这里主动跳过不存在的文件，保持启动/测试输出干净。
      if (!fs.existsSync(fullPath)) {
        return;
      }
      // override: false → host env 优先；加载后 diff 出新增 key 记录来源文件
      const beforeKeys = new Set(Object.keys(process.env));
      config({ path: fullPath, override: false, ignore: ['MISSING_ENV_FILE'] });
      for (const key of Object.keys(process.env)) {
        if (!beforeKeys.has(key)) sourceMap.set(key, env);
      }
    });
    this.envSourceMap = sourceMap;
    this.vars = this.validate();
    this.originalVars = structuredClone(this.vars); // 创建副本
  }

  private validate() {
    const config = process.env;
    const validatedConfig = plainToInstance(this.EnvsClass, config, {
      enableImplicitConversion: true,
    });

    if (process.env.NODE_ENV !== NODE_ENV.Test) {
      const errors = validateSync(validatedConfig, {
        skipMissingProperties: false,
      });

      if (errors.length > 0) {
        this.logger.warning`${`[${this.sys ? 'SYS' : 'App'}] Configure these configs are not valid`}`;
        const errorDetails = errors.map((e) => {
          const value = e.value === undefined ? '<undefined>' : e.value === '' ? '<empty>' : JSON.stringify(e.value);
          const constraints = e.constraints ? Object.values(e.constraints).join('; ') : 'unknown error';
          return `${e.property}=${value} — ${constraints}`;
        });
        for (const detail of errorDetails) {
          this.logger.error`${detail}`;
        }
        throw new Error(errors.map((e) => e.property).join(', '));
      }

      // 配置项输出：启动时固定打印，source 标注来源（host/文件路径/default）
      const src = (key: string) => this.envSourceMap.get(key) ?? 'default';

      if (this.sys) {
        Object.entries(validatedConfig as object).forEach(([key, value]) => {
          if (
            key.includes('_ENABLE') ||
            key.startsWith('APP_') ||
            !AbstractEnvironmentVariables.allFields.includes(key) ||
            ['logger'].includes(key)
          )
            return;
          const isDatabaseField = Reflect.getMetadata(DatabaseFieldSymbol, AbstractEnvironmentVariables.prototype, key);
          const display = AppConfigure.isSensitive(key) ? '***' : value;
          this.logger.info`[SYS] ${isDatabaseField ? '<- DB -> ' : ''}[${src(key)}] ${{ key, value: display }}`;
        });
      }

      Object.entries(validatedConfig as object).forEach(([key, value]) => {
        if (!this.sys && !Object.getOwnPropertyNames(AbstractEnvironmentVariables.prototype).includes(key)) return;
        const isDatabaseField = Reflect.getMetadata(DatabaseFieldSymbol, AbstractEnvironmentVariables.prototype, key);
        if (key.includes('_ENABLE')) {
          const display = AppConfigure.isSensitive(key) ? '***' : value;
          this.logger
            .info`[${this.sys ? 'SYS' : 'App'}] ${isDatabaseField ? '<- DB -> ' : ''}[${src(key)}] ${{ key, value: display }}`;
        }
      });
      Object.entries(validatedConfig as object).forEach(([key, value]) => {
        if (!this.sys && !Object.getOwnPropertyNames(AbstractEnvironmentVariables.prototype).includes(key)) return;
        const isDatabaseField = Reflect.getMetadata(DatabaseFieldSymbol, AbstractEnvironmentVariables.prototype, key);
        if (key.startsWith('APP_')) {
          const display = AppConfigure.isSensitive(key) ? '***' : value;
          this.logger
            .info`[${this.sys ? 'SYS' : 'App'}] ${isDatabaseField ? '<- DB -> ' : ''}[${src(key)}] ${{ key, value: display }}`;
        }
      });
    }
    configureLogger.debug`[${this.sys ? 'SYS' : 'App'}] Configure validated`;
    return validatedConfig;
  }

  /**
   * 同步配置到数据库
   *
   * 无数据库项目使用 createNoDBConfigure() 创建实例，sync() 会自动跳过
   */
  async sync(prisma: ISysAppSettingClient) {
    if (this.options.noDB) {
      this.logger.debug`${'#sync skipped (noDB mode)'}`;
      return;
    }
    await AppConfigure.syncFromDB(prisma, this.originalVars, this.vars, { scope: this.options.scope });
  }

  static async syncFromDB<T extends object>(
    prisma: ISysAppSettingClient,
    originalEnvs: T,
    activeEnvs: T,
    options?: { scope?: string },
  ) {
    // 注意：使用 activeEnvs 来查找装饰器元数据
    // 原因：originalEnvs 是通过 structuredClone 创建的普通对象，丢失了类原型链
    // 而 activeEnvs 是通过 plainToInstance 创建的类实例，保留了原型链和装饰器元数据
    const projectScope = options?.scope;
    const SHARED = 'shared';

    const envClass = (activeEnvs as { constructor: new () => T }).constructor;
    const validateDbValue = (
      field: string,
      rawValue: unknown,
    ): { ok: true; value: unknown } | { ok: false; reason: string } => {
      try {
        const candidate = plainToInstance(
          envClass,
          { [field]: rawValue },
          {
            enableImplicitConversion: true,
          },
        ) as Record<string, unknown>;
        const fieldErrors = validateSync(candidate as object, {
          skipMissingProperties: true,
        }).filter((error) => error.property === field);

        if (fieldErrors.length > 0) {
          const reason = fieldErrors
            .map((error) => (error.constraints ? Object.values(error.constraints).join('; ') : 'unknown error'))
            .join('; ');
          return { ok: false, reason };
        }

        return { ok: true, value: candidate[field] };
      } catch (error: unknown) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    };

    const fields = Object.getOwnPropertyNames(originalEnvs)
      .map((field) => {
        const isDatabaseField = Reflect.getMetadata(DatabaseFieldSymbol, activeEnvs, field);
        const format = Reflect.getMetadata(DatabaseFieldFormatSymbol, activeEnvs, field);
        const description = Reflect.getMetadata(DatabaseFieldDescriptionSymbol, activeEnvs, field);
        const isScoped = Reflect.getMetadata(DatabaseFieldScopedSymbol, activeEnvs, field) === true;

        return {
          field,
          isDatabaseField,
          isScoped,
          format,
          description,
          defaultValue: (originalEnvs as Record<string, unknown>)[field],
          value: (activeEnvs as Record<string, unknown>)[field],
        };
      })
      .filter(({ isDatabaseField }) => !!isDatabaseField);

    /** 决定字段的写入 scope：scoped 字段写项目 scope，否则写 shared。无 projectScope 时 fallback 到 shared */
    const scopedWithoutProject: string[] = [];
    const resolveWriteScope = (field: string, isScoped: boolean): string => {
      if (isScoped && projectScope) return projectScope;
      if (isScoped && !projectScope) {
        scopedWithoutProject.push(field);
      }
      return SHARED;
    };

    const sharedFields = fields.filter((f) => !f.isScoped);
    const scopedFields = fields.filter((f) => f.isScoped);

    // 有 projectScope 就能写 — scope 隔离 + createdBy 归属保障安全
    const writeEnabled = !!projectScope;
    const syncMode = writeEnabled ? 'read-write' : 'read-only';
    const managedFieldNames = fields.map((f) => f.field).sort((a, b) => a.localeCompare(b));

    const logger = getAppLogger('AppConfigure');

    logger.debug`#syncFromDB... reload app settings from db.`;
    logger.debug`${`#syncFromDB mode=${syncMode} scope=${projectScope ?? '(none)'}`}`;
    logger.debug`#syncFromDB managed keys (${managedFieldNames.length}): ${managedFieldNames.join(', ') || '(none)'}`;

    // 拉取相关 scope 的行：shared + 项目 scope（如有）
    const scopesToRead = projectScope ? [SHARED, projectScope] : [SHARED];
    const appSettings = (await prisma.sysAppSetting.findMany({ where: { scope: { in: scopesToRead } } })).map(
      ({ value, format, ...rest }) => ({
        ...rest,
        value: format !== 'string' && value != null ? JSON.parse(value) : value,
        format,
      }),
    ) as Array<{
      key: string;
      scope: string;
      defaultValue: unknown;
      format: string;
      description?: string;
      value: unknown;
      deprecatedAt?: Date | null;
      createdBy?: string | null;
    }>;

    const stats = {
      runtimeOverridesApplied: 0,
      runtimeOverridesUnchanged: 0,
      runtimeMissingDBValue: 0,
      runtimeInvalidDBValue: 0,
      metadataDeprecatedMarked: 0,
      metadataRestored: 0,
      metadataCreated: 0,
      metadataUpdated: 0,
      metadataUpdateFailed: 0,
    };

    if (writeEnabled) {
      // =====================================================
      // Orphan 检测：按 scope 隔离，只标记自己管理的行
      // =====================================================

      // 1. shared scope: 只看 shared 行 vs sharedFields
      const sharedFieldNames = new Set(sharedFields.map((f) => f.field));
      const sharedRows = appSettings.filter((s) => s.scope === SHARED);
      const sharedOrphans = sharedRows.filter(
        (s) => !sharedFieldNames.has(s.key) && !s.deprecatedAt && s.createdBy === projectScope,
      );
      if (sharedOrphans.length > 0) {
        stats.metadataDeprecatedMarked += sharedOrphans.length;
        logger.info`#syncFromDB 标记 ${sharedOrphans.length} 个废弃配置 (shared): ${sharedOrphans.map((s) => s.key).join(', ')}`;
        await prisma.sysAppSetting.updateMany({
          where: { key: { in: sharedOrphans.map((s) => s.key) }, scope: SHARED },
          data: { deprecatedAt: new Date() },
        });
      }

      // 2. project scope: 只看项目行 vs scopedFields
      if (projectScope) {
        const scopedFieldNames = new Set(scopedFields.map((f) => f.field));
        const projectRows = appSettings.filter((s) => s.scope === projectScope);
        const projectOrphans = projectRows.filter((s) => !scopedFieldNames.has(s.key) && !s.deprecatedAt);
        if (projectOrphans.length > 0) {
          stats.metadataDeprecatedMarked += projectOrphans.length;
          logger.info`#syncFromDB 标记 ${projectOrphans.length} 个废弃配置 (${projectScope}): ${projectOrphans.map((s) => s.key).join(', ')}`;
          await prisma.sysAppSetting.updateMany({
            where: { key: { in: projectOrphans.map((s) => s.key) }, scope: projectScope },
            data: { deprecatedAt: new Date() },
          });
        }
      }

      // 恢复：被重新添加到代码中的配置（分 scope 检查）
      const allFieldNames = new Set(fields.map((f) => f.field));
      const restoredSettings = appSettings.filter((s) => allFieldNames.has(s.key) && Boolean(s.deprecatedAt));
      if (restoredSettings.length > 0) {
        stats.metadataRestored += restoredSettings.length;
        logger.info`#syncFromDB 恢复 ${restoredSettings.length} 个配置: ${restoredSettings.map((s) => s.key).join(', ')}`;
        await prisma.sysAppSetting.updateMany({
          where: { key: { in: restoredSettings.map((s) => s.key) } },
          data: { deprecatedAt: null },
        });
      }

      // 创建不存在的配置字段
      const nonExistsFields = fields.filter(({ field, isScoped }) => {
        const writeScope = resolveWriteScope(field, isScoped);
        return !appSettings.some((s) => s.key === field && s.scope === writeScope);
      });
      if (nonExistsFields.length > 0) {
        stats.metadataCreated += nonExistsFields.length;
        logger.info`#syncFromDB 创建 ${nonExistsFields.length} 个新配置字段...`;
        await prisma.sysAppSetting.createMany({
          data: nonExistsFields.map(({ field, format, description, defaultValue, isScoped }) => {
            const defaultVal =
              defaultValue !== undefined
                ? typeof defaultValue === 'string'
                  ? defaultValue
                  : JSON.stringify(defaultValue)
                : null;

            const scope = resolveWriteScope(field, isScoped);
            logger.info`#syncFromDB 创建配置: ${field} scope=${scope} (默认值: ${defaultVal})`;
            return {
              key: field,
              scope,
              value: null,
              defaultValue: defaultVal,
              format: format as string,
              description: description as string | null,
              createdBy: projectScope,
            };
          }),
          skipDuplicates: true,
        });
      }
    }

    // 读取 DB value 覆盖 runtime：resolve scoped > shared > code default
    for (const { field, value, defaultValue, description, format, isScoped } of fields) {
      const writeScope = resolveWriteScope(field, isScoped);

      // scoped 字段优先读项目行，fallback 到 shared
      const scopedRow = projectScope ? appSettings.find((s) => s.key === field && s.scope === projectScope) : undefined;
      const sharedRow = appSettings.find((s) => s.key === field && s.scope === SHARED);
      const effectiveRow = isScoped ? (scopedRow ?? sharedRow) : sharedRow;

      if (!effectiveRow) {
        stats.runtimeMissingDBValue += 1;
        continue;
      }

      // 更新环境变量值
      if (effectiveRow.value != null) {
        const validation = validateDbValue(field, effectiveRow.value);
        if (!validation.ok) {
          stats.runtimeInvalidDBValue += 1;
          logger.warning`#syncFromDB skip invalid DB value ${{ field, value: effectiveRow.value, reason: validation.reason }}`;
        } else if (!_.isEqual(value, validation.value)) {
          stats.runtimeOverridesApplied += 1;
          logger.info`#syncFromDB 配置覆盖: ${field} = "${value}" -> "${validation.value}" (scope=${effectiveRow.scope})`;
          (activeEnvs as Record<string, unknown>)[field] = validation.value;
        } else {
          stats.runtimeOverridesUnchanged += 1;
        }
      } else {
        stats.runtimeMissingDBValue += 1;
      }

      if (!writeEnabled) {
        continue;
      }

      // 检查并更新默认值和描述（写入该字段的 writeScope）
      const metaRow = appSettings.find((s) => s.key === field && s.scope === writeScope);
      if (!metaRow) continue;

      const updates: { defaultValue?: string; description?: string } = {};
      const valueToStore =
        defaultValue !== undefined
          ? typeof defaultValue === 'string'
            ? defaultValue
            : JSON.stringify(defaultValue)
          : null;

      if (metaRow.defaultValue !== valueToStore && valueToStore !== null) {
        updates.defaultValue = valueToStore;
      }
      if (description && description !== metaRow.description) {
        updates.description = description;
      }

      if (!_.isEmpty(updates)) {
        stats.metadataUpdated += 1;
        logger.info`#syncFromDB 更新元数据: ${field} scope=${writeScope} ${updates}`;
        try {
          const existingRecord = await prisma.sysAppSetting.findUnique({
            where: { scope_key: { scope: writeScope, key: field } },
          });

          if (!existingRecord) {
            logger.warning`#syncFromDB record not found for update: ${field} scope=${writeScope}`;
            await prisma.sysAppSetting.create({
              data: {
                key: field,
                scope: writeScope,
                value: null,
                defaultValue: updates.defaultValue ?? null,
                format: format as string,
                description: updates.description ?? null,
              },
            });
            logger.info`#syncFromDB created record for ${field} scope=${writeScope}`;
          } else {
            await prisma.sysAppSetting.update({
              where: { scope_key: { scope: writeScope, key: field } },
              data: updates,
            });
            logger.info`#syncFromDB updated metadata for ${field} scope=${writeScope}`;
          }
        } catch (error: unknown) {
          stats.metadataUpdateFailed += 1;
          logger.error`#syncFromDB failed to update metadata for ${field}: ${error instanceof Error ? error.message : String(error)} ${errorStack(error) ?? ''}`;
        }
      }
    }

    if (scopedWithoutProject.length > 0) {
      logger.warning`#syncFromDB scoped fields used without project scope, falling back to "${SHARED}": ${scopedWithoutProject.join(', ')}`;
    }

    logger.info`#syncFromDB summary mode=${syncMode} scope=${projectScope ?? SHARED} managed=${fields.length} dbRows=${appSettings.length} applied=${stats.runtimeOverridesApplied} unchanged=${stats.runtimeOverridesUnchanged} missingDbValue=${stats.runtimeMissingDBValue} invalidDbValue=${stats.runtimeInvalidDBValue} deprecated=${stats.metadataDeprecatedMarked} restored=${stats.metadataRestored} created=${stats.metadataCreated} metadataUpdated=${stats.metadataUpdated} metadataUpdateFailed=${stats.metadataUpdateFailed}`;
  }
}

/**
 * 创建无数据库模式的 AppConfigure
 *
 * 适用于纯 gRPC 服务、CLI 工具等无数据库连接的项目。
 * sync() 方法会自动跳过，仅保留环境变量加载和验证能力。
 *
 * @example
 * ```typescript
 * import { AbstractEnvironmentVariables, createNoDBConfigure } from '@app/env';
 *
 * class EnvironmentVariables extends AbstractEnvironmentVariables {
 *   @IsString() @IsOptional() override DATABASE_URL?: string; // 覆盖为可选
 *   @IsString() @IsOptional() WEATHER_API_KEY?: string;
 * }
 *
 * export const AppEnvs = createNoDBConfigure(EnvironmentVariables).vars;
 * ```
 */
export function createNoDBConfigure<T extends AbstractEnvironmentVariables>(EnvsClass: new () => T): AppConfigure<T> {
  return new AppConfigure(EnvsClass, { noDB: true });
}

export const SysEnv = new AppConfigure(AbstractEnvironmentVariables).vars;
