import { Controller, Get } from '@nestjs/common';

import { LocalOnly } from '@app/nest/guards';

import { Temporal } from '@js-temporal/polyfill';

/**
 * Sentry Debug Controller
 *
 * 仅 localhost 可访问（LocalOnlyGuard），用于验证 Sentry 连通性。
 * K8s 经过 LB/proxy 的请求 IP 不是 127.0.0.1，天然被挡。
 *
 * 端点：
 * - GET /sentry-debug — 触发 Sentry 测试错误，验证上报是否正常
 *
 * 前置条件：
 * - instrument.js 中 SENTRY_DSN 已配置且 Sentry.init() 已执行
 * - NODE_ENV=production 时 Sentry 才真正上报
 *
 * 使用方式：
 * ```bash
 * # 本地开发
 * curl http://127.0.0.1:3000/sentry-debug
 *
 * # K8s Pod 内（通过 port-forward）
 * kubectl port-forward pod/<pod-name> 3000:3000
 * curl http://127.0.0.1:3000/sentry-debug
 *
 * # K8s Pod 内（直接 exec）
 * kubectl exec <pod-name> -- curl -s http://127.0.0.1:3000/sentry-debug
 * ```
 *
 * 返回值：
 * - { success: true,  message: "Test error sent to Sentry" }  — 已发送
 * - { success: false, message: "SENTRY_DSN not set" }         — 未配置
 * - { success: false, message: "@sentry/nestjs not installed" } — 缺依赖
 */
@LocalOnly()
@Controller('sentry-debug')
export class SentryDebugController {
  @Get()
  testSentry(): { success: boolean; message: string } {
    let Sentry: { captureException: (error: unknown) => void };
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional dependency
      Sentry = require('@sentry/nestjs');
    } catch {
      return { success: false, message: '@sentry/nestjs not installed' };
    }

    if (!process.env.SENTRY_DSN) {
      return { success: false, message: 'SENTRY_DSN not set' };
    }

    const error = new Error(
      `[Sentry Test] triggered at ${Temporal.Now.instant().toString({ smallestUnit: 'millisecond' })}`,
    );
    Sentry.captureException(error);

    return { success: true, message: 'Test error sent to Sentry' };
  }
}
