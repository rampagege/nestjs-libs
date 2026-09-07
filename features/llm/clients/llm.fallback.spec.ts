/**
 * LLM Fallback 行为验证
 *
 * 目标：确认 mood-analyzer 的 fallback 为何没有触发。
 * Sentry 现象：tried=[vertex:gemini-2.5-flash-lite]（只有主模型，fallback 没尝试）
 *
 * 假设一：fallback 模型未注册 → parseModelSpec 跳过 → fallbackModels 为空
 * 假设二：vertex 抛出的错误不满足 isRetryableError → fallback 逻辑直接 throw
 */

import 'reflect-metadata';

import { Oops } from '@app/nest/exceptions/oops';

import { parseModelSpec } from '../types/model.types';
import { isRetryableError, LLM } from './llm.class';
import { privateModelError } from './private-model';

import { APICallError, NoObjectGeneratedError, NoOutputGeneratedError } from 'ai';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { OopsError } from '@app/nest/exceptions/oops-error';

// ─────────────────────────────────────────────────────────────────────────────
// 假设一：parseModelSpec 能否正确解析 mood-analyzer 的 spec
// ─────────────────────────────────────────────────────────────────────────────

describe('parseModelSpec: mood-analyzer fallback spec', () => {
  const MOOD_SPEC = 'vertex:gemini-2.5-flash-lite?fallback=openrouter:gemini-2.5-flash-lite';

  it('should parse primary model key correctly', () => {
    const result = parseModelSpec(MOOD_SPEC as Parameters<typeof parseModelSpec>[0]);
    expect(result.key).toBe('vertex:gemini-2.5-flash-lite');
  });

  it('should NOT skip openrouter:gemini-2.5-flash-lite (it is registered)', () => {
    // 如果这个测试失败，说明 openrouter:gemini-2.5-flash-lite 未注册 → 假设一成立
    const result = parseModelSpec(MOOD_SPEC as Parameters<typeof parseModelSpec>[0]);
    expect(result.fallbackModels).toContain('openrouter:gemini-2.5-flash-lite');
  });

  it('should have exactly one fallback model', () => {
    const result = parseModelSpec(MOOD_SPEC as Parameters<typeof parseModelSpec>[0]);
    expect(result.fallbackModels).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 假设二：isRetryableError 对各种错误类型的判断
// ─────────────────────────────────────────────────────────────────────────────

describe('isRetryableError: APICallError (retryable)', () => {
  const makeApiError = (statusCode: number) =>
    new APICallError({
      message: `HTTP ${statusCode}`,
      url: 'https://example.com',
      requestBodyValues: {},
      statusCode,
      responseHeaders: {},
      responseBody: '',
      isRetryable: statusCode === 429 || statusCode >= 500,
    });

  it('should be retryable for 429', () => {
    expect(isRetryableError(makeApiError(429))).toBe(true);
  });

  it('should be retryable for 500', () => {
    expect(isRetryableError(makeApiError(500))).toBe(true);
  });

  it('should be retryable for 503', () => {
    expect(isRetryableError(makeApiError(503))).toBe(true);
  });

  it('should NOT be retryable for 400', () => {
    expect(isRetryableError(makeApiError(400))).toBe(false);
  });
});

describe('isRetryableError: NoObjectGeneratedError (BUG CONFIRMATION)', () => {
  // Type cast needed: LanguageModelUsage token-detail fields are all optional at runtime
  // but TypeScript requires them to be explicitly set. This is test-only boilerplate.
  const makeNoObjectError = () =>
    new NoObjectGeneratedError({
      text: '```json\n{"mood": "calm"}\n```',
      response: { id: '', timestamp: new Date(), modelId: '' },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      },
      finishReason: 'stop',
    });

  /**
   * 修复确认：NoObjectGeneratedError 现在被视为 retryable，fallback 会触发。
   * 修复前：isRetryableError(NoObjectGeneratedError) → false → tried=[vertex:...]
   * 修复后：isRetryableError(NoObjectGeneratedError) → true → fallback 模型会被尝试
   */
  it('FIX: NoObjectGeneratedError IS retryable → fallback will trigger', () => {
    const error = makeNoObjectError();
    // 确认它不是 APICallError（HTTP 层面是 200 OK）
    expect(APICallError.isInstance(error)).toBe(false);
    // 修复后：isRetryableError 返回 true → fallback 会触发
    expect(isRetryableError(error)).toBe(true);
  });

  it('NoObjectGeneratedError has no statusCode', () => {
    const error = makeNoObjectError();
    // @ts-expect-error — NoObjectGeneratedError 没有 statusCode
    expect(error.statusCode).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NoOutputGeneratedError —— 与 NoObjectGeneratedError 名字几乎一样，含义完全不同
//
//   NoObjectGeneratedError  模型**生成了文本**但解析不成合法 JSON（带 text/finishReason/usage）
//   NoOutputGeneratedError  **什么都没生成**，`_output == null`（只有 { message?, cause? }）
//
// 生产实况（unee-ai-persona，2026-08/09，24h 内 70 events / 36 users）：
//   [LLM:end]   duration=1989ms, tokens=- (in=0, out=0), cost=$0.000000   ← in=0：provider 返回空壳
//   [LLM:error] No output generated.
//   [LLM:fallback-exhausted] tried=[openrouter:gemini-3.7-flash]          ← 只有主模型，fallback 没跑
//
// `in=0` 连输入 token 都没计 → 不是安全过滤、不是 token 上限、不是模型能力问题，
// 就是 provider 返回了空响应。这是典型的可重试场景，而配好的备用模型一次都没被调用。
// ─────────────────────────────────────────────────────────────────────────────

describe('isRetryableError: NoOutputGeneratedError (provider 返回空壳)', () => {
  it('bare NoOutputGeneratedError IS retryable', () => {
    // 生产命中的是 AI SDK 的零参构造（dist/index.js:6188 `new NoOutputGeneratedError()`），
    // message 取类默认值 "No output generated."，且**不带 cause**。
    const error = new NoOutputGeneratedError();
    expect(NoObjectGeneratedError.isInstance(error)).toBe(false); // 确认与上面那个是两回事
    expect(APICallError.isInstance(error)).toBe(false); // HTTP 层面没有状态码
    expect(isRetryableError(error)).toBe(true);
  });

  /**
   * 关键用例：从**真实调用方形态**测，而不是手搓最小输入。
   *
   * 真实链路是 LLM.classifyError 先把它包成 Oops.Panic：
   *   NoOutputGeneratedError（不是 AbortError/APICallError/NoObjectGeneratedError）
   *     → 落到 classifyError 最后那条 fallback 分支
   *     → Oops.Panic.ExternalService(model, "No output generated.", { cause: error })
   *   withFallback 捕获到的是**这个 Panic**，不是原始 SDK 错误。
   *
   * 所以 isRetryableError 走的是第一个分支（Oops.Panic）→ cause 非空 → 递归进原始错误。
   * 只测裸错误会漏掉「cause 到底传没传」这一环。
   */
  it('production shape: 用 classifyError 真造一个，不手搓', () => {
    // ⚠️ 这里刻意**不**手写 `Oops.Panic.ExternalService(..., { cause })` —— 手搓的包裹层会把
    // 「classifyError 传了 cause」这个假设烤进测试里：哪天有人把兜底分支改成不传 cause，
    // 手搓版照样绿，而生产会静默退回 fallback 不触发。
    // 所以从**真实构造方**造：classifyError 是 generateObjectCore catch 块里实际调用的那个。
    const inner = new NoOutputGeneratedError();
    const wrapped = LLM.classifyError(inner, 'openrouter:gemini-3.7-flash');

    // 先把这条链路本身钉住 —— 下面那句断言的证明力全靠它
    expect(wrapped).toBeInstanceOf(Oops.Panic); // 落到 classifyError 的兜底分支
    expect(wrapped.cause).toBe(inner); // 兜底分支确实透传了 cause
    expect(isRetryableError(wrapped)).toBe(true);
  });

  it('仍然不把普通 Error 判成可重试（防止改动过宽）', () => {
    expect(isRetryableError(new Error('No output generated.'))).toBe(false);
  });
});

describe('isRetryableError: timeout errors', () => {
  it('should be retryable for DOMException TimeoutError', () => {
    const err = new DOMException('timeout', 'TimeoutError');
    expect(isRetryableError(err)).toBe(true);
  });

  it('should be retryable for Error with "timed out" in message', () => {
    expect(isRetryableError(new Error('Request timed out after 30s'))).toBe(true);
  });

  it('should NOT be retryable for generic Error', () => {
    expect(isRetryableError(new Error('something went wrong'))).toBe(false);
  });
});

describe('LLM safe API architecture', () => {
  const originalGenerateTextCore = (LLM as any).generateTextCore;
  const originalGenerateObjectCore = (LLM as any).generateObjectCore;

  const baseTextParams = {
    id: 'llm-test',
    model: 'vertex:gemini-2.5-flash-lite' as const,
    messages: [{ role: 'user' as const, content: 'hello' }],
  };

  const baseObjectParams = {
    ...baseTextParams,
    schema: z.object({ ok: z.boolean() }),
  };

  afterEach(() => {
    (LLM as any).generateTextCore = originalGenerateTextCore;
    (LLM as any).generateObjectCore = originalGenerateObjectCore;
  });

  it('safeGenerateText returns Err(OopsError) instead of rejecting for expected failures', async () => {
    const expected = Oops.Panic.ExternalService('vertex:gemini-2.5-flash-lite', 'timeout', {
      cause: new Error('timeout'),
    });
    (LLM as any).generateTextCore = async () => {
      throw expected;
    };

    const result = await LLM.safeGenerateText(baseTextParams);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBe(expected);
  });

  it('generateText remains a boundary adapter that throws the same OopsError', async () => {
    const expected = Oops.Panic.ExternalService('vertex:gemini-2.5-flash-lite', 'timeout', {
      cause: new Error('timeout'),
    });
    (LLM as any).generateTextCore = async () => {
      throw expected;
    };

    await expect(LLM.generateText(baseTextParams)).rejects.toBe(expected);
  });

  it('safeGenerateObject keeps the actual failed fallback model instead of reclassifying by original spec', async () => {
    const raw = new Error('fallback provider down');
    const actualFailure = LLM.classifyError(raw, 'openrouter:gemini-2.5-flash-lite');
    (LLM as any).generateObjectCore = async () => {
      throw actualFailure;
    };

    const result = await LLM.safeGenerateObject({
      ...baseObjectParams,
      model: 'vertex:gemini-2.5-flash-lite?fallback=openrouter:gemini-2.5-flash-lite',
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr() as OopsError;
    expect(error).toBe(actualFailure);
    expect(error.provider).toBe('openrouter:gemini-2.5-flash-lite');
    expect(error.cause).toBe(raw);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 隐私脱敏不得改变 fallback 判定 —— 否则 privacy-mode 调用会静默退回「只试主模型」，
// 正是上面 NoOutputGeneratedError 那条修复要解决的线上故障（24h 70 events / 36 users）。
// ─────────────────────────────────────────────────────────────────────────────

describe('privateModelError preserves retry and classification semantics', () => {
  const cases: Array<[string, unknown]> = [
    [
      'APICallError 429',
      new APICallError({ message: 'PRIVATE', url: 'https://p/x', requestBodyValues: { PRIVATE: 1 }, statusCode: 429 }),
    ],
    [
      'APICallError 500',
      new APICallError({ message: 'PRIVATE', url: 'https://p/x', requestBodyValues: {}, statusCode: 500 }),
    ],
    [
      'APICallError 400',
      new APICallError({ message: 'PRIVATE', url: 'https://p/x', requestBodyValues: {}, statusCode: 400 }),
    ],
    [
      'APICallError 400 reasoning policy',
      new APICallError({
        message: 'PRIVATE prompt',
        url: 'https://p/x',
        requestBodyValues: {},
        statusCode: 400,
        responseBody: 'reasoning is mandatory for this model',
      }),
    ],
    [
      'NoObjectGeneratedError',
      new NoObjectGeneratedError({
        message: 'PRIVATE',
        text: 'PRIVATE OUTPUT',
        response: { id: 'PRIVATE_ID', timestamp: new Date(), modelId: 'm', headers: { PRIVATE: 'x' } },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        },
        finishReason: 'stop',
      }),
    ],
    ['NoOutputGeneratedError', new NoOutputGeneratedError({ message: 'PRIVATE' })],
    ['timeout wording', new Error('the request timed out after 30s for PRIVATE')],
    ['plain error', new Error('PRIVATE prompt body')],
  ];

  for (const [name, error] of cases) {
    it(`keeps the retry decision and drops the payload for ${name}`, () => {
      const redacted = privateModelError(error);
      expect(isRetryableError(redacted)).toBe(isRetryableError(error));
      expect(redacted.message).not.toContain('PRIVATE');
      expect((redacted as { cause?: unknown }).cause).toBeUndefined();
      expect((redacted as { text?: unknown }).text).toBeUndefined();
    });
  }

  it('keeps the classified error type so logs and fallback agree', () => {
    for (const [, error] of cases) {
      expect(LLM.classifyError(privateModelError(error), 'openrouter:gemini-2.5-flash-lite').constructor).toBe(
        LLM.classifyError(error, 'openrouter:gemini-2.5-flash-lite').constructor,
      );
    }
  });
});
