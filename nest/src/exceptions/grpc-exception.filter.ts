import { Catch, HttpException } from '@nestjs/common';

import { getAppLogger } from '@app/utils/app-logger';

import { OOPS_ERROR_METADATA_KEY } from './error-codes';
import { Oops } from './oops';
import { OopsError } from './oops-error';

import { Metadata as GrpcMetadata, status } from '@grpc/grpc-js';
import * as Sentry from '@sentry/nestjs';
import { Observable, of, throwError } from 'rxjs';
import { ZodError } from 'zod';

import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';

/**
 * OopsException 接口
 * 兼容 contract 层的 BusinessException 和 FatalException
 */
interface IOopsException extends Error {
  httpStatus: number;
  errorCode: string;
  businessCode: string;
  userMessage: string;
  internalDetails?: string;
  provider?: string;
  isFatal(): boolean;
  getCombinedCode(): string;
}

/**
 * GrpcError 结构
 * 与 contract/exceptions/grpc-error.ts 中的 GrpcErrorSchema 保持一致
 */
interface GrpcError {
  httpStatus: number;
  errorCode: string;
  businessCode: string;
  userMessage: string;
  internalDetails?: string;
  provider: string;
}

/**
 * gRPC 异常过滤器
 *
 * 错误分类策略：
 * - BusinessException (isFatal=false) → gRPC OK + x-business-error header
 *   传输层视角：服务正常处理了请求，Istio metrics 不计为错误
 *   客户端通过 businessErrorMiddleware 读取 header 还原异常
 *
 * - FatalException (isFatal=true) → gRPC INTERNAL + details JSON
 *   传输层视角：服务出了问题，Istio metrics 计为错误，触发 Sentry
 *
 * @example
 * // 在 grpc-bootstrap.ts 中注册
 * app.useGlobalFilters(new GrpcExceptionFilter('marsgate'));
 */

@Catch()
export class GrpcExceptionFilter implements ExceptionFilter {
  private readonly logger = getAppLogger('GrpcExceptionFilter');

  constructor(private readonly provider: string) {}

  catch(exception: unknown, host: ArgumentsHost): Observable<unknown> {
    // OopsError V2: instanceof 检测（优先）
    if (exception instanceof OopsError) {
      return this.handleOopsErrorV2(exception, host);
    }

    // Legacy: duck-typing 检测（向后兼容）
    if (this.isOopsException(exception)) {
      return this.handleOopsException(exception, host);
    }

    // Zod 验证错误
    if (exception instanceof ZodError) {
      return this.handleZodError(exception);
    }

    // NestJS HttpException — most often an unmatched-route NotFoundException from the hybrid
    // HTTP health server (a gRPC service only exposes GET /health*, so stray HTTP probes like
    // POST /graphql / POST /health 404). A client-side 4xx must NOT be logged as a server ERROR
    // or sent to Sentry — that turns harmless misdirected traffic into false error-dashboard
    // noise. Map to the matching gRPC status; ERROR + Sentry stay only for 5xx.
    if (exception instanceof HttpException) {
      return this.handleHttpException(exception);
    }

    // 其他未知错误
    return this.handleUnexpectedError(exception);
  }

  private handleHttpException(exception: HttpException): Observable<never> {
    const httpStatus = exception.getStatus();
    const message = exception.message;
    const grpcError: GrpcError = {
      httpStatus,
      errorCode: httpStatus >= 500 ? '0x0401' : '0x0101',
      businessCode: httpStatus >= 500 ? 'INTERNAL_ERROR' : 'CLIENT_ERROR',
      userMessage: message,
      internalDetails: message,
      provider: this.provider,
    };

    if (httpStatus >= 500) {
      this.logger.error`[HttpException ${httpStatus}] ${message} ${exception}`;
      Sentry.captureException(exception);
    } else {
      // 4xx = client error (unmatched route, bad method/param) — WARN, no Sentry.
      this.logger.warning`[HttpException ${httpStatus}] ${message}`;
    }

    return throwError(() => ({ code: this.httpStatusToGrpcStatus(httpStatus), details: JSON.stringify(grpcError) }));
  }

  private isOopsException(error: unknown): error is IOopsException {
    return (
      typeof error === 'object' &&
      error !== null &&
      'httpStatus' in error &&
      'errorCode' in error &&
      'businessCode' in error &&
      'userMessage' in error &&
      'isFatal' in error &&
      typeof (error as IOopsException).isFatal === 'function'
    );
  }

  private handleOopsException(exception: IOopsException, host: ArgumentsHost): Observable<unknown> {
    const isFatal = exception.isFatal();

    const grpcError: GrpcError = {
      httpStatus: exception.httpStatus,
      errorCode: exception.errorCode,
      businessCode: exception.businessCode,
      userMessage: exception.userMessage,
      internalDetails: exception.internalDetails,
      provider: exception.provider ?? this.provider,
    };

    const details = JSON.stringify(grpcError);

    if (isFatal) {
      this.logger
        .error`[${exception.getCombinedCode()}] ${exception.userMessage} | ${exception.internalDetails} ${exception}`;
      Sentry.captureException(exception);

      const grpcStatus = this.httpStatusToGrpcStatus(exception.httpStatus);
      // 直接抛出 { code, details } 而非 RpcException
      // 原因：@grpc/grpc-js 的 serverErrorToStatus() 检查 error.code（顶层属性）
      return throwError(() => ({ code: grpcStatus, details }));
    }

    // 业务错误：gRPC OK + initial metadata 携带错误详情
    // 传输层返回 OK → Istio/Kiali 不计为错误
    // 客户端 businessErrorMiddleware 读取 x-oops-error header → 还原 BusinessException
    this.logger.warning`[${exception.getCombinedCode()}] ${exception.userMessage} | ${exception.internalDetails}`;

    // host.getArgByIndex(2) = gRPC call 对象，NestJS 适配层传递 [request, metadata, call]
    const call = host.getArgByIndex(2);
    if (call?.sendMetadata) {
      const metadata = new GrpcMetadata();
      metadata.set(OOPS_ERROR_METADATA_KEY, Buffer.from(details, 'utf-8'));
      call.sendMetadata(metadata);
    }

    return of({});
  }

  /**
   * OopsError V2 处理
   *
   * - Panic (500): gRPC INTERNAL + Sentry
   * - Block (4xx): 映射到具体 gRPC status（客户端错误，不用 OK pattern）
   * - Oops (422): gRPC OK + metadata（业务拒绝，Istio 不计为错误）
   */
  private handleOopsErrorV2(exception: OopsError, host: ArgumentsHost): Observable<unknown> {
    const grpcError: GrpcError = {
      httpStatus: exception.httpStatus,
      errorCode: exception.errorCode,
      businessCode: exception.oopsCode,
      userMessage: exception.userMessage,
      internalDetails: exception.internalDetails,
      provider: exception.provider ?? this.provider,
    };

    const details = JSON.stringify(grpcError);

    if (exception.isFatal()) {
      // Panic: gRPC INTERNAL + Sentry
      this.logger
        .error`[${exception.getCombinedCode()}] Oops.Panic ${exception.userMessage} | ${exception.internalDetails} ${exception}`;
      Sentry.captureException(exception);

      const grpcStatus = this.httpStatusToGrpcStatus(exception.httpStatus);
      return throwError(() => ({ code: grpcStatus, details }));
    }

    if (exception instanceof Oops.Block) {
      // Block: 映射到具体 gRPC status，不用 OK pattern
      this.logger
        .warning`[${exception.getCombinedCode()}] Oops.Block(${exception.httpStatus}) ${exception.userMessage} | ${exception.internalDetails}`;

      const grpcStatus = this.httpStatusToGrpcStatus(exception.httpStatus);
      return throwError(() => ({ code: grpcStatus, details }));
    }

    // Oops (422): OK pattern + metadata
    this.logger.warning`[${exception.getCombinedCode()}] Oops ${exception.userMessage} | ${exception.internalDetails}`;

    const call = host.getArgByIndex(2);
    if (call?.sendMetadata) {
      const metadata = new GrpcMetadata();
      metadata.set(OOPS_ERROR_METADATA_KEY, Buffer.from(details, 'utf-8'));
      call.sendMetadata(metadata);
    }

    return of({});
  }

  private handleZodError(exception: ZodError): Observable<never> {
    const firstIssue = exception.issues.at(0);
    const grpcError: GrpcError = {
      httpStatus: 400,
      errorCode: '0x0101', // CLIENT_INPUT_ERROR
      businessCode: 'VALIDATION_ERROR',
      userMessage: firstIssue?.message ?? '请求参数验证失败',
      internalDetails: JSON.stringify(exception.issues),
      provider: this.provider,
    };

    this.logger.warning`[ZodError] ${firstIssue?.path.join('.')}: ${firstIssue?.message}`;

    return throwError(() => ({ code: status.INVALID_ARGUMENT, details: JSON.stringify(grpcError) }));
  }

  private handleUnexpectedError(exception: unknown): Observable<never> {
    this.logger.error`[UnknownError] ${exception}`;
    Sentry.captureException(exception);

    const grpcError: GrpcError = {
      httpStatus: 500,
      errorCode: '0x0401', // SYSTEM_INTERNAL_ERROR
      businessCode: 'INTERNAL_ERROR',
      userMessage: '服务内部错误，请稍后重试',
      internalDetails: exception instanceof Error ? exception.message : String(exception),
      provider: this.provider,
    };

    return throwError(() => ({ code: status.INTERNAL, details: JSON.stringify(grpcError) }));
  }

  private httpStatusToGrpcStatus(httpStatus: number): number {
    // HTTP → gRPC status 映射
    //
    // 关键区分：
    // - 400 INVALID_ARGUMENT: 请求参数本身有问题（格式错、缺字段），修改参数才能成功
    // - 422 FAILED_PRECONDITION: 请求合法但当前条件不满足（设备不在线、余额不足），换个时机/条件可能成功
    if (httpStatus >= 500) return status.INTERNAL;
    if (httpStatus === 400) return status.INVALID_ARGUMENT;
    if (httpStatus === 401) return status.UNAUTHENTICATED;
    if (httpStatus === 403) return status.PERMISSION_DENIED;
    if (httpStatus === 404) return status.NOT_FOUND;
    if (httpStatus === 409) return status.ALREADY_EXISTS;
    if (httpStatus === 422) return status.FAILED_PRECONDITION;
    if (httpStatus === 429) return status.RESOURCE_EXHAUSTED;
    return status.UNKNOWN;
  }
}
