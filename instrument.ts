/**
 * OpenTelemetry + LogTape Instrumentation (preload)
 *
 * 共享的初始化脚本，放在 nestjs-libs 中统一管理。
 *
 * 使用方式：
 *   bun --preload ./libs/instrument.ts src/main.ts
 *
 * 功能：
 * - LogTape 日志初始化（必须在所有模块 import 前完成）
 * - gRPC 请求自动 tracing + traceparent 传播
 * - 可选：Langfuse span 导出（AI 相关 span）
 * - 可选：通用 OTLP HTTP exporter 推 trace 到 Tempo/Jaeger/Datadog 等任意 OTLP 后端
 * - 可选：Sentry 错误追踪 + OTel 接管
 *
 * OTel 策略（二选一，由 SENTRY_DSN 决定）：
 * - Sentry 模式（SENTRY_DSN 已设置）：Sentry 接管 OTel（TracerProvider/ContextManager/Propagator/Sampler），
 *   Langfuse 作为额外 SpanProcessor 挂载，HTTP tracing 由 Sentry httpIntegration 处理
 * - Dev 模式（SENTRY_DSN 未设置）：最小化 NodeSDK，仅生成 traceId，
 *   HTTP tracing 由 bootstrap.ts 中的 otelTraceMiddleware 处理
 *
 * gRPC Trace 传播机制：
 * - 客户端通过 gRPC metadata 传递 traceparent header
 * - 格式：00-{traceId}-{spanId}-{flags}（W3C Trace Context 标准）
 * - GrpcInstrumentation 自动解析并创建 span
 * - 服务端通过 trace.getSpan(context.active()) 获取当前 span
 *
 * 环境变量：
 * - OTEL_LOG_LEVEL: OpenTelemetry 日志级别（设为 NONE 禁用）
 * - LANGFUSE_ENABLED: 启用 Langfuse（需要 @langfuse/otel）
 * - LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL: Langfuse 配置
 * - LANGFUSE_EXPORT_FULL_STACK: opt-in 'true' 让 grpc / http / prisma scope 的 span
 *     也导出到 Langfuse（默认仅 scope='ai'）。用于全栈 trace 关联 / RCA 场景。
 *     注意: prisma scope 由 caller 自己创 (manual `trace.getTracer('prisma')` 或
 *     `@opentelemetry/instrumentation-prisma`)，此文件不自动注册 Prisma instrumentation。
 *     http scope 依赖 APP_OTEL_HTTP_INSTRUMENTATION_ENABLED 同时打开 — 只设
 *     LANGFUSE_EXPORT_FULL_STACK 而不开 HTTP instrumentation 会启动时 warn 提示。
 * - APP_OTEL_HTTP_INSTRUMENTATION_ENABLED: opt-in 'true' 注册
 *     @opentelemetry/instrumentation-http (按需安装) 让 inbound/outbound HTTP 请求
 *     自动创建 span。默认不开（避免额外 per-request overhead + span 量上涨）。
 *     注意: span name 保持 OTel semconv 默认（method-only，如 "GET" / "POST"）。
 *     路由信息在 `http.target` / `url.path` 属性里，按属性聚合即可；需要路由模板
 *     (`GET /users/:id`) 的应用应注册框架层 instrumentation（NestJS / Express），
 *     由它在路由匹配后填 `http.route` 并 enrich span name。
 * - OTEL_EXPORTER_OTLP_ENDPOINT: opt-in OTLP HTTP 推送地址 (e.g. http://tempo:4318/v1/traces)
 *     需安装 @opentelemetry/exporter-trace-otlp-http. 跟 Langfuse 并行挂 SpanProcessor,
 *     同一份 span 多路导出. 设此 env 即开启, 不设则跳过.
 * - OTEL_EXPORTER_OTLP_HEADERS: 可选 OTLP headers 鉴权, 标准 OTel env 格式
 *     (key1=value1,key2=value2). 自托管 Tempo 内网通常不需要.
 * - SENTRY_DSN: Sentry DSN（启用 Sentry 接管 OTel + 错误追踪）
 *
 * 注意事项：
 * - 必须在 NestJS 启动前加载（使用 --preload）
 * - 使用 connectMicroservice 时需要 { inheritAppConfig: true } 使全局 interceptors 生效
 */

// ==================== Env Loading ====================
// 必须最先执行：加载 .env 文件到 process.env
// 在所有 Schema.Config / getLogger 之前
import { configureLogging } from '@app/nest/logging';

import { isFullStackExtraScope } from './instrument-helpers';

import { config as dotenvConfig } from '@dotenvx/dotenvx';
import { getLogger } from '@logtape/logtape';
import { diag } from '@opentelemetry/api';
import { getStringFromEnv } from '@opentelemetry/core';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';

import type { SpanExporter } from '@opentelemetry/sdk-trace-base';

dotenvConfig({ path: '.env.local', override: false, ignore: ['MISSING_ENV_FILE'] });
dotenvConfig({ path: '.env', override: false, ignore: ['MISSING_ENV_FILE'] });

// ==================== LogTape ====================
// 必须在所有应用模块 import 前完成，确保模块顶层代码（如 env validation）的日志可见
await configureLogging();

// ==================== Suppress noisy warnings ====================
const originalEmit = process.emit.bind(process);
process.emit = ((event: string, ...args: unknown[]) => {
  if (event === 'warning') {
    const warning = args[0] as { name?: string } | undefined;
    if (warning?.name === 'DeprecationWarning' || warning?.name === 'TimeoutNegativeWarning') {
      return false;
    }
  }
  return originalEmit.apply(process, [event, ...args] as Parameters<typeof originalEmit>);
}) as typeof process.emit;

// ==================== Optional dependencies ====================
// require() + try/catch 是可选依赖的正确模式：包可能未安装，import() 会报类型错误
let GrpcInstrumentation: (new () => unknown) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional dependency
  GrpcInstrumentation = require('@opentelemetry/instrumentation-grpc').GrpcInstrumentation;
} catch {
  // gRPC instrumentation not installed, skip
}

let HttpInstrumentation: (new (opts?: unknown) => unknown) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional dependency
  HttpInstrumentation = require('@opentelemetry/instrumentation-http').HttpInstrumentation;
} catch {
  // HTTP instrumentation not installed, skip
}

let LangfuseSpanProcessor: (new (opts: unknown) => unknown) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional dependency
  LangfuseSpanProcessor = require('@langfuse/otel').LangfuseSpanProcessor;
} catch {
  // Langfuse not installed, skip
}

let OTLPTraceExporter: (new (opts?: unknown) => SpanExporter) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional dependency
  OTLPTraceExporter = require('@opentelemetry/exporter-trace-otlp-http').OTLPTraceExporter;
} catch {
  // OTLP HTTP exporter not installed, skip
}

let BatchSpanProcessor: (new (exporter: SpanExporter) => unknown) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- bundled with sdk-trace-node
  BatchSpanProcessor = require('@opentelemetry/sdk-trace-node').BatchSpanProcessor;
} catch {
  // shouldn't happen — sdk-trace-node already imported above
}

// ==================== Loggers ====================
const otelLogger = getLogger(['instrument', 'OpenTelemetry']);
const langfuseLogger = getLogger(['instrument', 'Langfuse']);
const sentryLogger = getLogger(['instrument', 'Sentry']);

// ==================== Helpers ====================

/**
 * Minimal exporter for development
 * Creates spans for traceId generation but produces no output
 */
class MinimalSpanExporter implements SpanExporter {
  export(_spans: unknown[], resultCallback: (result: { code: number }) => void) {
    resultCallback({ code: 0 });
  }
  shutdown() {
    return Promise.resolve();
  }
}

function configureDiagLogLevel() {
  const logLevel = getStringFromEnv('OTEL_LOG_LEVEL');
  if (logLevel?.toUpperCase() === 'NONE') {
    if (typeof diag.disable === 'function') {
      diag.disable();
    }
  }
}

function createLangfuseProcessor(): unknown | null {
  const enabled = getStringFromEnv('LANGFUSE_ENABLED');
  if (enabled !== 'true') return null;
  if (!LangfuseSpanProcessor) {
    langfuseLogger.warning`${'@langfuse/otel not available'}`;
    return null;
  }

  const publicKey = getStringFromEnv('LANGFUSE_PUBLIC_KEY');
  const secretKey = getStringFromEnv('LANGFUSE_SECRET_KEY');
  const baseUrl = getStringFromEnv('LANGFUSE_BASE_URL') ?? getStringFromEnv('LANGFUSE_BASEURL');
  if (!publicKey || !secretKey || !baseUrl) {
    langfuseLogger.warning`${'missing credentials'}`;
    return null;
  }

  const environmentTag = getStringFromEnv('LANGFUSE_TRACING_ENVIRONMENT') ?? process.env.NODE_ENV ?? 'dev';
  const fullStack = getStringFromEnv('LANGFUSE_EXPORT_FULL_STACK') === 'true';
  langfuseLogger.info`${`enabled host=${baseUrl} env=${environmentTag} fullStack=${fullStack}`}`;

  // Default: only export scope='ai' spans (LLM / Vercel AI SDK telemetry).
  // Opt-in LANGFUSE_EXPORT_FULL_STACK=true also exports gRPC client + HTTP +
  // Prisma spans so cross-service traces show the full request path in Langfuse.
  const shouldExportSpan = ({ otelSpan }: { otelSpan: Record<string, unknown> }) => {
    const span = otelSpan as {
      instrumentationScope?: { name?: string };
      name?: string;
      attributes?: Record<string, unknown>;
      spanContext?: () => { traceId?: string };
      _spanContext?: { traceId?: string };
    };
    const scope = typeof span.instrumentationScope?.name === 'string' ? span.instrumentationScope.name : '';
    const spanName = span.name ?? 'unknown';
    const traceId = span.spanContext?.()?.traceId ?? span._spanContext?.traceId ?? ''; // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- runtime shape varies
    const shouldExport = scope === 'ai' || (fullStack && isFullStackExtraScope(scope));
    if (shouldExport) {
      const hasTraceInput = !!span.attributes?.['langfuse.trace.input'];
      const hasTraceName = !!span.attributes?.['langfuse.trace.name'];
      langfuseLogger.debug`${`[${traceId}] export scope=${scope} span=${spanName} hasTraceInput=${hasTraceInput} hasTraceName=${hasTraceName}`}`;
    }
    return shouldExport;
  };

  return new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl, shouldExportSpan });
}

/**
 * Generic OTLP HTTP exporter — 推 trace 到任意 OTLP 后端 (Tempo / Jaeger / Datadog / etc).
 *
 * 启用: 设 `OTEL_EXPORTER_OTLP_ENDPOINT` (OpenTelemetry SDK 标准 env, 不加前缀).
 * 例: `http://192.168.2.118:4318/v1/traces`
 *
 * 鉴权 (可选): `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer xxx,X-Scope-OrgID=1`
 * (逗号分隔的 key=value pairs)
 *
 * 实现: BatchSpanProcessor + OTLP HTTP exporter — 跟 Langfuse processor 并行挂上,
 * 同一份 span 一份给 Langfuse (AI scope filter), 一份给 OTLP backend (全栈).
 *
 * MIS-423 Sprint 1 — 让 staging trace 进自托管 Tempo, 跟 Loki/Prometheus stack 关联.
 */
function createOtlpProcessor(): unknown | null {
  const endpoint = getStringFromEnv('OTEL_EXPORTER_OTLP_ENDPOINT');
  if (!endpoint) return null;
  if (!OTLPTraceExporter || !BatchSpanProcessor) {
    otelLogger.warning`${`OTEL_EXPORTER_OTLP_ENDPOINT set (${endpoint}) but @opentelemetry/exporter-trace-otlp-http not installed`}`;
    return null;
  }

  // Standard OTEL_EXPORTER_OTLP_HEADERS env: comma-separated key=value pairs.
  // SDK 默认自己解析这个 env (passing undefined headers 等于让 SDK 读 env). 但显式
  // 解析后 logger 看得更清楚, 也便于将来加自定义 headers.
  const headersEnv = getStringFromEnv('OTEL_EXPORTER_OTLP_HEADERS');
  const headers: Record<string, string> = {};
  if (headersEnv) {
    for (const pair of headersEnv.split(',')) {
      const idx = pair.indexOf('=');
      if (idx > 0) {
        headers[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
      }
    }
  }

  otelLogger.info`${`OTLP exporter enabled endpoint=${endpoint} headers=${Object.keys(headers).length}`}`;
  const exporter = new OTLPTraceExporter({ url: endpoint, headers });
  return new BatchSpanProcessor(exporter);
}

// ==================== Sentry 错误追踪（独立于 OTel） ====================

const noisyPatterns = [
  /MISSING_ENV_FILE/i,
  /injecting env/i,
  /#shutdownTracing/,
  /TimeoutNegativeWarning/,
  /DeprecationWarning/,
  /^[DI] \d{4}-\d{2}-\d{2}T.+\| v\d+\.\d+\.\d+ \d+ \|/, // @grpc/grpc-js debug/info logs written to stderr
];

/**
 * Sentry 仅负责错误追踪，不接管 OTel。
 *
 * 之前 Sentry 接管 OTel（TracerProvider/Sampler），导致 tracesSampler 的采样率（prod 5%）
 * 同时影响 Langfuse——95% 的 span 在创建时就被丢弃，Langfuse 收不到 trace 元数据。
 * 现在 Sentry 和 OTel/Langfuse 彻底分离，各管各的。
 */
function bootstrapSentry() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional dependency, import() exposes strict type mismatch
    const Sentry = require('@sentry/nestjs');
    const dsn = process.env.SENTRY_DSN;
    const release = process.env.SENTRY_RELEASE ?? process.env.RENDER_GIT_COMMIT ?? process.env.GITHUB_SHA;
    const environment = process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV;
    const serverName = process.env.APP_NAME ?? process.env.SENTRY_SERVER_NAME ?? process.env.SERVICE_NAME;

    Sentry.init({
      dsn,
      sendDefaultPii: true,
      release,
      environment,
      serverName,
      // Sentry 不接管 OTel：TracerProvider/ContextManager/Propagator 由独立 NodeSDK 管理
      skipOpenTelemetrySetup: true,
      // 不做 performance monitoring，只做错误追踪
      tracesSampleRate: 0,
      beforeSend(event: {
        message?: string;
        logentry?: { formatted?: string; message?: string };
        exception?: { values?: Array<{ type?: string; value?: string }> };
      }) {
        const message = event.message ?? event.logentry?.formatted ?? event.logentry?.message;
        const exceptionValues = event.exception?.values ?? [];
        const exceptionTexts = exceptionValues.map((v) => [v.type, v.value].filter(Boolean).join(':')).filter(Boolean);

        const haystack = [message, ...exceptionTexts].filter(Boolean).join('\n');
        if (haystack && noisyPatterns.some((pattern) => pattern.test(haystack))) {
          return null;
        }
        return event;
      },
      // Bun 未实现 util.getSystemErrorMap()，导致 @sentry/node-core 的 SystemError integration 崩溃
      // see: https://github.com/oven-sh/bun/issues/22872
      integrations: (defaults: Array<{ name: string }>) => defaults.filter((i) => i.name !== 'NodeSystemError'),
    });

    sentryLogger.info`${`enabled (errors only) server=${serverName ?? 'unknown'} env=${environment}`}`;
  } catch (error) {
    sentryLogger.error`${`init failed: ${error instanceof Error ? error.message : String(error)}`}`;
  }
}

// ==================== OTel：独立 NodeSDK（Langfuse + gRPC） ====================

/**
 * 独立的 OTel pipeline，不受 Sentry 采样率影响。
 * 所有 span 100% recording → shouldExportSpan 只导出 scope='ai' 给 Langfuse。
 */
function bootstrapOtel(langfuseProcessor: unknown | null, otlpProcessor: unknown | null) {
  const spanProcessors: unknown[] = [];
  if (langfuseProcessor) spanProcessors.push(langfuseProcessor);
  if (otlpProcessor) spanProcessors.push(otlpProcessor);
  if (spanProcessors.length === 0) {
    otelLogger.debug`${'no processors, using minimal exporter'}`;
    spanProcessors.push(new SimpleSpanProcessor(new MinimalSpanExporter()));
  }

  // HTTP instrumentation is opt-in via APP_OTEL_HTTP_INSTRUMENTATION_ENABLED=true.
  // Adds measurable per-request overhead + a non-trivial span volume — default off
  // preserves the historical behavior. Apps that want full http→grpc→llm trace
  // correlation (typical RCA / observability use case) opt in.
  //
  // Env name uses APP_ prefix to avoid the OTEL_* namespace reserved by the
  // OpenTelemetry SDK spec (future spec additions could otherwise silently collide).
  const httpInstrumentationEnabled = getStringFromEnv('APP_OTEL_HTTP_INSTRUMENTATION_ENABLED') === 'true';

  // Coupling guard: LANGFUSE_EXPORT_FULL_STACK=true expects HTTP scope spans to
  // exist; if HTTP instrumentation isn't enabled, the http allowlist entry is
  // dead and Langfuse won't show the http layer of the trace. Warn explicitly so
  // operators don't think full-stack export is broken.
  if (langfuseProcessor) {
    const fullStackOn = getStringFromEnv('LANGFUSE_EXPORT_FULL_STACK') === 'true';
    if (fullStackOn && !httpInstrumentationEnabled) {
      otelLogger.warning`${'LANGFUSE_EXPORT_FULL_STACK=true but HTTP instrumentation is off — no spans from @opentelemetry/instrumentation-http will be created or exported. Set APP_OTEL_HTTP_INSTRUMENTATION_ENABLED=true to enable.'}`;
    }
  }

  const instrumentations: unknown[] = [];
  if (GrpcInstrumentation) instrumentations.push(new GrpcInstrumentation());
  if (httpInstrumentationEnabled && HttpInstrumentation) {
    // Span name stays at OTel semconv default ("GET" / "POST" / ...) — method only.
    //
    // Why not enrich with the path here:
    // - HTTP instrumentation has no router context (Express/Nest haven't matched
    //   the route yet when this fires). Any path embedded in span name is either
    //   the raw URL (cardinality bomb: `/users/123` / `/users/456` / …) or a
    //   regex-sanitized approximation (false positives on slugs, false negatives
    //   on unfamiliar ID formats).
    // - OTel semantic conventions say span name should be `{method} {http.route}`
    //   where `http.route` is the route template — that's the **framework
    //   instrumentation's** job (e.g. `@opentelemetry/instrumentation-nestjs-core`),
    //   not the HTTP layer's.
    // - Path / target is still available on the span via standard attributes
    //   (`http.target`, `url.path`, eventually `http.route`). Dashboards group
    //   by attribute when they need per-route p99.
    //
    // Apps that want span name like `GET /users/:id` should install framework
    // instrumentation that resolves the route template and enriches the span.
    instrumentations.push(new HttpInstrumentation());
  } else if (httpInstrumentationEnabled && !HttpInstrumentation) {
    otelLogger.warning`${'APP_OTEL_HTTP_INSTRUMENTATION_ENABLED=true but @opentelemetry/instrumentation-http not installed'}`;
  }

  const sdk = new NodeSDK({
    spanProcessors: spanProcessors as never[],
    instrumentations: instrumentations as never[],
    autoDetectResources: false,
    resourceDetectors: [],
  });

  try {
    sdk.start();
    const httpLabel = httpInstrumentationEnabled && HttpInstrumentation ? ' + HTTP' : '';
    const otlpLabel = otlpProcessor ? ' + OTLP' : '';
    otelLogger.info`${`started${GrpcInstrumentation ? ' + gRPC' : ''}${httpLabel}${langfuseProcessor ? ' + Langfuse' : ''}${otlpLabel}`}`;
  } catch (error) {
    otelLogger.error`${`failed: ${error instanceof Error ? error.message : String(error)}`}`;
    return;
  }

  const shutdown = async () => {
    try {
      await sdk.shutdown();
      otelLogger.debug`${'shutdown complete'}`;
    } catch (error) {
      otelLogger.error`${`shutdown failed: ${error instanceof Error ? error.message : String(error)}`}`;
    }
  };

  process.once('SIGTERM', () => void shutdown());
  process.once('beforeExit', () => void shutdown());

  // CLI 需要在 process.exit() 前调用此方法确保 spans 发送到 Langfuse
  (globalThis as Record<string, unknown>).__otelFlush = shutdown;
}

// ==================== Bootstrap ====================

function bootstrapTracing() {
  configureDiagLogLevel();

  // Sentry：仅错误追踪，不接管 OTel
  if (process.env.SENTRY_DSN) {
    bootstrapSentry();
  } else {
    sentryLogger.debug`${'skipped (SENTRY_DSN not set)'}`;
  }

  // OTel：独立 pipeline. Langfuse / OTLP backend (Tempo/Jaeger/etc) 各自挂自己的
  // SpanProcessor — 同一份 span 多路导出.
  const langfuseProcessor = createLangfuseProcessor();
  const otlpProcessor = createOtlpProcessor();
  bootstrapOtel(langfuseProcessor, otlpProcessor);
}

bootstrapTracing();
