import { GqlExecutionContext } from '@nestjs/graphql';

import { RequestContext } from '@app/nest/trace/request-context';
import { getAppLogger } from '@app/utils/app-logger';

import { context, trace } from '@opentelemetry/api';
import * as _ from 'radash';
import { catchError, finalize } from 'rxjs';

import type { IdentityRequest } from '../types/identity.interface';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import type { Observable } from 'rxjs';

/**
 * 判断是否是 BusinessException（IOopsException + httpStatus < 500）。
 *
 * 设计选择：基于 httpStatus property 而非调 isFatal() method。
 * - Oops 契约：BusinessException httpStatus < 500，FatalException ≥ 500
 * - 不调 method 避免 logging 路径触发外部对象副作用（neverthrow 哲学：
 *   日志/错误处理是横切关注点，不应承担"可能失败"的语义）
 *
 * @internal exported for testing
 */
export function isOopsBusinessException(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'httpStatus' in error &&
    typeof error.httpStatus === 'number' &&
    (error as { httpStatus: number }).httpStatus < 500
  );
}

export class LoggerInterceptor implements NestInterceptor {
  private readonly logger = getAppLogger('LoggerInterceptor');

  public intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> | Promise<Observable<unknown>> {
    // 注意：Subscription 必须直接返回原始结果，任何额外的 pipe 都会把 AsyncIterator 变成 Observable，
    // 导致 graphql-transport-ws 收到 {} 而不是流式数据。
    // NestJS switchToHttp() 在 GraphQL 场景返回空对象，类型声明为可空
    let req: IdentityRequest | undefined = ctx.switchToHttp().getRequest<IdentityRequest | undefined>();

    const isGraphql = ctx.getType<'http' | 'graphql'>() === 'graphql';
    const gqlExecutionContext = isGraphql ? GqlExecutionContext.create(ctx) : null;
    const gqlOperation = gqlExecutionContext?.getInfo()?.operation?.operation ?? null;

    // NestJS GraphQL 请求时 switchToHttp().getRequest() 返回空对象，需要从 GqlContext 获取

    if (!req && gqlExecutionContext) {
      const gqlContext = gqlExecutionContext.getContext<Record<string, unknown>>();
      req = gqlContext.req as IdentityRequest | undefined;

      if (req) {
        const ua = req.headers['user-agent'];
        this.logger
          .info`-> #${ctx.getClass().name}.${ctx.getHandler().name} isGraphql=${isGraphql} gqlOperation=${gqlOperation} ua=${ua}`;
      }
    }

    if (gqlOperation === 'subscription' && gqlExecutionContext) {
      const gqlInfo = gqlExecutionContext.getInfo();
      const handlerName = gqlInfo?.fieldName ?? ctx.getHandler().name ?? 'anonymous';
      const wsReq = (gqlExecutionContext.getContext<Record<string, unknown>>().req ?? {}) as Omit<
        Request,
        'headers'
      > & {
        headers?: Record<string, unknown>;
      };
      const wsUa = wsReq.headers?.['user-agent'];
      this.logger
        .debug`-> (subscription) #${ctx.getClass().name}.${handlerName} ua=${wsUa} headers=${maskWsHeaders(wsReq.headers)}`;
      const result = next.handle();
      const rawResult: unknown = result;
      let constructorName = typeof rawResult;
      let hasAsyncIterator = false;
      let hasSubscribe = false;

      if (typeof rawResult === 'object' && rawResult !== null) {
        const ctor = Reflect.get(rawResult, 'constructor');
        if (ctor && typeof ctor === 'function' && typeof ctor.name === 'string') {
          constructorName = ctor.name;
        }
        hasAsyncIterator = typeof Reflect.get(rawResult, Symbol.asyncIterator) === 'function';
        hasSubscribe = typeof Reflect.get(rawResult, 'subscribe') === 'function';
      }

      this.logger
        .debug`<- (subscription) #${ctx.getClass().name}.${handlerName} resultType=${typeof result} constructor=${constructorName} hasAsyncIterator=${hasAsyncIterator} hasSubscribe=${hasSubscribe}`;
      return result;
    }

    // gRPC request handling
    if (ctx.getType() === 'rpc') {
      return this.handleRpcRequest(ctx, next);
    }

    // ws subscription request - NestJS 某些场景下 req 可能为空

    if (!req) {
      this.logger
        .warning`Request object is empty, skipping logging for ${ctx.getClass().name}.${ctx.getHandler().name}`;
      return next.handle();
    }

    const body = Object.fromEntries(
      Object.entries((req.body ?? {}) as Record<string, unknown>).map(([k, v]) => [
        k,
        typeof v === 'string' && v.length > 100 ? `${v.slice(0, 100)}...` : v,
      ]),
    );
    // 获取客户端真实 IP：优先使用 Cloudflare cf-connecting-ip，其次 x-forwarded-for，最后 req.ip
    const cfConnectingIp = req.headers['cf-connecting-ip'];
    const realIp =
      typeof cfConnectingIp === 'string' ? cfConnectingIp : (req.headers['x-forwarded-for'] ?? req.ip ?? req.ips[0]);
    const ipAddress = Array.isArray(realIp) ? realIp.at(0) : realIp;

    // CF-Ray 用于 Cloudflare 日志追踪
    const cfRay = req.headers['cf-ray'];
    const info = {
      path: req.url,
      body,
      query: req.query,
      params: req.params,
      // 日志脱敏: authorization / cookie 等敏感 header 整条 [REDACTED] (之前裸 spread 把完整 JWT+cookie 打进日志)。
      headers: redactHttpHeaders(req.headers),
      /*
            raw: req.raw,
            id: req.id,
            */
      ip: ipAddress !== '::1' ? ipAddress?.replace(/:\d+$/, '') : ipAddress,
      // parsedIp: ip.toBuffer(req.ip).toString('utf8'),
      ips: req.ips,
      hostname: req.hostname,
      // isMobile: req.isMobile,
      // sessionID: req.sessionID,
      // signedCookies: req.signedCookies,
      // session: req.session,
    };

    const uid = req.user?.uid;
    // handler.name 在 OpenTelemetry 插件下可能为空字符串或被覆盖

    const TAG = `(${uid ?? 'anonymous'}) #${ctx.getClass().name}.${ctx.getHandler().name || 'anonymous'}`;

    // 健康检查路径，跳过日志记录

    const isHealthCheck = req.path.startsWith('/health') || req.path === '/';

    const currentSpan = trace.getSpan(context.active());
    const spanTraceId = currentSpan?.spanContext().traceId;
    const headerTraceId = typeof req.headers['x-trace-id'] === 'string' ? req.headers['x-trace-id'].trim() : undefined;
    const traceId = spanTraceId ?? headerTraceId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const userIdFromRequest = req.user?.userId;

    return RequestContext.run({ traceId, userId: userIdFromRequest ?? null }, () => {
      if (!isHealthCheck) {
        this.logger
          .debug`-> ${TAG} call... ip=${ipAddress} cfRay=${cfRay} ${req.method} ${req.url} ua=${req.headers['user-agent']}`;
      }

      const now = Date.now();
      return next.handle().pipe(
        finalize(() => {
          if (!isHealthCheck) {
            this.logger.debug`<- ${TAG} spent ${Date.now() - now}ms`;
          }
        }),
        catchError((e) => {
          const skipNotFound = (e as { status?: number }).status !== 404;
          if (skipNotFound) {
            this.logger.warning`${TAG} ${info}: ${e}`;
          }
          throw e;
        }),
      );
    });
  }

  /**
   * Handle gRPC/RPC requests with logging and tracing
   *
   * gRPC trace propagation via metadata:
   * - Client sends `traceparent` header in gRPC metadata
   * - Format: "00-{traceId}-{spanId}-{flags}" (W3C Trace Context)
   * - We extract traceId from metadata or OpenTelemetry span
   *
   * 日志格式与 HTTP 保持一致：
   * -> (rpc) #Class.method call... data={...}
   * <- (rpc) #Class.method spent Xms
   */
  private handleRpcRequest(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const rpcCtx = ctx.switchToRpc();
    const data = rpcCtx.getData();
    const rpcContext = rpcCtx.getContext();

    const className = ctx.getClass().name;
    const handlerName = ctx.getHandler().name;
    const TAG = `(rpc) #${className}.${handlerName}`;

    // Extract traceId from gRPC metadata or OpenTelemetry span
    const traceId = this.extractGrpcTraceId(rpcContext);

    return RequestContext.run({ traceId, userId: null }, () => {
      // Truncate large data for logging (similar to HTTP body truncation)
      const truncatedData = this.truncateData(data);
      this.logger.debug`-> ${TAG} call... data=${truncatedData}`;

      const now = Date.now();
      return next.handle().pipe(
        finalize(() => {
          this.logger.debug`<- ${TAG} spent ${Date.now() - now}ms`;
        }),
        catchError((e) => {
          // BusinessException (isFatal=false) 是预期业务状态（如 MG40001 设备离线），
          // 应该用 warn 级别避免污染 Sentry/Loki ERROR 信号。FatalException 和 unknown
          // 异常仍按 error 级别。GrpcExceptionFilter 也会按 isFatal 路由响应。
          if (isOopsBusinessException(e)) {
            this.logger.warning`${TAG} business: ${e}`;
          } else {
            this.logger.error`${TAG} error: ${e}`;
          }
          throw e;
        }),
      );
    });
  }

  /**
   * Extract traceId from gRPC metadata or OpenTelemetry span
   *
   * Priority:
   * 1. OpenTelemetry active span (if gRPC instrumentation enabled)
   * 2. gRPC metadata `traceparent` header (W3C format: 00-{traceId}-{spanId}-{flags})
   * 3. gRPC metadata `x-trace-id` header (custom header)
   * 4. Generate new traceId
   */
  private extractGrpcTraceId(rpcContext: unknown): string {
    // 1. Try OpenTelemetry span first (requires @opentelemetry/instrumentation-grpc)
    const currentSpan = trace.getSpan(context.active());
    const spanTraceId = currentSpan?.spanContext().traceId;
    if (spanTraceId) {
      return spanTraceId;
    }

    // 2. Try gRPC metadata (fallback if no OpenTelemetry instrumentation)
    // NestJS gRPC context is a @grpc/grpc-js Metadata object
    const metadata = rpcContext as { get?: (key: string) => string[] } | undefined;
    if (metadata?.get) {
      // Try W3C traceparent format: "00-{traceId}-{spanId}-{flags}"
      const traceparent = metadata.get('traceparent')[0];
      if (traceparent) {
        const parts = traceparent.split('-');
        if (parts.length >= 2 && parts[1]?.length === 32) {
          return parts[1];
        }
      }

      // Try custom x-trace-id header
      const xTraceId = metadata.get('x-trace-id')[0];
      if (xTraceId) {
        return xTraceId.trim();
      }
    }

    // 3. Generate new traceId
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Truncate large data objects for logging
   */
  private truncateData(data: unknown): unknown {
    return truncateForLog(data);
  }
}

const MAX_LOG_FIELD_STRING = 100;
const MAX_LOG_DEPTH = 4;

/**
 * Truncate data for logging: long strings clipped, big arrays summarized, and
 * nested objects recursed. The non-recursive version left deep fields untouched,
 * so request payloads dumped large + sensitive values in full (e.g. streamChat's
 * environment.enhancements.careContext — the whole family context: address,
 * members, routines — landed in DEBUG logs). Recursing truncates those at every
 * level; bounded by depth so it can't run away on cyclic/huge structures.
 */
export function truncateForLog(data: unknown, depth = 0): unknown {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') {
    return data.length > 200 ? `${data.slice(0, 200)}...` : data;
  }
  if (typeof data !== 'object') return data;
  if (depth >= MAX_LOG_DEPTH) return '[Object]';
  if (Array.isArray(data)) {
    return data.length > 5 ? `[Array(${data.length})]` : data.map((v) => truncateForLog(v, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (typeof value === 'string') {
      result[key] = value.length > MAX_LOG_FIELD_STRING ? `${value.slice(0, MAX_LOG_FIELD_STRING)}...` : value;
    } else if (Array.isArray(value) && value.length > 5) {
      result[key] = `[Array(${value.length})]`;
    } else if (value && typeof value === 'object') {
      result[key] = truncateForLog(value, depth + 1);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function maskWsHeaders(headers?: Record<string, unknown>) {
  // WS 路径同样全抹敏感 header（之前仅截前 12 字，仍泄露前缀）。复用 HTTP 脱敏（函数声明已 hoist）。
  return redactHttpHeaders(headers);
}

const SENSITIVE_HTTP_HEADER_PATTERN = /authorization|cookie|token|secret|api[-_]?key|x-auth/i;

/**
 * 日志脱敏 — 含敏感关键字的 HTTP header 整条替换为 [REDACTED]（不截断，避免泄露前缀）。
 * 命中: authorization / proxy-authorization / cookie / set-cookie / x-api-key / x-auth-token 等。
 * 之前 HTTP 请求日志裸 spread req.headers，把完整 Bearer JWT + cookie 明文落盘（泄露面）。
 */
export function redactHttpHeaders(headers: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!headers) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HTTP_HEADER_PATTERN.test(key) ? '[REDACTED]' : value;
  }
  return out;
}
