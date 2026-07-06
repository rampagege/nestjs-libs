import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { HttpStatus } from '@nestjs/common/enums';
import { GqlExecutionContext } from '@nestjs/graphql';
import { ThrottlerException } from '@nestjs/throttler';

import { SysEnv } from '@app/env';
import { ApiRes } from '@app/nest/common/response';
import { ErrorCodes } from '@app/nest/exceptions/error-codes';
import { getAppLogger } from '@app/utils/app-logger';
import { getErrorMessage, getErrorName, getErrorStatus, getResponseMessage } from '@app/utils/error';

import { OopsError } from './oops-error';

import { SentryExceptionCaptured } from '@sentry/nestjs';
import { GraphQLError } from 'graphql';
import * as _ from 'radash';
import { ZodError } from 'zod';

import type { IdentityRequest } from '../types/identity.interface';
import type { II18nService } from '@app/nest/common/i18n.interface';
import type { ErrorCodeValue } from '@app/nest/exceptions/error-codes';
import type { ArgumentsHost, ExceptionFilter, ExecutionContext, INestApplication } from '@nestjs/common';
import type { Response } from 'express';

/** OopsError 或兼容旧 OopsLike 的鸭子类型 */
type OopsLike = {
  readonly httpStatus: number;
  readonly userMessage: string;
  getCombinedCode(): string;
  getInternalDetails(): string;
};

/**
 * ⚠️  ErrorCodes 迁移说明（针对其他项目）
 *
 * 本文件已更新使用新的维度分类 ErrorCodes。如果你的项目还在使用旧的错误码，
 * 请参考以下迁移对照表：
 *
 * === 迁移对照表 ===
 * 旧错误码 → 新错误码 (责任方)
 *
 * BadRequest → CLIENT_INPUT_ERROR (前端开发者)
 * ZodError → CLIENT_VALIDATION_FAILED (前端开发者)
 * NotFound → CLIENT_AUTH_REQUIRED (前端开发者)
 * Unauthorized → CLIENT_AUTH_REQUIRED (前端开发者)
 * TooManyRequests → CLIENT_RATE_LIMITED (前端开发者)
 *
 * BusinessError → BUSINESS_RULE_VIOLATION (产品/业务人员)
 * Conflict → BUSINESS_DATA_CONFLICT (产品/业务人员)
 *
 * FetchError → EXTERNAL_SERVICE_ERROR (运维/DevOps)
 *
 * PrismaClientKnownRequestError → SYSTEM_DATABASE_ERROR (后端开发者)
 * Unexpected → SYSTEM_INTERNAL_ERROR (后端开发者)
 *
 * Outdated → DATA_VERSION_MISMATCH (数据管理员)
 * Undefined → 使用具体的错误码替代
 *
 * === 迁移步骤 ===
 * 1. 更新你项目中的 ErrorCodes 引用
 * 2. 根据错误场景选择合适的新错误码
 * 3. 考虑错误的责任方，选择对应维度的错误码
 * 4. 测试确保错误处理正常工作
 */

// @Catch() // or app.useGlobalFilters(new AnyExceptionFilter())
export class AnyExceptionFilter implements ExceptionFilter {
  private readonly logger = getAppLogger('AnyExceptionFilter');
  private i18nService: II18nService | null = null;
  private i18nServiceRetrieved = false;

  constructor(
    private readonly app?: INestApplication, // 应用实例，用于延迟获取服务
  ) {}

  async catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    // GraphQL 场景 getResponse() 可能返回空对象，而非完整 Express Response
    const rawResponse = ctx.getResponse<Response | Record<string, never>>();
    const isGraphqlRequest = !('status' in rawResponse) || typeof rawResponse.status !== 'function';

    let request: IdentityRequest | undefined = ctx.getRequest();

    if (!request?.headers && host.getType<'http' | 'graphql'>() === 'graphql') {
      const executionContext = host as unknown as ExecutionContext;
      const gqlCtx = GqlExecutionContext.create(executionContext).getContext<Record<string, unknown>>();
      request = (gqlCtx.req ?? gqlCtx.request ?? gqlCtx.expressReq ?? {}) as IdentityRequest;
    }

    if (host.getType<'http' | 'graphql' | 'ws'>() === 'ws') {
      const ws = host.switchToWs();
      const client = ws.getClient<{ connectionParams?: Record<string, unknown> }>();

      const params = (client as typeof client | undefined)?.connectionParams ?? {};

      this.logger.error`WS error ${{ transport: 'ws', connectionParams: maskConnectionParams(params) }} ${exception}`;
    }

    if (isGraphqlRequest) {
      // OopsError V2: instanceof 检测（优先）
      if (exception instanceof OopsError) {
        return this.handleGraphqlBusinessException(exception, request, host);
      }

      // Legacy: duck-typing 检测（向后兼容）
      if (this.isBusinessException(exception)) {
        return this.handleGraphqlBusinessException(exception, request, host);
      }

      // 非 Oops 异常：通过 toErrorDescriptor 映射成带 extensions 的 GraphQLError
      // 这里是 iOS 客户端依赖 extensions.httpStatus 触发自动登出等行为的关键路径，
      // 过去直接 throw 原始异常会让 Apollo 默认只带 message，没有 httpStatus。
      const descriptor = toErrorDescriptor(exception);
      if (descriptor) {
        this.logMappedException(exception, request, descriptor, true);
        if (isServerError(descriptor.httpStatus)) {
          this.captureExceptionBySentry(exception, host);
        }
        throw new GraphQLError(descriptor.message, {
          extensions: {
            code: descriptor.code,
            httpStatus: descriptor.httpStatus,
            userMessage: descriptor.message,
            ...(descriptor.errors !== undefined ? { errors: descriptor.errors } : {}),
          },
        });
      }

      // 未识别异常：兜底 500 + Sentry
      this.captureExceptionBySentry(exception, host);
      const fallbackMessage = getErrorMessage(exception) || 'Internal server error';
      this.logger
        .error`<GraphqlRequest> (${request?.user?.uid})[${request?.ip}] ${getErrorName(exception)} ${fallbackMessage} ${exception}`;
      throw new GraphQLError(fallbackMessage, {
        extensions: {
          code: ErrorCodes.SYSTEM_INTERNAL_ERROR,
          httpStatus: HttpStatus.INTERNAL_SERVER_ERROR,
          userMessage: fallbackMessage,
        },
      });
    }

    const response = rawResponse as Response;

    // OopsError V2: instanceof 检测（优先）
    if (exception instanceof OopsError) {
      return this.handleBusinessException(exception, request, response, host);
    }

    // Legacy: duck-typing 检测（向后兼容）
    if (this.isBusinessException(exception)) {
      return this.handleBusinessException(exception, request, response, host);
    }

    // 非 Oops 异常：通过 toErrorDescriptor 统一映射（与 GraphQL 分支共享规则）
    const descriptor = toErrorDescriptor(exception);
    if (descriptor) {
      this.logMappedException(exception, request, descriptor, false);
      if (isServerError(descriptor.httpStatus)) {
        this.captureExceptionBySentry(exception, host);
      }
      return response.status(descriptor.httpStatus).json(
        ApiRes.failure({
          code: descriptor.code,
          message: descriptor.message,
          errors: descriptor.errors,
        }),
      );
    }

    // 只有未被识别的异常才交给 Sentry
    this.captureExceptionBySentry(exception, host);

    // 使用 type guard helpers 安全提取 unknown 异常的属性
    this.logger
      .error`(${request?.user?.uid})[${request?.ip}] ${getErrorName(exception)} ${getErrorMessage(exception)} ${exception}`;

    // unexpected error, each error should be handled
    const status = getErrorStatus(exception, 500);
    const message = getErrorMessage(exception);

    response.status(status).json({
      statusCode: status,
      message,
    });
    return;
  }

  /**
   * 统一日志入口：用 `toErrorDescriptor` 映射过的异常都走这里。
   *
   * - logLevel=error 时把原始 exception 附在末尾，保留 stack trace 便于排障
   * - 4xx (warning) 不带 stack，避免日志噪音
   * - GraphQL 上下文加 `<GraphqlRequest>` 前缀，方便在日志里按协议过滤
   */
  private logMappedException(
    exception: unknown,
    request: IdentityRequest | undefined,
    descriptor: HttpErrorDescriptor,
    isGraphql: boolean,
  ): void {
    const tag = isGraphql
      ? `<GraphqlRequest> (${request?.user?.uid})[${request?.ip}]`
      : `(${request?.user?.uid})[${request?.ip}]`;
    const name = getErrorName(exception);

    if (descriptor.logLevel === 'error') {
      this.logger
        .error`${tag} ${name}(${descriptor.httpStatus}) ${descriptor.message} code=${descriptor.code} ${exception}`;
    } else {
      this.logger.warning`${tag} ${name}(${descriptor.httpStatus}) ${descriptor.message} code=${descriptor.code}`;
    }
  }

  /**
   * 判断是否为 BusinessException
   */
  private isBusinessException(exception: unknown): exception is OopsLike {
    return (
      typeof exception === 'object' &&
      exception !== null &&
      'httpStatus' in exception &&
      'userMessage' in exception &&
      'getCombinedCode' in exception &&
      typeof (exception as { getCombinedCode: unknown }).getCombinedCode === 'function'
    );
  }

  /**
   * 选择性捕获异常到 Sentry
   * 业务异常（422）不应该被 Sentry 捕获，因为这些是预期的业务逻辑
   */
  @SentryExceptionCaptured()
  private captureExceptionBySentry(_exception: unknown, _host: ArgumentsHost): void {
    // 该方法仅用于触发 @SentryExceptionCaptured 装饰器
    // 实际的异常处理逻辑在 catch 方法中继续执行
  }

  /**
   * 处理 BusinessException / FatalException，支持国际化翻译
   *
   * - httpStatus < 500: BusinessException，warn 日志，不触发 Sentry
   * - httpStatus >= 500: FatalException，error 日志，触发 Sentry
   */
  private async handleBusinessException(
    exception: OopsLike,
    request: IdentityRequest | undefined,
    response: Response,
    host: ArgumentsHost,
  ) {
    const isFatal = exception.httpStatus >= 500;

    if (isFatal) {
      // Panic / FatalException: error 日志 + Sentry
      this.captureExceptionBySentry(exception, host);
      this.logger
        .error`(${request?.user?.uid})[${request?.ip}] Oops.Panic ${exception.getCombinedCode()} ${exception.userMessage} | ${exception.getInternalDetails()}`;
    } else if (exception.httpStatus !== 422 && exception instanceof OopsError) {
      // Block (4xx non-422)
      this.logger
        .warning`(${request?.user?.uid})[${request?.ip}] Oops.Block(${exception.httpStatus}) ${exception.getCombinedCode()} ${exception.userMessage} | ${exception.getInternalDetails()}`;
    } else {
      // Oops (422) / legacy BusinessException
      this.logger
        .warning`(${request?.user?.uid})[${request?.ip}] Oops ${exception.getCombinedCode()} ${exception.userMessage} | ${exception.getInternalDetails()}`;
    }

    // 获取翻译后的错误消息
    const translatedMessage = await this.getTranslatedMessage(exception, request);

    return response.status(exception.httpStatus).json(
      ApiRes.failure({
        code: exception.getCombinedCode(),
        message: translatedMessage,
      }),
    );
  }

  /**
   * GraphQL extensions 契约（所有 GraphQL 错误路径都遵循）：
   * `{ code: string, httpStatus: number, userMessage: string, ...extras }`
   * iOS 客户端统一通过 extensions.httpStatus 判断登出/重试等行为，不依赖具体异常类型。
   * Oops 路径额外带 errorCode / businessCode；non-Oops 路径可能带 errors（Zod issues 等）。
   */
  private async handleGraphqlBusinessException(
    exception: OopsLike,
    request: IdentityRequest | undefined,
    host: ArgumentsHost,
  ): Promise<never> {
    const isFatal = exception.httpStatus >= 500;

    if (isFatal) {
      // Panic / FatalException: error 日志 + Sentry
      this.captureExceptionBySentry(exception, host);
      this.logger
        .error`(${request?.user?.uid})[${request?.ip}] GraphQL Oops.Panic ${exception.getCombinedCode()} ${exception.userMessage} | ${exception.getInternalDetails()}`;
    } else if (exception.httpStatus !== 422 && exception instanceof OopsError) {
      // Block (4xx non-422)
      this.logger
        .warning`(${request?.user?.uid})[${request?.ip}] GraphQL Oops.Block(${exception.httpStatus}) ${exception.getCombinedCode()} ${exception.userMessage} | ${exception.getInternalDetails()}`;
    } else {
      // Oops (422) / legacy BusinessException
      this.logger
        .warning`(${request?.user?.uid})[${request?.ip}] GraphQL Oops ${exception.getCombinedCode()} ${exception.userMessage} | ${exception.getInternalDetails()}`;
    }

    const translatedMessage = await this.getTranslatedMessage(exception, request);

    const extensions: Record<string, unknown> = {
      code: exception.getCombinedCode(),
      httpStatus: exception.httpStatus,
      userMessage: translatedMessage,
    };

    if ('errorCode' in exception) {
      extensions.errorCode = Reflect.get(exception, 'errorCode');
    }
    if ('businessCode' in exception) {
      extensions.businessCode = Reflect.get(exception, 'businessCode');
    }

    throw new GraphQLError(translatedMessage, { extensions: extensions });
  }

  /**
   * 延迟获取 I18nService
   *
   * 【设计意图】
   * - NestJS 的 ExceptionsZone 会拦截异常传播，导致 try-catch 失效
   * - app.get() 在服务不存在时会抛出 UnknownElementException，且无法被 try-catch 捕获
   * - 在 GraphQL 上下文中，该异常会绕过异常处理器直接导致应用崩溃
   * - 通过环境变量开关控制，默认禁用以避免崩溃风险
   * - 异常翻译是辅助功能，失败时降级到原始消息
   */
  private getI18nService(): II18nService | null {
    if (this.i18nServiceRetrieved) {
      return this.i18nService;
    }

    this.i18nServiceRetrieved = true;

    // 检查环境变量开关
    if (!SysEnv.I18N_EXCEPTION_ENABLED) {
      return null;
    }

    if (!this.app) {
      return null;
    }

    try {
      // 使用字符串 token 获取服务，因为我们不想直接导入具体类
      const I18nServiceToken = 'I18nService';
      this.i18nService = this.app.get(I18nServiceToken, { strict: false });
      this.logger.debug`#getI18nService I18nService已启用`;
      return this.i18nService;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.warning`#getI18nService 获取失败: ${errorMsg}`;
      return null;
    }
  }

  /**
   * 获取翻译后的错误消息
   *
   * 【设计意图】
   * - 框架层只负责提取 x-locale 和调用 i18nService
   * - 不做任何语言判断、规范化、fallback
   * - 所有语言逻辑交给 i18nService.translateErrorMessage 统一处理
   */
  private async getTranslatedMessage(exception: OopsLike, request?: IdentityRequest): Promise<string> {
    try {
      const i18nService = this.getI18nService();
      if (!i18nService) {
        return exception.userMessage;
      }

      // 提取原始 x-locale（不做任何处理）
      const locale = this.getLocaleFromRequest(request);

      // 直接传给 i18nService，让它处理一切（语言解析、缓存、翻译、fallback）
      return await i18nService.translateErrorMessage({
        key: `errors.${exception.getCombinedCode()}`,
        sourceMessage: exception.userMessage,
        targetLanguage: locale, // null / 'zh-Hans' / 'en' / 任意格式
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warning`#getTranslatedMessage 翻译失败: ${reason}`;
      return exception.userMessage;
    }
  }

  /**
   * 从请求中提取用户语言偏好
   *
   * 【设计意图】
   * - 优先 x-locale 请求头(客户端设备语言,显式意图最高)
   * - 兜底 request.user.language —— 认证层可选注入的账号语言偏好
   *   (calo: auth 时把 User.language ?? Family.language 挂到 req.user.language,
   *   客户端不发 header 也能按账号语言返回错误文案;不注入的产品(如 unee)行为不变)
   * - 不做任何规范化、验证 —— 语言解析统一交给 i18nService 处理
   * - 返回 null 表示无任何语言信号(i18nService 走默认语言)
   */
  private getLocaleFromRequest(request?: IdentityRequest): string | null {
    if (!request) {
      return null;
    }

    const xLocale = request.headers?.['x-locale'];

    if (typeof xLocale === 'string') {
      const trimmed = xLocale.trim();

      // 过滤空字符串和通配符
      if (trimmed && trimmed !== '*') {
        return trimmed; // 原样返回：'zh-Hans', 'zh-hans', 'en', 'zh', ...
      }
    }

    const userLanguage = request.user?.['language'];
    if (typeof userLanguage === 'string' && userLanguage.trim()) {
      return userLanguage.trim();
    }

    return null;
  }
}

function maskConnectionParams(params: Record<string, unknown>) {
  const clone: Record<string, unknown> = { ...params };
  for (const key of Object.keys(clone)) {
    if (/authorization/i.test(key) && typeof clone[key] === 'string') {
      const value = clone[key];
      clone[key] = value.length > 20 ? `${value.slice(0, 20)}…` : value;
    }
  }
  return clone;
}

function isValidErrorCode(code: unknown): code is ErrorCodeValue {
  return Object.values(ErrorCodes).includes(code as ErrorCodes);
}

/**
 * 判断是否为 Prisma 已知请求错误（鸭子类型，不依赖 Prisma 导入）
 *
 * PrismaClientKnownRequestError 结构特征：
 * - code: 'P2002' 等以 'P' 开头的错误码
 * - clientVersion: Prisma 版本字符串
 * - name: 'PrismaClientKnownRequestError'
 */
interface PrismaKnownRequestError {
  code: string;
  message: string;
  clientVersion?: string;
  meta?: unknown;
}

/** 通过 `number` 注解将 enum 字面量类型放宽为 number，避免 `no-unsafe-enum-comparison` 同时不触发 `no-unnecessary-type-assertion`。 */
const SERVER_ERROR_MIN: number = HttpStatus.INTERNAL_SERVER_ERROR;
function isServerError(status: number): boolean {
  return status >= SERVER_ERROR_MIN;
}

function isPrismaKnownRequestError(e: unknown): e is PrismaKnownRequestError {
  if (typeof e !== 'object' || e === null) return false;

  const err = e as Record<string, unknown>;

  // 检查错误码是否以 'P' 开头（Prisma 约定）
  if (typeof err.code !== 'string' || !err.code.startsWith('P')) return false;

  // 检查是否有 clientVersion（Prisma 特有）
  if ('clientVersion' in err && typeof err.clientVersion === 'string') return true;

  // 检查构造函数名称（备用方案）
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- constructor 来自原型链，Object.create(null) 时不存在
  if (err.constructor?.name === 'PrismaClientKnownRequestError') return true;

  return false;
}

/**
 * 异常到响应描述符的统一映射结果
 *
 * HTTP 分支拿它填 `ApiRes.failure` + `response.status(httpStatus)`，
 * GraphQL 分支拿它填 `GraphQLError(message, { extensions: { httpStatus, code, userMessage } })`。
 * 两个协议共享同一套"异常 → 状态/码/消息"的映射规则，避免两边漂移。
 */
export interface HttpErrorDescriptor {
  httpStatus: number;
  code: string;
  message: string;
  errors?: unknown;
  /**
   * 日志级别。绝大多数情况下 = httpStatus >= 500 ? 'error' : 'warning'，
   * UnprocessableEntityException 例外：某些 cause 语义是业务预期（warning），
   * 其他 cause 视为未预期错误（error）。
   */
  logLevel: 'warning' | 'error';
}

/**
 * 把"协议层"异常（HttpException 家族 + Zod / Prisma / FetchError）映射为统一的
 * HttpErrorDescriptor。返回 `null` 表示这是未识别的异常，调用方应走 500 兜底 + Sentry。
 *
 * 设计决策：
 * - OopsError / Legacy BusinessException **不**进入此函数 —— 它们走 handleBusinessException
 *   / handleGraphqlBusinessException，这些方法会做 i18n 翻译 + 细分日志，映射规则不同。
 * - Pure function，不做日志、不触发 Sentry，仅做数据转换。副作用由调用方执行，便于单元测试。
 * - 新增异常类型时只需在此添加一个 branch，HTTP/GraphQL 两条响应路径自动对齐。
 */
export function toErrorDescriptor(exception: unknown): HttpErrorDescriptor | null {
  if (exception instanceof ZodError) {
    return {
      httpStatus: HttpStatus.BAD_REQUEST,
      code: ErrorCodes.CLIENT_VALIDATION_FAILED,
      message: 'Invalid parameters',
      errors: exception.issues,
      logLevel: 'warning',
    };
  }

  if (exception instanceof BadRequestException) {
    return {
      httpStatus: HttpStatus.BAD_REQUEST,
      code: ErrorCodes.CLIENT_INPUT_ERROR,
      message: exception.message,
      errors: getResponseMessage(exception.getResponse()),
      logLevel: 'warning',
    };
  }

  if (isPrismaKnownRequestError(exception)) {
    return {
      httpStatus: HttpStatus.UNPROCESSABLE_ENTITY,
      code: ErrorCodes.SYSTEM_DATABASE_ERROR,
      message: 'Operation failed, please try again later',
      logLevel: 'warning',
    };
  }

  if (exception instanceof ThrottlerException) {
    return {
      httpStatus: HttpStatus.TOO_MANY_REQUESTS,
      code: ErrorCodes.CLIENT_RATE_LIMITED,
      message: exception.message,
      errors: getResponseMessage(exception.getResponse()),
      logLevel: 'warning',
    };
  }

  if (exception instanceof NotFoundException) {
    return {
      httpStatus: HttpStatus.NOT_FOUND,
      code: ErrorCodes.CLIENT_AUTH_REQUIRED,
      message: exception.message,
      errors: getResponseMessage(exception.getResponse()),
      logLevel: 'warning',
    };
  }

  if (getErrorName(exception) === 'FetchError') {
    return {
      httpStatus: HttpStatus.UNPROCESSABLE_ENTITY,
      code: ErrorCodes.EXTERNAL_SERVICE_ERROR,
      message: 'Service temporarily unavailable',
      logLevel: 'warning',
    };
  }

  if (exception instanceof UnauthorizedException) {
    return {
      httpStatus: HttpStatus.UNAUTHORIZED,
      code: ErrorCodes.CLIENT_AUTH_REQUIRED,
      message: exception.message,
      errors: getResponseMessage(exception.getResponse()),
      logLevel: 'warning',
    };
  }

  if (exception instanceof ConflictException) {
    return {
      httpStatus: HttpStatus.CONFLICT,
      code: ErrorCodes.BUSINESS_DATA_CONFLICT,
      message: exception.message,
      errors: getResponseMessage(exception.getResponse()),
      logLevel: 'warning',
    };
  }

  if (exception instanceof UnprocessableEntityException) {
    const rawCause = exception.cause;
    const code = isValidErrorCode(rawCause) ? rawCause : ErrorCodes.SYSTEM_INTERNAL_ERROR;
    // 业务预期的 422（数据冲突、业务规则）记 warning；其他 cause 视为未预期，记 error
    const warnCodes: ErrorCodeValue[] = [ErrorCodes.DATA_VERSION_MISMATCH, ErrorCodes.BUSINESS_RULE_VIOLATION];
    return {
      httpStatus: HttpStatus.UNPROCESSABLE_ENTITY,
      code,
      message: exception.message,
      errors: getResponseMessage(exception.getResponse()),
      logLevel: warnCodes.includes(code) ? 'warning' : 'error',
    };
  }

  // 注意：HttpException 分支必须放在最后。BadRequest / Unauthorized / NotFound / Conflict /
  // Throttler / UnprocessableEntity 都继承自 HttpException，提前匹配会吃掉它们的细分 code 映射。
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const responseBody = exception.getResponse();
    const responseMessage = getResponseMessage(responseBody);
    const message: string =
      typeof responseBody === 'string'
        ? responseBody
        : typeof responseMessage === 'string'
          ? responseMessage
          : exception.message;

    if (!isServerError(status)) {
      return {
        httpStatus: status,
        code: ErrorCodes.CLIENT_INPUT_ERROR,
        message,
        errors: typeof responseBody === 'object' ? responseMessage : undefined,
        logLevel: 'warning',
      };
    }

    // 5xx HttpException：调用方负责触发 Sentry
    const body = typeof responseBody === 'object' ? (responseBody as Record<string, unknown>) : {};
    return {
      httpStatus: status,
      code: typeof body.code === 'string' ? body.code : ErrorCodes.SYSTEM_INTERNAL_ERROR,
      message: typeof body.message === 'string' ? body.message : 'Internal server error, please try again later',
      logLevel: 'error',
    };
  }

  return null;
}
