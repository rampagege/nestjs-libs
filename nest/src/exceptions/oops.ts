import { OopsError } from './oops-error';

import type { ErrorCodeValue } from './error-codes';

// ==================== Config Interfaces ====================

interface OopsConfig {
  errorCode: ErrorCodeValue;
  oopsCode: string;
  userMessage: string;
  internalDetails?: string;
  provider?: string;
  /** 原始错误，保留完整错误链用于调试 */
  cause?: unknown;
}

interface BlockConfig extends OopsConfig {
  httpStatus: 400 | 401 | 403 | 404 | 408 | 409 | 413 | 415 | 429;
}

interface PanicConfig {
  /** 缺省 500；502/503 用于上游依赖（如 Azure STT）失败透传 */
  httpStatus?: 500 | 502 | 503;
  errorCode: ErrorCodeValue;
  oopsCode?: string;
  userMessage: string;
  internalDetails?: string;
  provider?: string;
  /** 原始错误，保留完整错误链用于调试 */
  cause?: unknown;
}

// ==================== Oops (422) ====================

/**
 * 业务逻辑拒绝 — 422 Unprocessable Entity
 *
 * 请求合法，进了门，但业务逻辑说不行。
 * WARN 日志，不触发 Sentry。
 */
class Oops extends OopsError {
  readonly httpStatus = 422 as const;
  readonly errorCode: ErrorCodeValue;
  readonly oopsCode: string;
  readonly userMessage: string;
  override readonly internalDetails?: string;
  override readonly provider?: string;

  constructor(config: OopsConfig) {
    super(config.internalDetails ?? config.userMessage, { cause: config.cause });
    this.errorCode = config.errorCode;
    this.oopsCode = config.oopsCode;
    this.userMessage = config.userMessage;
    this.internalDetails = config.internalDetails;
    this.provider = config.provider;
  }
}

// ==================== Namespace (Block + Panic) ====================
// eslint-disable-next-line @typescript-eslint/no-namespace -- class+namespace merging for Oops.Block / Oops.Panic
namespace Oops {
  /**
   * 请求被拦截 — 4xx
   *
   * 门口就被挡了：认证失败、无权限、资源不存在、状态冲突。
   * WARN 日志，不触发 Sentry。
   */
  export class Block extends OopsError {
    readonly httpStatus: 400 | 401 | 403 | 404 | 408 | 409 | 413 | 415 | 429;
    readonly errorCode: ErrorCodeValue;
    readonly oopsCode: string;
    readonly userMessage: string;
    override readonly internalDetails?: string;
    override readonly provider?: string;

    constructor(config: BlockConfig) {
      super(config.internalDetails ?? config.userMessage, { cause: config.cause });
      this.httpStatus = config.httpStatus;
      this.errorCode = config.errorCode;
      this.oopsCode = config.oopsCode;
      this.userMessage = config.userMessage;
      this.internalDetails = config.internalDetails;
      this.provider = config.provider;
    }
  }

  /**
   * 系统故障 — 5xx server / upstream failure
   *
   * 大楼停电了：DB 挂了、外部服务不可达、配置缺失。
   * 缺省 500；上游依赖失败可显式标 502/503（如 Azure Fast STT 透传）。
   * ERROR 日志，触发 Sentry。
   */
  export class Panic extends OopsError {
    readonly httpStatus: 500 | 502 | 503;
    readonly errorCode: ErrorCodeValue;
    readonly oopsCode: string;
    readonly userMessage: string;
    override readonly internalDetails?: string;
    override readonly provider?: string;

    constructor(config: PanicConfig) {
      super(config.internalDetails ?? config.userMessage, { cause: config.cause });
      this.httpStatus = config.httpStatus ?? 500;
      this.errorCode = config.errorCode;
      this.oopsCode = config.oopsCode ?? '';
      this.userMessage = config.userMessage;
      this.internalDetails = config.internalDetails;
      this.provider = config.provider;
    }
  }
}

export { Oops };
export type { OopsConfig, BlockConfig, PanicConfig };
