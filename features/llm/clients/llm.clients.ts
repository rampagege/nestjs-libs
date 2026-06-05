/**
 * 预配置 LLM 客户端单例
 *
 * 设计意图：
 * - 零配置使用，apiKey 和 proxy 全部从 SysEnv 读取
 * - 懒加载，首次使用时才初始化
 * - 直接导出可用的 provider 函数
 *
 * ## 模型选型指南（2026-01）
 *
 * | 场景 | 推荐模型 | 理由 |
 * |------|---------|------|
 * | generateObject 批量输出 | `google('gemini-2.5-flash')` | 原生支持 structured output，thinking tokens 免费 |
 * | 多轮工具编排 | `openrouter('x-ai/grok-4.1-fast')` | 性价比高 $0.20/$0.50/M，2M ctx，tool calling 准确 |
 * | 复杂推理 | `google('gemini-2.5-pro')` | 推理能力强，thinking tokens 免费 |
 * | 大上下文 | `openrouter('x-ai/grok-4.1-fast')` | 2M context window |
 *
 * ## 价格参考（2026-01）
 *
 * | 模型 | Input | Output | 备注 |
 * |------|-------|--------|------|
 * | gemini-2.5-flash | $0.15/M | $0.60/M | thinking tokens 免费 |
 * | gemini-2.5-pro | $1.25/M | $10/M | thinking tokens 免费 |
 * | grok-4.1-fast | $0.20/M | $0.50/M | 2M ctx，性价比之选 |
 * | claude-4-sonnet | $3/M | $15/M | 编码/Agent 能力强 |
 *
 * @example
 * ```typescript
 * import { openrouter, google } from '@app/llm-core';
 * import { streamText, generateObject } from 'ai';
 *
 * // 直接使用，无需任何配置
 * await streamText({
 *   model: openrouter('google/gemini-2.5-flash'),
 *   messages: [...],
 * });
 *
 * await generateObject({
 *   model: google('gemini-2.5-flash'),
 *   schema: MySchema,
 *   messages: [...],
 * });
 * ```
 */

import { SysEnv } from '@app/env';
import { Oops } from '@app/nest/exceptions/oops';
import { getAppLogger } from '@app/utils/app-logger';
import { ApiFetcher } from '@app/utils/fetch';

import '@app/nest/exceptions/oops-factories';

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createVertex } from '@ai-sdk/google-vertex';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

import type { LanguageModel } from 'ai';

// ============================================================================
// 单例缓存
// ============================================================================

let _openrouter: ReturnType<typeof createOpenRouter> | null = null;
let _google: ReturnType<typeof createGoogleGenerativeAI> | null = null;
let _vertex: ReturnType<typeof createVertex> | null = null;
let _vertexGlobal: ReturnType<typeof createVertex> | null = null;
let _openai: ReturnType<typeof createOpenAI> | null = null;

const clientLogger = getAppLogger('features', 'LLM', 'clients');

// ============================================================================
// OpenRouter 客户端
// ============================================================================

/**
 * 获取 OpenRouter 客户端单例
 *
 * 自动使用：
 * - SysEnv.AI_OPENROUTER_API_KEY
 * - ApiFetcher.fetch（带代理）
 */
export function getOpenRouter() {
  if (!_openrouter) {
    const apiKey = SysEnv.AI_OPENROUTER_API_KEY ?? SysEnv.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw Oops.Panic.Config('AI_OPENROUTER_API_KEY is not configured');
    }
    _openrouter = createOpenRouter({
      apiKey,
      fetch: ApiFetcher.fetch,
    });
  }
  return _openrouter;
}

/**
 * OpenRouter 模型选择器
 *
 * @example
 * ```typescript
 * openrouter('google/gemini-2.5-flash')
 * openrouter('anthropic/claude-3.5-sonnet')
 * openrouter('openai/grok-4.1-fast')
 * ```
 */
export const openrouter = (modelId: string): LanguageModel => getOpenRouter()(modelId);

/**
 * OpenRouter 默认 providerOptions（禁用 reasoning/thinking）
 *
 * 默认禁用 reasoning 以节省成本。如需启用，使用 autoOpts.thinking()。
 *
 * @example
 * ```typescript
 * import { openrouter, OPENROUTER_DEFAULTS } from '@app/features/llm';
 *
 * await generateText({
 *   model: openrouter('x-ai/grok-4.1-fast'),
 *   providerOptions: OPENROUTER_DEFAULTS,
 *   // ...
 * });
 * ```
 */
export const OPENROUTER_DEFAULTS = {
  openrouter: { reasoning: { effort: 'none' as const } },
};

// ============================================================================
// Google AI 客户端
// ============================================================================

/**
 * 获取 Google AI 客户端单例
 *
 * 自动使用：
 * - SysEnv.AI_GOOGLE_API_KEY
 * - ApiFetcher.fetch（带代理）
 */
function getGoogle() {
  if (!_google) {
    const apiKey = SysEnv.AI_GOOGLE_API_KEY ?? SysEnv.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey) {
      throw Oops.Panic.Config('AI_GOOGLE_API_KEY is not configured');
    }
    _google = createGoogleGenerativeAI({
      apiKey,
      fetch: ApiFetcher.fetch,
    });
  }
  return _google;
}

/**
 * Google AI 模型选择器
 *
 * @example
 * ```typescript
 * google('gemini-2.5-flash')
 * google('gemini-2.5-pro')
 * google('gemini-2.5-flash-thinking')
 * ```
 */
export const google = (modelId: string): LanguageModel => getGoogle()(modelId);

/**
 * 获取 Google AI Provider 实例（含 tools）
 *
 * 用于需要 provider-defined tools 的场景，如 Google Search Grounding：
 *
 * @example
 * ```typescript
 * import { getGoogleProvider } from '@app/features/llm/clients';
 *
 * const google = getGoogleProvider();
 * const tools = { googleSearch: google.tools.googleSearch({}) };
 * ```
 */
export function getGoogleProvider() {
  return getGoogle();
}

// ============================================================================
// Vertex AI 客户端 (Express Mode)
// ============================================================================

/**
 * 剥离 functionCall.id / functionResponse.id — Vertex (aiplatform.googleapis.com v1)
 * 不接受这两个字段, 会 400 `Unknown name "id" at 'contents[N].parts[0].function_call'`.
 *
 * 背景 (2026-06-05): @ai-sdk/google ≥3.0.7x 在多步 tool calling 的 step-2 请求里
 * 无条件给 functionCall/functionResponse 带 id (Gemini API generativelanguage 端点
 * 支持, Vertex v1 不支持, 上游未做端点区分; 3.0.80 仍未修)。maxSteps 修复
 * (stopWhen 映射) 让 step-2 真正发出后才暴露此 bug — 之前永远单步, 撞不到。
 * 症状: 工具执行成功但流静默结束 (onError 吞 400), 模型永远说不出第二句话。
 */
export function stripVertexFunctionCallIds(body: string): string {
  if (!body.includes('"functionCall"') && !body.includes('"functionResponse"')) return body;
  try {
    const json = JSON.parse(body) as { contents?: Array<{ parts?: Array<Record<string, unknown>> }> };
    for (const content of json.contents ?? []) {
      for (const part of content.parts ?? []) {
        const fc = part.functionCall as Record<string, unknown> | undefined;
        if (fc && typeof fc === 'object') delete fc.id;
        const fr = part.functionResponse as Record<string, unknown> | undefined;
        if (fr && typeof fr === 'object') delete fr.id;
      }
    }
    return JSON.stringify(json);
  } catch {
    return body; // 非 JSON body 原样放行
  }
}

// 类型按 ApiFetcher.fetch 对齐 (bun 的 typeof fetch 要求 preconnect 静态属性, 函数字面量给不了)
const vertexSanitizingFetch = ((input: Parameters<typeof ApiFetcher.fetch>[0], init?: RequestInit) => {
  if (init?.body && typeof init.body === 'string') {
    init = { ...init, body: stripVertexFunctionCallIds(init.body) };
  }
  return ApiFetcher.fetch(input, init);
}) as typeof ApiFetcher.fetch;

/**
 * 获取 Vertex AI 客户端单例 (Express Mode)
 *
 * 自动使用：
 * - SysEnv.AI_GOOGLE_VERTEX_API_KEY
 * - Express Mode（无需 project/location）
 */
function getVertex() {
  if (!_vertex) {
    const apiKey = SysEnv.AI_GOOGLE_VERTEX_API_KEY ?? SysEnv.GOOGLE_VERTEX_API_KEY;
    if (!apiKey) {
      throw Oops.Panic.Config('AI_GOOGLE_VERTEX_API_KEY is not configured');
    }
    clientLogger.info`[vertex:init] mode=express, auth=api-key, baseURL=default-express, project=none, location=none`;
    _vertex = createVertex({
      apiKey,
      fetch: vertexSanitizingFetch, // 剥 functionCall.id (Vertex v1 不认, 见上)
    });
  }
  return _vertex;
}

/**
 * Vertex AI 模型选择器 (Express Mode)
 *
 * @example
 * ```typescript
 * vertex('gemini-2.5-flash')
 * vertex('gemini-2.5-pro')
 * ```
 */
export const vertex = (modelId: string): LanguageModel => getVertex()(modelId);

// ============================================================================
// Vertex AI 客户端 (project/global mode)
// ============================================================================

function getVertexGlobalProject(): string {
  const project = SysEnv.GOOGLE_VERTEX_PROJECT ?? SysEnv.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    throw Oops.Panic.Config('GOOGLE_VERTEX_PROJECT is not configured for vertex-global provider');
  }
  return project;
}

function getVertexGlobalLocation(): 'global' {
  const location = SysEnv.GOOGLE_VERTEX_LOCATION ?? SysEnv.GOOGLE_CLOUD_LOCATION ?? 'global';
  if (location !== 'global') {
    throw Oops.Panic.Config(`vertex-global provider requires GOOGLE_VERTEX_LOCATION=global, got "${location}"`);
  }
  return 'global';
}

/**
 * 获取 Vertex AI project/global 客户端单例
 *
 * 用于 Google Priority PayGo 官方路径：
 * /v1/projects/{project}/locations/global/publishers/google/models/...
 *
 * 注意：
 * - URL 固定为 project/global，不使用 Express Mode URL
 * - 有 Vertex API key 时使用 x-goog-api-key
 * - 没有 API key 时由 ADC / service account / Workload Identity 提供 OAuth
 * - 真实是否命中 Priority/Flex PayGo 以响应 usage.raw.trafficType 为准
 */
function getVertexGlobal() {
  if (!_vertexGlobal) {
    const project = getVertexGlobalProject();
    const location = getVertexGlobalLocation();
    const encodedProject = encodeURIComponent(project);
    const apiKey = SysEnv.AI_GOOGLE_VERTEX_API_KEY ?? SysEnv.GOOGLE_VERTEX_API_KEY;
    const auth = apiKey ? 'api-key' : 'adc-or-service-account';
    const baseURL = `https://aiplatform.googleapis.com/v1/projects/${encodedProject}/locations/${location}/publishers/google`;

    clientLogger.info`[vertex-global:init] mode=project-global, project=${project}, location=${location}, auth=${auth}, baseURL=${baseURL}`;

    _vertexGlobal = createVertex({
      apiKey,
      project,
      location,
      baseURL,
      fetch: vertexSanitizingFetch, // 剥 functionCall.id (Vertex v1 不认, 见上)
    });
  }
  return _vertexGlobal;
}

/**
 * Vertex AI 模型选择器 (project/global mode)
 *
 * @example
 * ```typescript
 * vertexGlobal('gemini-2.5-flash')
 * ```
 */
export const vertexGlobal = (modelId: string): LanguageModel => getVertexGlobal()(modelId);

// ============================================================================
// 客户端状态检查
// ============================================================================

/**
 * 检查 LLM 客户端配置状态
 */
export function getLLMClientStatus() {
  return {
    openrouter: {
      configured: !!(SysEnv.AI_OPENROUTER_API_KEY ?? SysEnv.OPENROUTER_API_KEY),
      initialized: !!_openrouter,
    },
    google: {
      configured: !!(SysEnv.AI_GOOGLE_API_KEY ?? SysEnv.GOOGLE_GENERATIVE_AI_API_KEY),
      initialized: !!_google,
    },
    vertex: {
      configured: !!(SysEnv.AI_GOOGLE_VERTEX_API_KEY ?? SysEnv.GOOGLE_VERTEX_API_KEY),
      initialized: !!_vertex,
    },
    vertexGlobal: {
      configured: !!(SysEnv.GOOGLE_VERTEX_PROJECT ?? SysEnv.GOOGLE_CLOUD_PROJECT),
      initialized: !!_vertexGlobal,
    },

    proxy: {
      enabled: SysEnv.APP_PROXY_ENABLED ?? false,
      host: SysEnv.APP_PROXY_ENABLED ? `${SysEnv.APP_PROXY_HOST}:${SysEnv.APP_PROXY_PORT}` : null,
    },
  };
}

/**
 * 重置客户端（测试用）
 */
export function resetLLMClients() {
  _openrouter = null;
  _google = null;
  _vertex = null;
  _vertexGlobal = null;
  _openai = null;
}

// ============================================================================
// OpenAI 客户端（用于 Embedding）
// ============================================================================

/**
 * 获取 OpenAI 客户端单例
 *
 * 自动使用：
 * - SysEnv.AI_OPENAI_API_KEY
 * - ApiFetcher.fetch（带代理）
 */
export function getOpenAI() {
  if (!_openai) {
    const apiKey = SysEnv.AI_OPENAI_API_KEY ?? SysEnv.OPENAI_API_KEY;
    if (!apiKey) {
      throw Oops.Panic.Config('AI_OPENAI_API_KEY is not configured');
    }
    _openai = createOpenAI({
      apiKey,
      fetch: ApiFetcher.fetch,
    });
  }
  return _openai;
}
