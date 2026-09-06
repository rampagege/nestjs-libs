import { GqlExecutionContext } from '@nestjs/graphql';

import { OopsError } from '@app/nest/exceptions/oops-error';
import { RequestContext } from '@app/nest/trace/request-context';
import { getAppLogger } from '@app/utils/app-logger';

import { normalizeHeadersForLog, normalizePayloadForLog } from './log-redaction';
import { PRIVATE_PAYLOAD } from './private-payload.decorator';

import { context, trace } from '@opentelemetry/api';
import * as _ from 'radash';
import { catchError, finalize } from 'rxjs';

import type { IdentityRequest } from '../types/identity.interface';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import type { Observable } from 'rxjs';

/**
 * 是否为「预期业务异常」：`OopsError` 且非 fatal（httpStatus < 500）。
 *
 * 与 exception filter 契约一致：只认 `instanceof OopsError`，不看 plain shape。
 * 用 `httpStatus` 字段判断 fatal，避免在 logging 路径调用可能带副作用的 method。
 *
 * @internal exported for testing
 */
export function isExpectedOopsError(error: unknown): boolean {
  return error instanceof OopsError && error.httpStatus < 500;
}

export class LoggerInterceptor implements NestInterceptor {
  private readonly logger = getAppLogger('LoggerInterceptor');

  public intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> | Promise<Observable<unknown>> {
    if (
      Reflect.getMetadata(PRIVATE_PAYLOAD, ctx.getHandler()) ||
      Reflect.getMetadata(PRIVATE_PAYLOAD, ctx.getClass())
    ) {
      return next.handle();
    }
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

    const body = normalizePayloadForLog(req.body ?? {});
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
      headers: normalizeHeadersForLog(req.headers),
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
      const logSafeData = normalizePayloadForLog(data);
      this.logger.debug`-> ${TAG} call... data=${logSafeData}`;

      const now = Date.now();
      return next.handle().pipe(
        finalize(() => {
          this.logger.debug`<- ${TAG} spent ${Date.now() - now}ms`;
        }),
        catchError((e) => {
          // 非 fatal OopsError 是预期拒绝（如 MG40001 设备离线），用 warn 级别避免
          // 污染 Sentry/Loki ERROR 信号。Oops.Panic 和 unknown 仍按 error 级别。
          if (isExpectedOopsError(e)) {
            this.logger.warning`${TAG} expected: ${e}`;
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
}

function maskWsHeaders(headers?: Record<string, unknown>) {
  return normalizeHeadersForLog(headers);
}
