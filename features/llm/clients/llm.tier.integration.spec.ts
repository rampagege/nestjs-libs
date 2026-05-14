/**
 * LLM tier headers → HTTP 集成测试（防 regression guard）
 *
 * 目的：
 * 验证六个 LLM 静态方法（generateObject / generateText / streamText / streamObject /
 * generateObjectViaTool / streamObjectViaTool）在给定带 `?tier=` 的 model spec 时，
 * **最终发出的 HTTP 请求确实带了 Vertex tier / request-type headers**。
 *
 * 实现方式：
 * 直接替换 `ApiFetcher.fetch`（libs 所有 provider client 初始化时传入的自定义 fetch），
 * 捕获 fetch 调用并 assert header。然后 `resetLLMClients()` 强制单例重建，
 * 让下次 `getVertex()` / `getVertexGlobal()` 时用 mock 后的 fetch。
 *
 * 这里主要防止 header 注入回归；`vertex-global` 的 project/global URL 语义由
 * `vertex-global.spec.ts` 单独覆盖。
 *
 * 不关心响应内容 —— 只要 fetch 被调用 + headers 正确即可。
 * AI SDK 可能因为响应不完整抛错，我们 try/catch 吞掉。
 */

import 'reflect-metadata';

import { SysEnv } from '@app/env';
import { ApiFetcher } from '@app/utils/fetch';

import { LLM, VERTEX_REQUEST_TYPE_HEADER, VERTEX_TIER_HEADER } from './llm.class';
import { resetLLMClients } from './llm.clients';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

// 给测试用的假 key 注入到 SysEnv（`SysEnv` 是 plainToInstance 返回的 class 实例，属性可写）
// 必须在 client 第一次被 getVertex/getVertexGlobal/getOpenRouter 触发之前完成
// bun test 每个 spec 文件上下文独立，不需要 afterAll 恢复
const sysEnvMut = SysEnv as unknown as Record<string, string | undefined>;
sysEnvMut.AI_GOOGLE_VERTEX_API_KEY ??= 'test-vertex-key';
sysEnvMut.AI_OPENROUTER_API_KEY ??= 'test-openrouter-key';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
}

let capturedRequests: CapturedRequest[] = [];
const originalFetch = ApiFetcher.fetch;

beforeEach(() => {
  capturedRequests = [];
  // 替换 ApiFetcher.fetch 为 spy fetch，返回一个 404 以让 AI SDK 快速失败
  // 只要能捕获到 headers 就达到目的
  (ApiFetcher as unknown as { fetch: typeof fetch }).fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    capturedRequests.push({
      url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
    });
    // 返回一个最小的 JSON 响应（非 stream），故意让 AI SDK 因内容不符而抛错
    return new Response(JSON.stringify({ error: { code: 400, message: 'mock-fetch' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  resetLLMClients(); // 必须在替换 fetch 之后调用，让下次初始化用 mock 后的 fetch
});

afterEach(() => {
  (ApiFetcher as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  resetLLMClients();
});

// ─────────────────────────────────────────────────────────────────────────
// 辅助：调用任意方法并忽略 AI SDK 错误
// ─────────────────────────────────────────────────────────────────────────

async function callIgnoringError(fn: () => Promise<unknown> | unknown): Promise<void> {
  try {
    const res = fn();
    if (res && typeof (res as Promise<unknown>).then === 'function') {
      await res;
    }
  } catch {
    // 吞掉 —— mock fetch 返回 400 后 AI SDK 会抛错，我们只关心 fetch 捕获到的 headers
  }
}

function assertTierHeader(expected: 'flex' | 'priority', count = 1): void {
  // AI SDK 会因为 mock 响应是 400 触发内部重试；配合 maxRetries=0 应只调一次
  expect(capturedRequests.length).toBeGreaterThanOrEqual(1);
  const first = capturedRequests[0]!;
  expect(first.headers.get(VERTEX_TIER_HEADER)).toBe(expected);
  if (count > 0) {
    expect(first.url).toContain('aiplatform.googleapis.com');
  }
}

function assertVertexRequestTypeHeader(expected: 'shared'): void {
  expect(capturedRequests.length).toBeGreaterThanOrEqual(1);
  const first = capturedRequests[0]!;
  expect(first.headers.get(VERTEX_REQUEST_TYPE_HEADER)).toBe(expected);
}

const SIMPLE_MESSAGE = [{ role: 'user' as const, content: 'test' }];
const SIMPLE_SCHEMA = z.object({ ok: z.boolean() });

// ─────────────────────────────────────────────────────────────────────────
// 六个方法 × tier header 注入
// ─────────────────────────────────────────────────────────────────────────

describe('LLM tier headers: HTTP-level integration (regression guard)', () => {
  it('generateText injects flex header into Vertex HTTP request', async () => {
    await callIgnoringError(() =>
      LLM.generateText({
        id: 'integration-generateText',
        model: 'vertex:gemini-3.1-flash-lite?tier=flex',
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
      }),
    );
    assertTierHeader('flex');
  });

  it('generateObject injects flex header into Vertex HTTP request', async () => {
    await callIgnoringError(() =>
      LLM.generateObject({
        id: 'integration-generateObject',
        model: 'vertex:gemini-3.1-flash-lite?tier=flex',
        messages: SIMPLE_MESSAGE,
        schema: SIMPLE_SCHEMA,
        maxRetries: 0,
      }),
    );
    assertTierHeader('flex');
  });

  it('generateObjectViaTool injects priority header into Vertex HTTP request', async () => {
    await callIgnoringError(() =>
      LLM.generateObjectViaTool({
        id: 'integration-generateObjectViaTool',
        model: 'vertex:gemini-2.5-flash-lite?tier=priority',
        messages: SIMPLE_MESSAGE,
        schema: SIMPLE_SCHEMA,
        maxRetries: 0,
      }),
    );
    assertTierHeader('priority');
  });

  it('streamText injects priority header into Vertex HTTP request', async () => {
    await callIgnoringError(async () => {
      const stream = LLM.streamText({
        id: 'integration-streamText',
        model: 'vertex:gemini-2.5-flash?tier=priority',
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
      });
      // 消费流以触发 fetch
      for await (const _chunk of stream.textStream) {
        // ignore
      }
    });
    assertTierHeader('priority');
  });

  it('streamObject injects flex header into Vertex HTTP request', async () => {
    await callIgnoringError(async () => {
      const stream = LLM.streamObject({
        id: 'integration-streamObject',
        model: 'vertex:gemini-3-flash-preview?tier=flex',
        messages: SIMPLE_MESSAGE,
        schema: SIMPLE_SCHEMA,
        maxRetries: 0,
      });
      for await (const _chunk of stream.textStream) {
        // ignore
      }
    });
    assertTierHeader('flex');
  });

  it('streamObjectViaTool injects flex header into Vertex HTTP request', async () => {
    await callIgnoringError(async () => {
      const gen = LLM.streamObjectViaTool({
        id: 'integration-streamObjectViaTool',
        model: 'vertex:gemini-3.1-flash-lite?tier=flex',
        messages: SIMPLE_MESSAGE,
        schema: SIMPLE_SCHEMA,
        maxRetries: 0,
      });
      for await (const _event of gen) {
        // ignore
      }
    });
    assertTierHeader('flex');
  });

  it('generateText injects Priority-only shared request type headers into Vertex HTTP request', async () => {
    await callIgnoringError(() =>
      LLM.generateText({
        id: 'integration-generateText-priority-only',
        model: 'vertex:gemini-2.5-flash?tier=priority&vertexRequestType=shared',
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
      }),
    );
    assertTierHeader('priority');
    assertVertexRequestTypeHeader('shared');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 降级路径：非 vertex/vertex-global provider 不应带 tier header
// ─────────────────────────────────────────────────────────────────────────

describe('LLM tier headers: downgrade does not send header', () => {
  it('generateText on openrouter with ?tier=flex → no tier header sent', async () => {
    await callIgnoringError(() =>
      LLM.generateText({
        id: 'integration-openrouter-downgrade',
        model: 'openrouter:gemini-2.5-flash?tier=flex' as never,
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
      }),
    );
    expect(capturedRequests.length).toBeGreaterThanOrEqual(1);
    const first = capturedRequests[0]!;
    expect(first.headers.get(VERTEX_TIER_HEADER)).toBeNull();
    expect(first.headers.get(VERTEX_REQUEST_TYPE_HEADER)).toBeNull();
    expect(first.url).toContain('openrouter.ai');
  });

  it('generateText on vertex with unsupported tier combo → no tier header sent', async () => {
    // flex on 2.5-flash-lite: Flex 列表不含此模型
    await callIgnoringError(() =>
      LLM.generateText({
        id: 'integration-vertex-downgrade',
        model: 'vertex:gemini-2.5-flash-lite?tier=flex',
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
      }),
    );
    expect(capturedRequests.length).toBeGreaterThanOrEqual(1);
    const first = capturedRequests[0]!;
    expect(first.headers.get(VERTEX_TIER_HEADER)).toBeNull();
    expect(first.headers.get(VERTEX_REQUEST_TYPE_HEADER)).toBeNull();
    expect(first.url).toContain('aiplatform.googleapis.com');
  });
});
