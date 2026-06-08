/**
 * LLM 统一入口
 *
 * 封装 Vercel AI SDK，提供简洁的静态方法调用：
 * - 使用 LLMModelKey 自动路由到正确的 Provider
 * - thinking 参数控制推理强度（默认关闭）
 * - 统一的错误处理和日志
 *
 * @example
 * ```typescript
 * import { LLM } from '@app/features/llm';
 *
 * const { object } = await LLM.generateObject({
 *   model: 'openrouter:grok-4.1-fast',
 *   schema: MySchema,
 *   system: 'You are...',
 *   messages: [{ role: 'user', content: 'Hello' }],
 * });
 *
 * // 开启 thinking
 * const { object } = await LLM.generateObject({
 *   model: 'openrouter:grok-4.1-fast',
 *   schema: MySchema,
 *   messages,
 *   thinking: 'high',
 * });
 * ```
 */

import { SysEnv } from '@app/env';
import { Oops } from '@app/nest/exceptions/oops';
import { RequestContext } from '@app/nest/trace/request-context';
import { getAppLogger } from '@app/utils/app-logger';
import { ApiFetcher } from '@app/utils/fetch';

import { EMBEDDING_MODELS } from '../types/embedding.types';
import { DEFAULT_SUPPORTED_TIERS, getModel, parseModelSpec } from '../types/model.types';
import { getCostFromUsage } from '../utils/cost-calculator';
import { model as createModel, parseProvider } from './auto.client';
import { getOpenAI, getOpenRouter } from './llm.clients';
import { disableThinkingOptions, reasoningEffortOptions } from './options.helpers';

import { Temporal } from '@js-temporal/polyfill';
import * as Sentry from '@sentry/nestjs';
import {
  APICallError,
  embed,
  extractJsonMiddleware,
  generateText,
  NoObjectGeneratedError,
  Output,
  streamText,
  tool,
  jsonSchema as wrapJsonSchema,
  wrapLanguageModel,
  zodSchema,
} from 'ai';
import { ResultAsync } from 'neverthrow';

import type { EmbeddingModel, EmbeddingModelKey, EmbeddingProvider, EmbeddingTaskType } from '../types/embedding.types';
import type { LLMModelKey, LLMModelSpec, VertexRequestType, VertexTier } from '../types/model.types';
/**
 * 仅对已知会包裹 markdown 代码块的模型启用 extractJsonMiddleware。
 *
 * 背景：
 * Kimi K2.5 在 response_format: json 场景下，偶发返回 ```json ... ```，
 * parseCompleteOutput 期望纯 JSON（以 `{` 开头），会导致 JSON.parse 失败。
 *
 * @see https://ai-sdk.dev/docs/reference/ai-sdk-core/extract-json-middleware
 */
import type { ProviderType } from './options.helpers';
import type { JSONObject } from '@ai-sdk/provider';
import type { OopsError } from '@app/nest/exceptions/oops-error';
import type { LanguageModel, ModelMessage, StopCondition, TelemetrySettings, ToolSet } from 'ai';
import type * as NodeFs from 'node:fs';
import type { z } from 'zod';

/**
 * `buildProviderOptions` 的精确返回类型：仅包含实际使用的 provider 键，
 * 值对齐 AI SDK 的 `JSONObject`，可直接传给 `providerOptions`（即 `SharedV3ProviderOptions = Record<string, JSONObject>`）。
 */
type ProviderOptionsSurface = {
  openrouter?: JSONObject;
  google?: JSONObject;
  vertex?: JSONObject;
};

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** 默认开启 telemetry，OTel exporter 未配置时无副作用 */
const DEFAULT_TELEMETRY: TelemetrySettings = { isEnabled: true };

/** 仅这些模型启用 JSON 代码块剥离中间件 */
const MODELS_NEEDING_EXTRACT_JSON = new Set<LLMModelKey>(['openrouter:kimi-k2.5', 'openrouter:moonshotai/kimi-k2.5']);

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Thinking 强度
 *
 * - none: 关闭推理（默认，适合结构化输出）
 * - low: 轻度推理
 * - medium: 中度推理
 * - high: 深度推理
 */
export type ThinkingEffort = 'none' | 'low' | 'medium' | 'high';

/** 消息格式：支持纯文本和多模态内容（音频、图片等） */
export type Message = ModelMessage;

/** Token 使用量 */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Provider 原始 usage metadata。Vertex project/global 返回的 PayGo 验证字段在
   * `raw.trafficType`，例如 `ON_DEMAND_PRIORITY` / `ON_DEMAND_FLEX` / `ON_DEMAND`。
   */
  raw?: unknown;
}

/** OpenRouter Provider 排序策略 */
export type ProviderSort = 'price' | 'throughput' | 'latency';

/**
 * Web 搜索来源引用
 *
 * 统一了 AI SDK `Source` 类型中 URL 和文档两种变体。
 * 由 provider-defined tools（如 googleSearch、OpenRouter :online）自动返回。
 */
export type WebSource = {
  id: string;
  url: string;
  title?: string;
};

/** 基础参数 */
interface BaseParams {
  /** 业务标识，用于日志中区分调用方（如 'subconscious', 'signal-extractor'） */
  id: string;
  /** LLM Model Spec，如 'openrouter:grok-4.1-fast' 或 'openrouter:grok-4.1-fast?reason=low' */
  model: LLMModelSpec;
  /** System prompt */
  system?: string;
  /** 消息列表 */
  messages: Message[];
  /** Thinking 强度，默认 'none' */
  thinking?: ThinkingEffort;
  /**
   * OpenRouter Provider 排序策略（仅 openrouter 有效）
   * - 'price': 优先最低价格
   * - 'throughput': 优先最高吞吐量
   * - 'latency': 优先最低延迟
   */
  providerSort?: ProviderSort;
  /** 温度 */
  temperature?: number;
  /** 最大输出 token */
  maxOutputTokens?: number;
  /** 中断信号（与 timeout 二选一，abortSignal 优先） */
  abortSignal?: AbortSignal;
  /** 超时时间（毫秒），未传 abortSignal 时生效，默认 60000 */
  timeout?: number;
  /** 最大重试次数（覆盖 spec 和 env 默认值） */
  maxRetries?: number;
  /** Telemetry 配置 */
  telemetry?: TelemetrySettings;
}

/** generateObject 参数 */
interface GenerateObjectParams<T> extends BaseParams {
  /** Zod Schema */
  schema: z.ZodType<T>;
}

/** generateText 参数 */
interface GenerateTextParams extends BaseParams {
  /**
   * 可选工具集（如 provider-defined tools）
   *
   * 用于 Web Search 等场景，模型可在生成文本的同时调用 provider 工具。
   * 工具返回的引用会通过 `sources` 字段传递。
   *
   * @example
   * ```typescript
   * import { getGoogleProvider } from '@app/features/llm/clients';
   * const google = getGoogleProvider();
   *
   * const { text, sources } = await LLM.generateText({
   *   id: 'web-search',
   *   model: 'google:gemini-2.5-flash',
   *   messages,
   *   tools: { googleSearch: google.tools.googleSearch({}) },
   * });
   * ```
   */
  tools?: ToolSet;

  /**
   * Model ID 后缀
   *
   * 拼接到 LLMModelRegistry 中的 modelId 后面，用于 provider 特定功能。
   * 例如 OpenRouter 的 `:online` 搜索插件：
   *
   * model='openrouter:grok-4.1-fast' + modelIdSuffix=':online'
   * → provider 收到 'x-ai/grok-4.1-fast:online'
   */
  modelIdSuffix?: string;
}

/** generateObject 返回值 */
interface GenerateObjectResult<T> {
  object: T;
  usage: TokenUsage;
}

/** generateText 返回值 */
interface GenerateTextResult {
  text: string;
  usage: TokenUsage;
  /**
   * Web 搜索来源引用
   *
   * 当使用 provider-defined web search tools 时（如 OpenRouter :online、@ai-sdk/google googleSearch），
   * AI SDK 自动从 provider 响应中提取 URL 引用。
   *
   * 无 web search 时为空数组。
   */
  sources: WebSource[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Provider Options
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 从 LLMModelSpec 解析出 base key + 合并 thinking
 *
 * spec 里的 `?reason=low` 作为默认值，调用方显式传 `thinking` 时覆盖。
 */
/** resolveSpec 返回值 */
interface ResolvedSpec {
  key: LLMModelKey;
  thinking: ThinkingEffort;
  maxRetries: number;
  timeout: number;
  fallbackModels: LLMModelKey[];
  /** 请求 tier（仅 vertex / vertex-global provider 会发送 header） */
  tier: VertexTier | undefined;
  /** Vertex request type（仅 vertex / vertex-global + tier=flex/priority 时生效） */
  vertexRequestType: VertexRequestType | undefined;
}

const specLogger = getAppLogger('features', 'LLM', 'spec');

/**
 * 从 LLMModelSpec 解析出完整运行时参数
 *
 * 优先级：caller 显式参数 > spec 参数 > env 默认值
 */
function resolveSpec(
  modelSpec: LLMModelSpec,
  callerThinking: ThinkingEffort,
  callerMaxRetries: number | undefined,
  callerTimeout: number | undefined,
): ResolvedSpec {
  const parsed = parseModelSpec(modelSpec);
  // 调用方显式传了非 'none' 的 thinking → 用调用方的
  // 调用方用默认 'none' 且 spec 有 reason → 用 spec 的
  const thinking = callerThinking !== 'none' ? callerThinking : (parsed.thinking ?? 'none');
  const maxRetries = callerMaxRetries ?? parsed.maxRetries ?? SysEnv.AI_LLM_MAX_RETRIES;
  const timeout = callerTimeout ?? parsed.timeout ?? SysEnv.AI_LLM_TIMEOUT_MS;
  const fallbackModels = parsed.fallbackModels;
  const tier = parsed.tier;
  const vertexRequestType = parsed.vertexRequestType;

  // 有非默认参数时打印生效值，方便排查
  const hasSpecParams =
    parsed.thinking !== undefined ||
    parsed.maxRetries !== undefined ||
    parsed.timeout !== undefined ||
    fallbackModels.length > 0 ||
    tier !== undefined ||
    vertexRequestType !== undefined;
  if (hasSpecParams) {
    const parts: string[] = [];
    if (thinking !== 'none') parts.push(`thinking=${thinking}`);
    parts.push(`retry=${maxRetries}`);
    parts.push(`timeout=${timeout}ms`);
    if (fallbackModels.length > 0) parts.push(`fallback=[${fallbackModels.join(',')}]`);
    if (tier !== undefined) parts.push(`tier=${tier}`);
    if (vertexRequestType !== undefined) parts.push(`vertexRequestType=${vertexRequestType}`);
    specLogger.info`[resolveSpec] ${parsed.key} → ${parts.join(', ')}`;
  }

  return { key: parsed.key, thinking, maxRetries, timeout, fallbackModels, tier, vertexRequestType };
}

/**
 * 根据 Provider 和 thinking 强度生成 providerOptions
 *
 * reasoningRequired 模型（如 MiniMax M2.5、Grok 4.1 Fast）：
 * thinking='none' 时不发送 disableThinking，避免 400 错误。
 */
function buildProviderOptions(
  provider: ProviderType,
  thinking: ThinkingEffort,
  modelKey: LLMModelKey,
  providerSort?: ProviderSort,
): ProviderOptionsSurface {
  const modelConfig = getModel(modelKey);
  const thinkingOptions: ProviderOptionsSurface =
    thinking === 'none'
      ? modelConfig.reasoningRequired
        ? {}
        : disableThinkingOptions(provider)
      : reasoningEffortOptions(provider, thinking);

  // 只有 openrouter 支持 providerSort
  if (provider === 'openrouter' && providerSort) {
    return {
      openrouter: {
        ...thinkingOptions.openrouter,
        provider: { sort: providerSort },
      },
    };
  }

  return thinkingOptions;
}

/** 导出给测试文件共享同一真相源 */
export const VERTEX_TIER_HEADER = 'X-Vertex-AI-LLM-Shared-Request-Type';
export const VERTEX_REQUEST_TYPE_HEADER = 'X-Vertex-AI-LLM-Request-Type';

const tierLogger = getAppLogger('features', 'LLM', 'tier');

/**
 * 四种情况的行为契约：
 * - `undefined` / `standard`：不发 header，返回 undefined
 * - 非 vertex / vertex-global provider：warn + 降级
 * - 模型不支持该 tier：warn + 降级
 * - 支持：info 日志 + 返回 header 对象
 *
 * 导出仅供单元测试；运行时视为模块内部 API。
 *
 * @see https://docs.cloud.google.com/vertex-ai/generative-ai/docs/flex-paygo
 * @see https://docs.cloud.google.com/vertex-ai/generative-ai/docs/priority-paygo
 */
export function buildTierHeaders(
  modelKey: LLMModelKey,
  tier: VertexTier | undefined,
  vertexRequestType?: VertexRequestType,
): Record<string, string> | undefined {
  if (!tier || tier === 'standard') {
    if (vertexRequestType) {
      tierLogger.warning`[buildTierHeaders] vertexRequestType=${vertexRequestType} requires tier=flex|priority (model=${modelKey}), ignoring`;
    }
    return undefined;
  }

  const config = getModel(modelKey);
  if (config.provider !== 'vertex' && config.provider !== 'vertex-global') {
    tierLogger.warning`[buildTierHeaders] tier=${tier} requested for non-vertex provider=${config.provider} (model=${modelKey}), ignoring`;
    return undefined;
  }

  // 直接用已获取的 config 读 supportedTiers，避免 getSupportedTiers 再次查 registry
  const supported = config.supportedTiers ?? DEFAULT_SUPPORTED_TIERS;
  if (!supported.includes(tier)) {
    tierLogger.warning`[buildTierHeaders] tier=${tier} not supported for model=${modelKey}, falling back to standard. supported=[${supported.join(',')}]`;
    return undefined;
  }

  const requestTypePart = vertexRequestType ? `, requestType=${vertexRequestType}` : ', requestType=default';
  tierLogger.info`[buildTierHeaders] provider=${config.provider}, tier=${tier}${requestTypePart} applied for model=${modelKey}; verify actual routing via usage.raw.trafficType`;
  return {
    ...(vertexRequestType ? { [VERTEX_REQUEST_TYPE_HEADER]: vertexRequestType } : {}),
    [VERTEX_TIER_HEADER]: tier,
  };
}

function extractTrafficType(usage: TokenUsage): string | undefined {
  const raw = usage.raw;
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const value = record.trafficType ?? record.traffic_type;
  return typeof value === 'string' ? value : undefined;
}

function formatTierLogPart(tier?: VertexTier, vertexRequestType?: VertexRequestType): string {
  if (!tier || tier === 'standard') return '';
  const requestTypePart = vertexRequestType ? `, vertexRequestType=${vertexRequestType}` : '';
  return `, vertexTier=${tier}${requestTypePart}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Timeout Helper
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 将 timeout + abortSignal 合并为单一 AbortSignal，自管理生命周期
 *
 * 为什么不直接传 timeout 给 AI SDK：
 * AI SDK 内部用 AbortSignal.timeout() 实现超时，但超时后 DOMException
 * 会作为 unhandledRejection 浮出（SDK 内部 promise 链未完全处理 abort）。
 * 用 setTimeout + AbortController 替代，我们控制 abort 时机，
 * 不会产生浮动的 DOMException。
 */
function createManagedSignal(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
  }, timeoutMs);

  // 外部信号取消时，同步 abort
  let callerHandler: (() => void) | undefined;
  if (callerSignal) {
    if (callerSignal.aborted) {
      clearTimeout(timer);
      controller.abort(callerSignal.reason);
    } else {
      callerHandler = () => {
        clearTimeout(timer);
        controller.abort(callerSignal.reason);
      };
      callerSignal.addEventListener('abort', callerHandler, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (callerHandler && callerSignal) {
        callerSignal.removeEventListener('abort', callerHandler);
      }
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Retry & Fallback
// ═══════════════════════════════════════════════════════════════════════════

const fallbackLogger = getAppLogger('features', 'LLM', 'fallback');

/** 判断错误是否值得 fallback（429/5xx/timeout/生成失败），非 retryable 的直接抛 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof Oops || error instanceof Oops.Block || error instanceof Oops.Panic) {
    const cause = error.cause;
    if (cause !== undefined) return isRetryableError(cause);
    return error instanceof Oops.Block && error.httpStatus === 429;
  }
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    return status === 429 || (status !== undefined && status >= 500);
  }
  // NoObjectGeneratedError：模型生成了文本但无法解析为合法 JSON。
  // HTTP 层面是 200 OK，但实际上是模型能力或格式问题，应 fallback 到其他模型重试。
  if (NoObjectGeneratedError.isInstance(error)) return true;
  if (error instanceof DOMException && error.name === 'TimeoutError') return true;
  if (error instanceof Error && error.message.includes('timed out')) return true;
  return false;
}

/** Fallback attempt metadata, passed to execute callbacks for logging */
interface FallbackAttempt {
  /** 1-based attempt number */
  attempt: number;
  /** total number of models in the chain */
  total: number;
}

/**
 * 带 fallback 的执行器（仅用于 generate* 等 async 方法）
 *
 * 主模型重试耗尽后，依次尝试 fallback 模型。
 * 每个 fallback 模型同样使用 spec 的 retry/timeout 配置。
 */
async function withFallback<T>(
  id: string,
  method: string,
  spec: ResolvedSpec,
  execute: (modelKey: LLMModelKey, fb: FallbackAttempt) => Promise<T>,
): Promise<T> {
  const allModels = [spec.key, ...spec.fallbackModels];
  const total = allModels.length;
  let lastError: unknown;
  for (const [i, modelKey] of allModels.entries()) {
    const fb: FallbackAttempt = { attempt: i + 1, total };
    try {
      const result = await execute(modelKey, fb);
      if (i > 0) {
        fallbackLogger.info`[LLM:fallback-ok] id=${id}, method=${method}, succeeded=${modelKey}, attempt=${i + 1}/${total}, tried=[${allModels.slice(0, i + 1).join(',')}]`;
      }
      return result;
    } catch (error) {
      lastError = error;
      const isLast = i === allModels.length - 1;
      if (isLast || !isRetryableError(error)) {
        if (total > 1) {
          fallbackLogger.error`[LLM:fallback-exhausted] id=${id}, method=${method}, attempt=${i + 1}/${total}, tried=[${allModels.slice(0, i + 1).join(',')}]`;
        }
        throw error;
      }
      const nextModel = allModels.at(i + 1);
      const msg = error instanceof Error ? error.message : String(error);
      fallbackLogger.warning`[LLM:fallback] id=${id}, method=${method}, model=${modelKey} failed: ${msg}. Trying ${nextModel ?? 'none'}`;
    }
  }
  throw lastError;
}

// ═══════════════════════════════════════════════════════════════════════════
// LLM Class
// ═══════════════════════════════════════════════════════════════════════════

export class LLM {
  private static readonly logger = getAppLogger('features', 'LLM');

  // ─────────────────────────────────────────────────────────────────────────
  // Logging Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private static logStart(
    id: string,
    method: string,
    modelKey: string,
    thinking?: ThinkingEffort,
    fb?: FallbackAttempt,
    tier?: VertexTier,
    vertexRequestType?: VertexRequestType,
  ): void {
    const thinkingPart = thinking && thinking !== 'none' ? `, thinking=${thinking}` : '';
    const fbPart = fb && fb.total > 1 ? `, attempt=${fb.attempt}/${fb.total}` : '';
    const tierPart = formatTierLogPart(tier, vertexRequestType);
    LLM.logger.info`[LLM:start] id=${id}, method=${method}, model=${modelKey}${thinkingPart}${tierPart}${fbPart}`;
  }

  /**
   * CLI 模式下自动保存 LLM 完整请求到文件
   *
   * 包含重放所需的一切：system prompt、messages、完整 JSON Schema、model。
   * 任何项目都能用 `LLM.replayFromFile()` 重放，不需要项目代码。
   *
   * 保存路径：/tmp/llm-{id}.request.json
   */
  private static captureRequest(
    id: string,
    method: string,
    modelKey: string,
    schema: z.ZodType,
    messages: Message[],
    system?: string,
    extra?: Record<string, unknown>,
  ): void {
    if (!SysEnv.isCliMode) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs') as typeof NodeFs;
      const jsonSchemaObj = zodSchema(schema).jsonSchema;
      const path = `/tmp/llm-${id}.request.json`;
      fs.writeFileSync(
        path,
        JSON.stringify(
          {
            id,
            method,
            model: modelKey,
            system,
            messages,
            jsonSchema: jsonSchemaObj,
            ...extra,
            capturedAt: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' }),
          },
          null,
          2,
        ),
      );
      LLM.logger.info`[LLM:capture] ${path}`;
    } catch {
      // capture 失败不影响主流程
    }
  }

  /**
   * 从 capture 文件重放 LLM 请求
   *
   * 跨项目通用：读文件 → 用 jsonSchema 包装 → 调 LLM → 返回结果。
   * 不依赖任何项目代码，不需要 Zod schema。
   */
  static async replayFromFile(filePath: string): Promise<{ output: unknown; usage: unknown }> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof NodeFs;

    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    const { id, method, model: modelKey, system, messages, jsonSchema: schemaObj, toolName, toolDescription } = data;

    LLM.logger.info`[LLM:replay] id=${id}, method=${method}, model=${modelKey}`;

    const schema = wrapJsonSchema(schemaObj as Record<string, unknown>);
    const languageModel = createModel(modelKey as LLMModelKey);
    const startTime = Date.now();

    let output: unknown;
    let usage: unknown;

    if (method === 'generateObject' || method === 'streamObject') {
      // streamObject/generateObject 都走 Output.object（replay 不需要流式）
      const result = await generateText({
        model: languageModel,
        output: Output.object({ schema }),
        system: system as string,
        messages: messages as Message[],
      });

      const duration = Date.now() - startTime;
      const cost = getCostFromUsage(result.usage, modelKey as string);
      LLM.logger
        .info`[LLM:replay:end] duration=${duration}ms, tokens=${result.usage.totalTokens ?? '-'}, cost=${cost !== null ? `$${cost.toFixed(6)}` : 'N/A'}`;

      output = result.output;
      usage = { ...result.usage, cost };
    } else if (method === 'generateObjectViaTool' || method === 'streamObjectViaTool') {
      const tName = (toolName ?? 'extract') as string;
      const tools = {
        [tName]: tool({
          description: (toolDescription ?? 'Extract structured data') as string,
          inputSchema: schema,
        }),
      };
      const result = await generateText({
        model: languageModel,
        system: system as string,
        messages: messages as Message[],
        tools,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toolChoice: { type: 'tool' as const, toolName: tName } as any,
      });

      const duration = Date.now() - startTime;
      const cost = getCostFromUsage(result.usage, modelKey as string);
      LLM.logger
        .info`[LLM:replay:end] duration=${duration}ms, tokens=${result.usage.totalTokens ?? '-'}, cost=${cost !== null ? `$${cost.toFixed(6)}` : 'N/A'}`;

      const toolCall = result.toolCalls.at(0);
      if (!toolCall || !('input' in toolCall)) {
        throw new Error('No tool call returned from LLM replay');
      }
      output = toolCall.input;
      usage = { ...result.usage, cost };
    } else {
      throw new Error(`Unsupported method for replay: ${method as string}`);
    }

    return { output, usage };
  }

  /**
   * Schema keys + messages 摘要日志
   *
   * 帮助排查"空 schema"等结构性问题，不需要开 Proxyman。
   */
  private static logInputSummary(id: string, schema: z.ZodType, messages: Message[], system?: string): void {
    // schema top-level keys（不依赖 z 运行时，直接检查 shape 属性）
    const schemaKeys =
      'shape' in schema && typeof schema.shape === 'object' && schema.shape !== null
        ? Object.keys(schema.shape)
        : ['(non-object schema)'];

    // messages 摘要：role + content 长度
    const msgSummary = messages
      .map((m) => {
        const len = typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
        return `${m.role}:${len}`;
      })
      .join(', ');

    const systemPart = system ? `, system=${system.length}ch` : '';

    LLM.logger.debug`[LLM:input] id=${id}, schema=[${schemaKeys.join(',')}], messages=[${msgSummary}]${systemPart}`;
  }

  private static logEnd(
    id: string,
    method: string,
    modelKey: string,
    startTime: number,
    usage: TokenUsage,
    fb?: FallbackAttempt,
    tier?: VertexTier,
    vertexRequestType?: VertexRequestType,
  ): void {
    const duration = Date.now() - startTime;
    const inputTokens = usage.inputTokens ?? usage.promptTokens ?? 0;
    const outputTokens = usage.outputTokens ?? usage.completionTokens ?? 0;
    const totalTokens = inputTokens + outputTokens;
    const cost = getCostFromUsage(usage, modelKey);
    const costStr = cost !== null ? `, cost=$${cost.toFixed(6)}` : '';
    const fbPart = fb && fb.total > 1 ? `, attempt=${fb.attempt}/${fb.total}` : '';
    const trafficType = extractTrafficType(usage);
    const trafficPart = trafficType ? `, trafficType=${trafficType}` : '';
    const tierPart = formatTierLogPart(tier, vertexRequestType);
    LLM.logger
      .info`[LLM:end] id=${id}, method=${method}, model=${modelKey}${tierPart}, duration=${duration}ms, tokens=${totalTokens || '-'} (in=${inputTokens}, out=${outputTokens})${costStr}${fbPart}${trafficPart}`;
  }

  private static logTTFT(id: string, startTime: number): void {
    const ttft = Date.now() - startTime;
    LLM.logger.debug`[LLM:ttft] id=${id}, ttft=${ttft}ms`;
  }

  /**
   * 统一错误处理：NestJS logger + Sentry
   *
   * AI SDK 默认 onError 会裸 console.error(error)，被 Sentry console integration
   * 拦截后变成 [object Object]。这里统一收归，确保：
   * 1. NestJS logger → Loki 可查
   * 2. Sentry.captureException → 结构化上报，附带 id/method/model 上下文
   */
  private static logError(id: string, method: string, modelKey: string, error: unknown): void {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    const providerData =
      APICallError.isInstance(error) && error.data != null
        ? (error.data as { code?: number; metadata?: unknown })
        : undefined;
    const extra = providerData ? ` providerData=${JSON.stringify(providerData)}` : '';
    LLM.logger.error`[LLM:error] id=${id}, method=${method}, model=${modelKey}: ${message}${extra} ${error}`;

    // Log raw model output for object generation failures — empty/invalid responses are hard to debug otherwise
    if (NoObjectGeneratedError.isInstance(error)) {
      const rawText = error.text;
      LLM.logger
        .warn`[LLM:no-object] id=${id}, finishReason=${error.finishReason ?? 'unknown'}, rawText=${rawText !== undefined ? JSON.stringify(rawText) : '(missing)'}`;
    }

    Sentry.withScope((scope) => {
      const userId = RequestContext.get<string>('userId');
      if (userId) scope.setUser({ id: userId });
      scope.setTag('llm.id', id);
      scope.setTag('llm.method', method);
      scope.setTag('llm.model', modelKey);
      scope.setContext('llm', {
        id,
        method,
        model: modelKey,
        ...(providerData && { providerError: providerData }),
      });
      Sentry.captureException(error instanceof Error ? error : new Error(message));
    });
  }

  private static toResult<T>(promise: Promise<T>, modelSpec: LLMModelKey | LLMModelSpec): ResultAsync<T, OopsError> {
    return ResultAsync.fromPromise(promise, (error: unknown) => LLM.classifyError(error, modelSpec));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Generation Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 结构化对象生成（Promise 版，throws on error）
   *
   * @deprecated 使用 `safeGenerateObject`（返回 ResultAsync）替代。
   *
   * 迁移：
   * ```typescript
   * // before
   * const { object } = await LLM.generateObject({...});
   *
   * // after — 链式传播（推荐）
   * return LLM.safeGenerateObject({...}).map(({ object }) => object);
   *
   * // after — 降级
   * const value = await LLM.safeGenerateObject({...}).unwrapOr(fallback);
   *
   * // after — 边界处转 throw
   * const result = await LLM.safeGenerateObject({...});
   * result.match(v => v, e => { throw e; });
   * ```
   *
   * 最终目标：删除此方法，`safeGenerateObject` rename 为 `generateObject`。
   * @see neverthrow-result-pattern skill
   */
  private static async generateObjectCore<T>(params: GenerateObjectParams<T>): Promise<GenerateObjectResult<T>> {
    const {
      model: modelSpec,
      id,
      schema,
      system,
      messages,
      thinking: callerThinking = 'none',
      providerSort,
      temperature,
      maxOutputTokens,
      abortSignal,
      timeout: callerTimeout,
      maxRetries: callerMaxRetries,
      telemetry = DEFAULT_TELEMETRY,
    } = params;

    const spec = resolveSpec(modelSpec, callerThinking, callerMaxRetries, callerTimeout);

    return withFallback(id, 'generateObject', spec, async (modelKey, fb) => {
      const startTime = Date.now();
      LLM.logStart(id, 'generateObject', modelKey, spec.thinking, fb, spec.tier, spec.vertexRequestType);
      LLM.logInputSummary(id, schema, messages, system);
      LLM.captureRequest(id, 'generateObject', modelKey, schema, messages, system);

      const languageModel = createModel(modelKey);
      const provider = parseProvider(modelKey);
      const providerOptions = buildProviderOptions(provider, spec.thinking, modelKey, providerSort);
      const tierHeaders = buildTierHeaders(modelKey, spec.tier, spec.vertexRequestType);

      const { signal, cleanup } = createManagedSignal(spec.timeout, abortSignal);

      try {
        const result = await generateText({
          model: languageModel,
          output: Output.object({ schema }),
          system,
          messages,
          providerOptions,
          headers: tierHeaders,
          temperature,
          maxOutputTokens,
          maxRetries: spec.maxRetries,
          abortSignal: signal,
          experimental_telemetry: telemetry,
        });

        cleanup();
        LLM.logEnd(id, 'generateObject', modelKey, startTime, result.usage, fb, spec.tier, spec.vertexRequestType);

        return {
          object: result.output,
          usage: result.usage,
        };
      } catch (error) {
        cleanup();
        const classified = LLM.classifyError(error, modelKey);
        LLM.logError(id, 'generateObject', modelKey, classified);
        throw classified;
      }
    });
  }

  /**
   * generateObject 的 Result 包装版
   *
   * 返回 ResultAsync<T, OopsError>，调用方可 `.unwrapOr(fallback)` 降级。
   * 错误自动分类为 Oops 业务异常（rate limit / API error / object generation failed）。
   *
   * @example
   * ```typescript
   * const result = await LLM.safeGenerateObject({ ... })
   *   .orTee(e => logger.warn(e.getInternalDetails()));
   * return result.unwrapOr(fallback);
   * ```
   */
  static safeGenerateObject<T>(params: GenerateObjectParams<T>): ResultAsync<GenerateObjectResult<T>, OopsError> {
    return LLM.toResult(LLM.generateObjectCore(params), params.model);
  }

  /**
   * 结构化对象生成（边界适配层）
   *
   * 内部实现统一走 `safeGenerateObject`，这里只在边界处将 Err(OopsError) 转为 throw。
   *
   * @deprecated 使用 `safeGenerateObject`（返回 ResultAsync）替代。
   */
  static async generateObject<T>(params: GenerateObjectParams<T>): Promise<GenerateObjectResult<T>> {
    return (await LLM.safeGenerateObject(params)).match(
      (value) => value,
      (error) => {
        throw error;
      },
    );
  }

  /**
   * generateObjectViaTool 的 Result 包装版
   */
  static safeGenerateObjectViaTool<T>(
    params: GenerateObjectParams<T> & { toolName?: string; toolDescription?: string; parallelToolCalls?: boolean },
  ): ResultAsync<GenerateObjectResult<T>, OopsError> {
    return LLM.toResult(LLM.generateObjectViaToolCore(params), params.model);
  }

  /**
   * 通过 Tool Calling 生成结构化对象（边界适配层）
   *
   * 内部实现统一走 `safeGenerateObjectViaTool`，这里只在边界处将 Err(OopsError) 转为 throw。
   *
   * @deprecated 使用 `safeGenerateObjectViaTool`（返回 ResultAsync）替代。
   */
  static async generateObjectViaTool<T>(
    params: GenerateObjectParams<T> & {
      toolName?: string;
      toolDescription?: string;
      parallelToolCalls?: boolean;
    },
  ): Promise<GenerateObjectResult<T>> {
    return (await LLM.safeGenerateObjectViaTool(params)).match(
      (value) => value,
      (error) => {
        throw error;
      },
    );
  }

  /**
   * generateText 的 Result 包装版
   */
  static safeGenerateText(params: GenerateTextParams): ResultAsync<GenerateTextResult, OopsError> {
    return LLM.toResult(LLM.generateTextCore(params), params.model);
  }

  /**
   * 文本生成（边界适配层）
   *
   * 内部实现统一走 `safeGenerateText`，这里只在边界处将 Err(OopsError) 转为 throw。
   */
  static async generateText(params: GenerateTextParams): Promise<GenerateTextResult> {
    return (await LLM.safeGenerateText(params)).match(
      (value) => value,
      (error) => {
        throw error;
      },
    );
  }

  /**
   * 将 unknown 错误分类为 OopsError
   *
   * AI SDK 错误 → 结构化业务异常：
   * - APICallError 429 → Oops.Block.AIModelRateLimited
   * - APICallError other → Oops.Panic.AIModelError
   * - NoObjectGeneratedError → Oops.Panic.AIObjectGenerationFailed
   * - Timeout → Oops.Panic.AIModelError
   * - 其他 → Oops.Panic.ExternalService
   */
  static classifyError(error: unknown, modelSpec: LLMModelKey | LLMModelSpec): OopsError {
    const model = modelSpec.split('?').at(0) ?? 'unknown';

    if (error instanceof Oops || error instanceof Oops.Block || error instanceof Oops.Panic) {
      return error;
    }

    if (!(error instanceof Error)) {
      return Oops.Panic.ExternalService(model, `Non-Error thrown: ${String(error)}`, { cause: error });
    }

    // Timeout
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return Oops.Panic.AIModelError(model, `Timeout: ${error.message}`, { cause: error });
    }

    // API 调用错误（网络、限流、服务端）
    if (APICallError.isInstance(error)) {
      if (error.statusCode === 429) {
        return Oops.Block.AIModelRateLimited(model, { cause: error });
      }
      return Oops.Panic.AIModelError(model, error.message, { cause: error });
    }

    // 结构化输出生成失败（调用成功但输出不可用）
    if (NoObjectGeneratedError.isInstance(error)) {
      return Oops.Panic.AIObjectGenerationFailed(model, error.finishReason ?? 'unknown', error.text, { cause: error });
    }

    // Fallback
    return Oops.Panic.ExternalService(model, error.message, { cause: error });
  }

  /**
   * 文本生成
   *
   * @example
   * ```typescript
   * const { text } = await LLM.generateText({
   *   model: 'openrouter:grok-4.1-fast',
   *   messages: [{ role: 'user', content: 'Hello' }],
   * });
   * ```
   */
  private static async generateTextCore(params: GenerateTextParams): Promise<GenerateTextResult> {
    const {
      model: modelSpec,
      id,
      system,
      messages,
      thinking: callerThinking = 'none',
      providerSort,
      temperature,
      maxOutputTokens,
      abortSignal,
      timeout: callerTimeout,
      maxRetries: callerMaxRetries,
      telemetry = DEFAULT_TELEMETRY,
      tools,
      modelIdSuffix,
    } = params;

    const spec = resolveSpec(modelSpec, callerThinking, callerMaxRetries, callerTimeout);

    return withFallback(id, 'generateText', spec, async (modelKey, fb) => {
      const startTime = Date.now();
      LLM.logStart(id, 'generateText', modelKey, spec.thinking, fb, spec.tier, spec.vertexRequestType);

      const languageModel = createModel(modelKey, modelIdSuffix);
      const provider = parseProvider(modelKey);
      const providerOptions = buildProviderOptions(provider, spec.thinking, modelKey, providerSort);
      const tierHeaders = buildTierHeaders(modelKey, spec.tier, spec.vertexRequestType);

      const { signal, cleanup } = createManagedSignal(spec.timeout, abortSignal);

      try {
        const result = await generateText({
          model: languageModel,
          system,
          messages,
          tools,
          providerOptions,
          headers: tierHeaders,
          temperature,
          maxOutputTokens,
          maxRetries: spec.maxRetries,
          abortSignal: signal,
          experimental_telemetry: telemetry,
        });

        cleanup();

        const sourcesCount = result.sources.length;
        if (sourcesCount > 0) {
          LLM.logger.debug`[LLM:sources] id=${id}, sources=${sourcesCount}`;
        }

        LLM.logEnd(id, 'generateText', modelKey, startTime, result.usage, fb, spec.tier, spec.vertexRequestType);

        return {
          text: result.text,
          usage: result.usage,
          sources: extractWebSources(result.sources),
        };
      } catch (error) {
        cleanup();
        const classified = LLM.classifyError(error, modelKey);
        LLM.logError(id, 'generateText', modelKey, classified);
        throw classified;
      }
    });
  }

  /**
   * 流式结构化对象生成
   *
   * 对白名单模型（当前仅 Kimi）应用 extractJsonMiddleware，其他模型保持原始逻辑。
   * 见 MODELS_NEEDING_EXTRACT_JSON。
   *
   * @example
   * ```typescript
   * const stream = LLM.streamObject({
   *   model: 'openrouter:grok-4.1-fast',
   *   schema: MySchema,
   *   messages,
   * });
   *
   * for await (const chunk of stream.partialObjectStream) {
   *   console.log(chunk);
   * }
   * ```
   */
  static streamObject<T>(
    params: GenerateObjectParams<T> & {
      /** 可选的工具集，模型可在生成结构化输出的同时调用这些工具 */
      tools?: ToolSet;
      /**
       * 多步工具调用的停止条件
       *
       * 当传入 tools 时，模型可能先调用工具再生成最终输出，需要多步。
       * 默认 stepCountIs(1)（只运行 1 步，工具结果不会回传给模型）。
       *
       * 推荐：有 tools 时设为 stepCountIs(3) 或更高。
       *
       * @default stepCountIs(1)
       */
      stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;
    },
  ) {
    const startTime = Date.now();
    const {
      model: modelSpec,
      id,
      schema,
      system,
      messages,
      thinking: callerThinking = 'none',
      providerSort,
      temperature,
      maxOutputTokens,
      abortSignal,
      timeout: callerTimeout,
      maxRetries: callerMaxRetries,
      telemetry = DEFAULT_TELEMETRY,
      tools,
      stopWhen,
    } = params;

    const spec = resolveSpec(modelSpec, callerThinking, callerMaxRetries, callerTimeout);
    const { key: modelKey } = spec;
    if (spec.fallbackModels.length > 0) {
      fallbackLogger.warning`[LLM:fallback-ignored] id=${id}, method=streamObject — stream methods do not support fallback, only primary model=${modelKey} will be used. fallback=[${spec.fallbackModels.join(',')}]`;
    }
    LLM.logStart(id, 'streamObject', modelKey, spec.thinking, undefined, spec.tier, spec.vertexRequestType);
    LLM.logInputSummary(id, schema, messages, system);
    LLM.captureRequest(id, 'streamObject', modelKey, schema, messages, system);

    const languageModel = createModel(modelKey);
    const model: LanguageModel = MODELS_NEEDING_EXTRACT_JSON.has(modelKey)
      ? wrapLanguageModel({
          model: languageModel as Parameters<typeof wrapLanguageModel>[0]['model'],
          middleware: extractJsonMiddleware({
            transform: (text) => {
              const trimmed = text.trim();
              // 剥离 ```json 或 ``` 包裹；无闭合时仅剥离开头
              const jsonMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
              if (jsonMatch?.[1]) return jsonMatch[1].trim();
              if (trimmed.startsWith('```')) return trimmed.replace(/^```(?:json)?\s*\n?/, '').trim();
              return trimmed;
            },
          }),
        })
      : languageModel;

    const provider = parseProvider(modelKey);
    const providerOptions = buildProviderOptions(provider, spec.thinking, modelKey, providerSort);
    const tierHeaders = buildTierHeaders(modelKey, spec.tier, spec.vertexRequestType);

    const { signal, cleanup } = createManagedSignal(spec.timeout, abortSignal);

    let ttftLogged = false;

    const result = streamText({
      model,
      output: Output.object({ schema }),
      system,
      messages,
      tools,
      stopWhen,
      providerOptions,
      headers: tierHeaders,
      temperature,
      maxOutputTokens,
      maxRetries: spec.maxRetries,
      abortSignal: signal,
      experimental_telemetry: telemetry,
      onError: ({ error }) => {
        cleanup();
        LLM.logError(id, 'streamObject', modelKey, error);
      },
      onChunk() {
        if (!ttftLogged) {
          LLM.logTTFT(id, startTime);
          ttftLogged = true;
        }
      },
      onFinish(event) {
        cleanup();
        LLM.logEnd(id, 'streamObject', modelKey, startTime, event.usage, undefined, spec.tier, spec.vertexRequestType);
      },
    });

    return result;
  }

  /**
   * 流式文本生成
   *
   * @example
   * ```typescript
   * const stream = LLM.streamText({
   *   model: 'openrouter:grok-4.1-fast',
   *   messages,
   * });
   *
   * for await (const chunk of stream.textStream) {
   *   process.stdout.write(chunk);
   * }
   * ```
   */
  static streamText(params: BaseParams) {
    const startTime = Date.now();
    const {
      model: modelSpec,
      id,
      system,
      messages,
      thinking: callerThinking = 'none',
      providerSort,
      temperature,
      maxOutputTokens,
      abortSignal,
      timeout: callerTimeout,
      maxRetries: callerMaxRetries,
      telemetry = DEFAULT_TELEMETRY,
    } = params;

    const spec = resolveSpec(modelSpec, callerThinking, callerMaxRetries, callerTimeout);
    const { key: modelKey } = spec;
    if (spec.fallbackModels.length > 0) {
      fallbackLogger.warning`[LLM:fallback-ignored] id=${id}, method=streamText — stream methods do not support fallback, only primary model=${modelKey} will be used. fallback=[${spec.fallbackModels.join(',')}]`;
    }
    LLM.logStart(id, 'streamText', modelKey, spec.thinking, undefined, spec.tier, spec.vertexRequestType);

    const languageModel = createModel(modelKey);
    const provider = parseProvider(modelKey);
    const providerOptions = buildProviderOptions(provider, spec.thinking, modelKey, providerSort);
    const tierHeaders = buildTierHeaders(modelKey, spec.tier, spec.vertexRequestType);

    const { signal, cleanup } = createManagedSignal(spec.timeout, abortSignal);

    let ttftLogged = false;

    const result = streamText({
      model: languageModel,
      system,
      messages,
      providerOptions,
      headers: tierHeaders,
      temperature,
      maxOutputTokens,
      maxRetries: spec.maxRetries,
      abortSignal: signal,
      experimental_telemetry: telemetry,
      onError: ({ error }) => {
        cleanup();
        LLM.logError(id, 'streamText', modelKey, error);
      },
      onChunk() {
        if (!ttftLogged) {
          LLM.logTTFT(id, startTime);
          ttftLogged = true;
        }
      },
      onFinish(event) {
        cleanup();
        LLM.logEnd(id, 'streamText', modelKey, startTime, event.usage, undefined, spec.tier, spec.vertexRequestType);
      },
    });

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tool Calling 模式
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 通过 Tool Calling 生成结构化对象（Promise 版，throws on error）
   *
   * @deprecated 使用 `safeGenerateObjectViaTool`（返回 ResultAsync）替代。
   * 迁移方式同 `generateObject`，参见其 JSDoc。
   *
   * 与 generateObject 的区别：
   * - generateObject: 使用 Structured Output 模式（Output.object）
   * - generateObjectViaTool: 使用 Tool Calling 模式
   *
   * Tool Calling 模式优势：
   * - 某些模型（如 Gemini 3 Flash）在 Tool Calling 上表现更好
   * - Schema 复杂时结构更稳定
   */
  private static async generateObjectViaToolCore<T>(
    params: GenerateObjectParams<T> & {
      /** Tool 名称 */
      toolName?: string;
      /** Tool 描述（帮助 LLM 理解何时使用） */
      toolDescription?: string;
      /**
       * 是否允许模型并行生成多个 tool call（默认 false）
       *
       * generateObjectViaTool 只定义 1 个 tool、只取第一个结果，
       * 但 Gemini 等模型在 tool calling 模式下会生成数百个重复 tool call。
       * 设为 false 可防止 token 浪费。仅 OpenRouter provider 支持此参数。
       */
      parallelToolCalls?: boolean;
    },
  ): Promise<GenerateObjectResult<T>> {
    const {
      model: modelSpec,
      id,
      schema,
      system,
      messages,
      thinking: callerThinking = 'none',
      providerSort,
      temperature,
      maxOutputTokens,
      abortSignal,
      timeout: callerTimeout,
      maxRetries: callerMaxRetries,
      telemetry = DEFAULT_TELEMETRY,
      toolName = 'extract',
      toolDescription = 'Extract structured data from the input',
      parallelToolCalls = true,
    } = params;

    const spec = resolveSpec(modelSpec, callerThinking, callerMaxRetries, callerTimeout);

    return withFallback(id, 'generateObjectViaTool', spec, async (modelKey, fb) => {
      const startTime = Date.now();
      LLM.logStart(id, 'generateObjectViaTool', modelKey, spec.thinking, fb, spec.tier, spec.vertexRequestType);
      LLM.logInputSummary(id, schema, messages, system);
      LLM.captureRequest(id, 'generateObjectViaTool', modelKey, schema, messages, system, {
        toolName,
        toolDescription,
      });

      const languageModel = createModel(modelKey);
      const provider = parseProvider(modelKey);
      const baseProviderOptions = buildProviderOptions(provider, spec.thinking, modelKey, providerSort);

      // OpenRouter 支持 parallelToolCalls 参数控制并行 tool call
      const providerOptions =
        provider === 'openrouter'
          ? {
              ...baseProviderOptions,
              openrouter: {
                ...baseProviderOptions.openrouter,
                parallelToolCalls,
              },
            }
          : baseProviderOptions;
      const tierHeaders = buildTierHeaders(modelKey, spec.tier, spec.vertexRequestType);

      // 创建 Tool，将 Schema 作为 inputSchema
      const tools = {
        [toolName]: tool({
          description: toolDescription,
          inputSchema: schema,
        }),
      };

      // 强制使用指定的 Tool
      const toolChoice = { type: 'tool' as const, toolName };

      const { signal, cleanup } = createManagedSignal(spec.timeout, abortSignal);

      try {
        const result = await generateText({
          model: languageModel,
          system,
          messages,
          tools,
          toolChoice,
          providerOptions,
          headers: tierHeaders,
          temperature,
          maxOutputTokens,
          maxRetries: spec.maxRetries,
          abortSignal: signal,
          experimental_telemetry: telemetry,
        });

        cleanup();
        LLM.logEnd(
          id,
          'generateObjectViaTool',
          modelKey,
          startTime,
          result.usage,
          fb,
          spec.tier,
          spec.vertexRequestType,
        );

        // 从 toolCalls 中提取结果（只取第一个，忽略可能的重复 tool call）
        const toolCall = result.toolCalls.at(0);
        if (!toolCall || !('input' in toolCall)) {
          throw Oops.Panic.AIObjectGenerationFailed(modelKey, 'no-tool-call', undefined, {
            cause: new Error('No tool call returned from LLM'),
          });
        }

        if (!parallelToolCalls && result.toolCalls.length > 1) {
          LLM.logger
            .warning`[LLM:warn] id=${id} generateObjectViaTool returned ${result.toolCalls.length} tool calls (expected 1), using first`;
        }

        // 预处理：部分模型（如 Grok）将嵌套对象序列化为 JSON 字符串
        // 在验证前尝试还原，无法还原的保持原样交给 safeParse 报错
        const rawInput = toolCall.input;
        const preprocessed = coerceStringifiedObjects(rawInput);

        // safeParse 验证：fail fast，不兜底修复
        const parseResult = schema.safeParse(preprocessed);
        if (!parseResult.success) {
          // 完整打印原始 tool call 输出——这是诊断 validation 失败的关键证据
          LLM.logger.warning`[LLM:validation-failed] id=${id} rawInput=${JSON.stringify(rawInput)}`;
          LLM.logger.warning`[LLM:validation-failed] id=${id} preprocessed=${JSON.stringify(preprocessed)}`;

          const issues = parseResult.error.issues
            .slice(0, 5)
            .map((i) => {
              // 从原始输入中提取失败字段的实际值
              let actual: unknown = preprocessed;
              for (const seg of i.path) {
                if (actual != null && typeof actual === 'object') {
                  actual = (actual as Record<string, unknown>)[String(seg)];
                } else {
                  actual = undefined;
                  break;
                }
              }
              const actualStr = actual === undefined ? '' : ` (got ${JSON.stringify(actual)})`;
              return `${i.path.join('.')}: ${i.message}${actualStr}`;
            })
            .join('; ');
          throw Oops.Panic.AIObjectGenerationFailed(modelKey, 'validation-failed', issues);
        }

        return {
          object: parseResult.data,
          usage: result.usage,
        };
      } catch (error) {
        cleanup();
        const classified = LLM.classifyError(error, modelKey);
        LLM.logError(id, 'generateObjectViaTool', modelKey, classified);
        throw classified;
      }
    });
  }

  /**
   * 通过 Tool Calling 流式生成结构化对象（实验性）
   *
   * 与 streamObject 的区别：
   * - streamObject: 使用 Structured Output 模式（Output.object）
   * - streamObjectViaTool: 使用 Tool Calling 模式
   *
   * Tool Calling 模式优势：
   * - 某些模型（如 Gemini 3 Flash）在 Tool Calling 上表现更好
   * - 提供更丰富的流式事件（tool-call-streaming-start, tool-call-delta）
   *
   * @example
   * ```typescript
   * const stream = LLM.streamObjectViaTool({
   *   model: 'openrouter:gemini-3-flash-preview',
   *   schema: MySchema,
   *   toolName: 'analyze',
   *   toolDescription: '分析用户输入',
   *   messages,
   * });
   *
   * for await (const event of stream) {
   *   if (event.type === 'partial') {
   *     console.log('Partial:', event.object);
   *   } else if (event.type === 'complete') {
   *     console.log('Complete:', event.object);
   *   }
   * }
   * ```
   */
  static async *streamObjectViaTool<T>(
    params: GenerateObjectParams<T> & {
      /** Tool 名称 */
      toolName?: string;
      /** Tool 描述（帮助 LLM 理解何时使用） */
      toolDescription?: string;
    },
  ): AsyncGenerator<ToolStreamEvent<T>> {
    const startTime = Date.now();
    const {
      model: modelSpec,
      id,
      schema,
      system,
      messages,
      thinking: callerThinking = 'none',
      providerSort,
      temperature,
      maxOutputTokens,
      abortSignal,
      timeout: callerTimeout,
      maxRetries: callerMaxRetries,
      telemetry = DEFAULT_TELEMETRY,
      toolName = 'extract',
      toolDescription = 'Extract structured data from the input',
    } = params;

    const spec = resolveSpec(modelSpec, callerThinking, callerMaxRetries, callerTimeout);
    const { key: modelKey } = spec;
    if (spec.fallbackModels.length > 0) {
      fallbackLogger.warning`[LLM:fallback-ignored] id=${id}, method=streamObjectViaTool — stream methods do not support fallback, only primary model=${modelKey} will be used. fallback=[${spec.fallbackModels.join(',')}]`;
    }
    LLM.logStart(id, 'streamObjectViaTool', modelKey, spec.thinking, undefined, spec.tier, spec.vertexRequestType);

    const languageModel = createModel(modelKey);
    const provider = parseProvider(modelKey);
    const providerOptions = buildProviderOptions(provider, spec.thinking, modelKey, providerSort);
    const tierHeaders = buildTierHeaders(modelKey, spec.tier, spec.vertexRequestType);

    // 创建 Tool，将 Schema 作为 inputSchema
    const tools = {
      [toolName]: tool({
        description: toolDescription,
        inputSchema: schema,
      }),
    };

    // 强制使用指定的 Tool
    const toolChoice = { type: 'tool' as const, toolName };

    const { signal, cleanup } = createManagedSignal(spec.timeout, abortSignal);

    const result = streamText({
      model: languageModel,
      system,
      messages,
      tools,
      toolChoice,
      providerOptions,
      headers: tierHeaders,
      temperature,
      maxOutputTokens,
      maxRetries: spec.maxRetries,
      abortSignal: signal,
      experimental_telemetry: telemetry,
      onError: ({ error }) => {
        cleanup();
        LLM.logError(id, 'streamObjectViaTool', modelKey, error);
      },
    });

    let ttftLogged = false;

    // 用于累积 JSON 字符串
    let jsonBuffer = '';
    let lastPartial: Partial<T> | null = null;

    // 遍历 fullStream 获取 tool-input 相关事件
    for await (const event of result.fullStream) {
      if (!ttftLogged) {
        LLM.logTTFT(id, startTime);
        ttftLogged = true;
      }

      if (event.type === 'tool-input-start') {
        // Tool input 开始
        jsonBuffer = '';
        yield { type: 'start', toolCallId: event.id };
      } else if (event.type === 'tool-input-delta') {
        // 增量 JSON 参数
        const delta: string = event.delta;
        jsonBuffer += delta;

        // 尝试解析部分 JSON
        const partial = tryParsePartialJson<T>(jsonBuffer);
        if (partial && JSON.stringify(partial) !== JSON.stringify(lastPartial)) {
          lastPartial = partial;
          yield { type: 'partial', object: partial };
        }
      } else if (event.type === 'tool-call') {
        // Tool call 完成，获取完整参数
        yield { type: 'complete', object: event.input as T, toolCallId: event.toolCallId };
      }
    }

    // 获取 usage
    const usage = await result.usage;
    cleanup();
    LLM.logEnd(id, 'streamObjectViaTool', modelKey, startTime, usage, undefined, spec.tier, spec.vertexRequestType);
    yield { type: 'usage', usage };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Embedding
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 文本向量化
   *
   * 统一入口，支持 provider:model 格式自动路由。
   *
   * @example
   * ```typescript
   * const vector = await LLM.embedding({
   *   id: 'sculptor-dedup',
   *   model: 'openai:text-embedding-3-small',
   *   text: 'some text',
   * });
   * ```
   */
  static async embedding(params: {
    id: string;
    model: EmbeddingModelKey;
    text: string;
    /** Jina/Gemini task type（LoRA adapter 切换），OpenAI 忽略 */
    task?: EmbeddingTaskType;
    abortSignal?: AbortSignal;
    /** 超时时间（毫秒），默认 60000 */
    timeout?: number;
  }): Promise<{ embedding: number[]; usage: TokenUsage }> {
    const startTime = Date.now();
    const { id, model: modelKey, text, task, abortSignal, timeout } = params;

    if (!text || text.trim().length === 0) {
      throw Oops.Validation('Embedding input text is empty', `id=${id} type=${typeof text} length=${text.length}`);
    }

    const taskPart = task ? `, task=${task}` : '';
    LLM.logger
      .debug`[LLM:embedding] id=${id} text="${text.slice(0, 80)}${text.length > 80 ? '...' : ''}" (${text.length} chars)${taskPart}`;
    LLM.logStart(id, 'embedding', modelKey);

    const [provider, modelId] = modelKey.split(':') as [EmbeddingProvider, string];

    switch (provider) {
      case 'openai': {
        // OpenAI 不支持 task type，忽略
        const embeddingModel = getOpenAI().embeddingModel(modelId);
        const { signal, cleanup } = createManagedSignal(timeout ?? SysEnv.AI_LLM_TIMEOUT_MS, abortSignal);
        try {
          const result = await embed({
            model: embeddingModel,
            value: text,
            abortSignal: signal,
          });
          cleanup();

          const usage: TokenUsage = { inputTokens: result.usage.tokens, outputTokens: 0 };
          LLM.logEnd(id, 'embedding', modelKey, startTime, usage);
          return { embedding: result.embedding, usage };
        } catch (error) {
          cleanup();
          throw error;
        }
      }

      case 'openrouter': {
        // OpenRouter 透传上游供应商（当前仅 openai/*），API 与 OpenAI 兼容，走 AI SDK provider
        const embeddingModel = getOpenRouter().textEmbeddingModel(modelId);
        const { signal, cleanup } = createManagedSignal(timeout ?? SysEnv.AI_LLM_TIMEOUT_MS, abortSignal);
        try {
          const result = await embed({
            model: embeddingModel,
            value: text,
            abortSignal: signal,
          });
          cleanup();

          const usage: TokenUsage = { inputTokens: result.usage.tokens, outputTokens: 0 };
          LLM.logEnd(id, 'embedding', modelKey, startTime, usage);
          return { embedding: result.embedding, usage };
        } catch (error) {
          cleanup();
          throw error;
        }
      }

      case 'jina': {
        const apiKey = SysEnv.AI_JINA_API_KEY ?? SysEnv.JINA_API_KEY;
        if (!apiKey) {
          throw Oops.Panic.Config('AI_JINA_API_KEY is not configured');
        }

        const { signal, cleanup } = createManagedSignal(timeout ?? SysEnv.AI_LLM_TIMEOUT_MS, abortSignal);
        try {
          // Matryoshka 模型（v5-nano 默认 768d）需显式指定维度以匹配 DB schema
          const modelMeta = EMBEDDING_MODELS[modelId as EmbeddingModel];
          const body: Record<string, unknown> = {
            model: modelId,
            input: [text],
            normalized: true,
            ...(modelMeta.dimensions ? { dimensions: modelMeta.dimensions } : {}),
          };
          if (task) body.task = task;

          const response = await ApiFetcher.fetch('https://api.jina.ai/v1/embeddings', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal,
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw Oops.Panic.ExternalService('jina', `API error: ${response.status} - ${errorText}`);
          }

          const result = (await response.json()) as {
            data: Array<{ embedding: number[] }>;
            usage: { total_tokens?: number; prompt_tokens?: number };
          };

          cleanup();

          const embedding = result.data[0]?.embedding;
          if (!embedding) {
            throw Oops.Panic.ExternalService('jina', `Returned empty embedding (id=${id})`);
          }

          const totalTokens = result.usage.total_tokens ?? result.usage.prompt_tokens ?? 0;
          const usage: TokenUsage = { inputTokens: totalTokens, outputTokens: 0 };
          LLM.logEnd(id, 'embedding', modelKey, startTime, usage);
          return { embedding, usage };
        } catch (error) {
          cleanup();
          throw error;
        }
      }

      case 'voyage': {
        const apiKey = SysEnv.AI_VOYAGE_API_KEY ?? SysEnv.VOYAGE_API_KEY;
        if (!apiKey) {
          throw Oops.Panic.Config('AI_VOYAGE_API_KEY is not configured');
        }

        const { signal, cleanup } = createManagedSignal(timeout ?? SysEnv.AI_LLM_TIMEOUT_MS, abortSignal);
        try {
          const response = await ApiFetcher.fetch('https://api.voyageai.com/v1/embeddings', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ model: modelId, input: [text] }),
            signal,
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw Oops.Panic.ExternalService('voyage', `API error: ${response.status} - ${errorText}`);
          }

          const result = (await response.json()) as {
            data: Array<{ embedding: number[] }>;
            usage: { total_tokens?: number };
          };

          cleanup();

          const embedding = result.data[0]?.embedding;
          if (!embedding) {
            throw Oops.Panic.ExternalService('voyage', `Returned empty embedding (id=${id})`);
          }

          const usage: TokenUsage = { inputTokens: result.usage.total_tokens ?? 0, outputTokens: 0 };
          LLM.logEnd(id, 'embedding', modelKey, startTime, usage);
          return { embedding, usage };
        } catch (error) {
          cleanup();
          throw error;
        }
      }

      case 'gemini': {
        const apiKey = SysEnv.AI_GOOGLE_API_KEY;
        if (!apiKey) {
          throw Oops.Panic.Config('AI_GOOGLE_API_KEY is not configured (embedding)');
        }

        const { signal, cleanup } = createManagedSignal(timeout ?? SysEnv.AI_LLM_TIMEOUT_MS, abortSignal);
        try {
          const body: Record<string, unknown> = {
            content: { parts: [{ text }] },
          };
          // Gemini 用大写枚举格式，映射 Jina 风格 task type
          if (task) {
            const TASK_MAP: Record<string, string> = {
              'retrieval.query': 'RETRIEVAL_QUERY',
              'retrieval.passage': 'RETRIEVAL_DOCUMENT',
              'text-matching': 'SEMANTIC_SIMILARITY',
              classification: 'CLASSIFICATION',
              clustering: 'CLUSTERING',
            };
            body.taskType = TASK_MAP[task] ?? task;
          }

          const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:embedContent?key=${apiKey}`;
          const response = await ApiFetcher.fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal,
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw Oops.Panic.ExternalService('gemini', `API error: ${response.status} - ${errorText}`);
          }

          const result = (await response.json()) as {
            embedding: { values: number[] };
          };

          cleanup();

          const embedding = result.embedding.values;
          if (embedding.length === 0) {
            throw Oops.Panic.ExternalService('gemini', `Returned empty embedding (id=${id})`);
          }

          // Gemini embedContent 不返回 token usage
          const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
          LLM.logEnd(id, 'embedding', modelKey, startTime, usage);
          return { embedding, usage };
        } catch (error) {
          cleanup();
          throw error;
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 便捷方法
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 获取 LanguageModel 实例
   *
   * 用于需要直接使用 AI SDK 的场景
   */
  static model(key: LLMModelSpec): LanguageModel {
    const { key: baseKey } = parseModelSpec(key);
    return createModel(baseKey);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Stream Event Types
// ═══════════════════════════════════════════════════════════════════════════

/** Tool 流式事件类型 */
export type ToolStreamEvent<T> =
  | { type: 'start'; toolCallId: string }
  | { type: 'partial'; object: Partial<T> }
  | { type: 'complete'; object: T; toolCallId: string }
  | { type: 'usage'; usage: TokenUsage };

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * AI SDK Source 的最小子集（`Source` 类型未从 `ai` 包导出）。
 *
 * @see LanguageModelV3Source（@ai-sdk/provider 内部类型）
 */
interface AiSdkSource {
  type: 'source';
  sourceType: string;
  id: string;
  url?: string;
  title?: string;
}

/**
 * 从 AI SDK Source[] 中提取 URL 类型的 WebSource
 *
 * AI SDK 的 Source 有 url 和 document 两种变体，
 * Web Search 场景只关心 url 类型。
 */
function extractWebSources(sources: AiSdkSource[] | undefined): WebSource[] {
  if (!sources?.length) return [];

  return sources
    .filter((s): s is AiSdkSource & { sourceType: 'url'; url: string } => s.sourceType === 'url' && !!s.url)
    .map((s) => ({
      id: s.id,
      url: s.url,
      title: s.title,
    }));
}

/**
 * 部分模型（如 Grok）在 tool calling 时将嵌套对象序列化为 JSON 字符串，
 * 且可能使用欧洲小数格式（0,5 → 应为 0.5）和截断输出。
 *
 * 处理流程（顶层字段，不递归）：
 * 1. 值是 string 且以 { 或 [ 开头 → 尝试还原
 * 2. 修复欧洲小数：(\d),(\d) → $1.$2（在非字符串上下文中安全）
 * 3. 尝试 JSON.parse → 成功则替换
 * 4. parse 失败（截断）→ tryParsePartialJson 补全括号后再试
 * 5. 全部失败 → 保持原样，交给 safeParse 报错
 */
export function coerceStringifiedObjects(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === 'null') {
      result[key] = null;
    } else if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
      // 修复欧洲小数：0,5 → 0.5（仅在数字之间替换，不影响 JSON 逗号分隔符）
      const fixed = value.replace(/(\d),(\d)/g, '$1.$2');
      try {
        result[key] = JSON.parse(fixed);
      } catch {
        // JSON.parse 失败（截断）→ 尝试 partial parse
        const partial = tryParsePartialJson(fixed);
        result[key] = partial ?? value;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * 尝试解析部分 JSON 字符串
 *
 * 处理不完整的 JSON，尽可能提取已有字段
 */
function tryParsePartialJson<T>(jsonString: string): Partial<T> | null {
  if (!jsonString.trim()) return null;

  // 首先尝试直接解析（可能是完整 JSON）
  try {
    return JSON.parse(jsonString) as T;
  } catch {
    // 不是完整 JSON，尝试修复
  }

  // 尝试补全 JSON（添加缺失的括号）
  let fixedJson = jsonString.trim();

  // 计算未闭合的括号
  let braceCount = 0;
  let bracketCount = 0;
  let inString = false;
  let escapeNext = false;

  for (const char of fixedJson) {
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') braceCount++;
    else if (char === '}') braceCount--;
    else if (char === '[') bracketCount++;
    else if (char === ']') bracketCount--;
  }

  // 如果在字符串中间，截断到最后一个完整的引号
  if (inString) {
    const lastQuote = fixedJson.lastIndexOf('"');
    if (lastQuote > 0) {
      fixedJson = fixedJson.substring(0, lastQuote + 1);
      // 重新计算括号
      braceCount = 0;
      bracketCount = 0;
      inString = false;
      for (const char of fixedJson) {
        if (escapeNext) {
          escapeNext = false;
          continue;
        }
        if (char === '\\') {
          escapeNext = true;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (char === '{') braceCount++;
        else if (char === '}') braceCount--;
        else if (char === '[') bracketCount++;
        else if (char === ']') bracketCount--;
      }
    }
  }

  // 移除末尾不完整的键值对
  // 例如 `{"a": 1, "b":` -> `{"a": 1`
  fixedJson = fixedJson.replace(/,\s*"[^"]*"\s*:\s*$/, '');
  fixedJson = fixedJson.replace(/,\s*$/, '');

  // 补全括号
  fixedJson += ']'.repeat(Math.max(0, bracketCount));
  fixedJson += '}'.repeat(Math.max(0, braceCount));

  try {
    return JSON.parse(fixedJson) as Partial<T>;
  } catch {
    return null;
  }
}
