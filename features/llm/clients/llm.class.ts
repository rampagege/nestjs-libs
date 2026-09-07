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
 *   model: 'openrouter:grok-4.3',
 *   schema: MySchema,
 *   instructions: 'You are...',
 *   messages: [{ role: 'user', content: 'Hello' }],
 * });
 *
 * // 开启 thinking
 * const { object } = await LLM.generateObject({
 *   model: 'openrouter:grok-4.3',
 *   schema: MySchema,
 *   messages,
 *   thinking: 'high',
 * });
 * ```
 */

import { SysEnv } from '@app/env';
import { Oops } from '@app/nest/exceptions/oops';
import { mergeProvenanceLlmTags } from '@app/nest/trace/provenance-context';
import { RequestContext } from '@app/nest/trace/request-context';
import { getAppLogger } from '@app/utils/app-logger';
import { ApiFetcher } from '@app/utils/fetch';

import { llmCaptureSchema } from '../schemas/capture.schema';
import { EMBEDDING_MODELS } from '../types/embedding.types';
import {
  allowsSystemInMessages,
  DEFAULT_SUPPORTED_TIERS,
  getModel,
  getProvider,
  getRegisteredModels,
  parseModelSpec,
  resolveThinkingForModel,
} from '../types/model.types';
import { getCostFromUsage } from '../utils/cost-calculator';
import { bedrockServiceTierOptions } from './bedrock.client';
import { getOpenAI, getOpenRouter } from './llm.clients';
import { createLanguageModel } from './model-router';
import { resolveOpenRouterOptions } from './openrouter.client';
import { disableThinkingOptions, reasoningEffortOptions } from './options.helpers';
import { privateModel, privateModelError } from './private-model';
import { createStreamLifecycle } from './stream-lifecycle';
import { DEFAULT_LLM_TELEMETRY as DEFAULT_TELEMETRY } from './telemetry-policy';

import { Temporal } from '@js-temporal/polyfill';
import * as Sentry from '@sentry/nestjs';
import {
  APICallError,
  embed,
  extractJsonMiddleware,
  generateText,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  streamText,
  tool,
  jsonSchema as wrapJsonSchema,
  wrapLanguageModel,
  zodSchema,
} from 'ai';
import { ResultAsync } from 'neverthrow';
import { z } from 'zod';

import type { EmbeddingModel, EmbeddingModelKey, EmbeddingProvider, EmbeddingTaskType } from '../types/embedding.types';
import type {
  BedrockModelOptions,
  BedrockServiceTier,
  LLMModelKey,
  LLMModelSpec,
  LLMProviderType,
  OpenRouterModelOptions,
  VertexModelOptions,
  VertexRequestType,
  VertexTier,
} from '../types/model.types';
/**
 * 仅对已知会包裹 markdown 代码块的模型启用 extractJsonMiddleware。
 *
 * 背景：
 * Kimi K2.5 在 response_format: json 场景下，偶发返回 ```json ... ```，
 * parseCompleteOutput 期望纯 JSON（以 `{` 开头），会导致 JSON.parse 失败。
 *
 * @see https://ai-sdk.dev/docs/reference/ai-sdk-core/extract-json-middleware
 */
import type { JSONObject } from '@ai-sdk/provider';
import type { Context } from '@ai-sdk/provider-utils';
import type { OopsError } from '@app/nest/exceptions/oops-error';
import type {
  LanguageModel,
  ModelMessage,
  PrepareStepFunction,
  PrepareStepResult,
  ProviderMetadata,
  StopCondition,
  StreamTextOnErrorRetryCallback,
  StreamTextResult,
  TelemetryOptions,
  ToolChoice,
  ToolSet,
} from 'ai';
import type * as NodeFs from 'node:fs';

/**
 * `buildProviderOptions` 的精确返回类型：仅包含实际使用的 provider 键，
 * 值对齐 AI SDK 的 `JSONObject`，可直接传给 `providerOptions`（即 `SharedV3ProviderOptions = Record<string, JSONObject>`）。
 */
type ProviderOptionsSurface = {
  openrouter?: JSONObject;
  google?: JSONObject;
  vertex?: JSONObject;
  bedrock?: JSONObject;
};

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

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
  /**
   * Provider 报告的权威成本（USD）。存在时优先于 MODEL_PRICING 估算。
   * @see sumProviderReportedCost
   */
  cost?: number;
}

type LLMReservedAIKeys = 'model' | 'providerOptions' | 'output';
/**
 * 在 `ai` namespace 中被禁止的键：
 * - prompt owner 字段（instructions/system/prompt/messages）由 wrapper 顶层参数唯一拥有，
 *   不允许通过 ai namespace 出现第二个 owner
 * - onFinish 是 v7 的 deprecated alias，公共面只暴露 onEnd
 */
type LLMBannedAIKeys = 'instructions' | 'system' | 'prompt' | 'messages' | 'onFinish';
type LLMWrappedAIKeys = LLMReservedAIKeys | LLMBannedAIKeys | 'prepareStep';

export interface LLMPrepareStepOptions {
  /** Step-level model spec. Translated through LLM's normal model/provider normalization. */
  model?: LLMModelSpec;
  /** Step-level thinking override. Defaults to current step model spec semantics. */
  thinking?: ThinkingEffort;
  /** OpenRouter provider routing override for the step model. */
  openrouter?: OpenRouterModelOptions;
  /** Provider model id suffix for the step model. */
  modelIdSuffix?: string;
}

export type LLMPrepareStepResult<TOOLS extends ToolSet = ToolSet, RUNTIME_CONTEXT extends Context = Context> =
  | (Omit<NonNullable<PrepareStepResult<TOOLS, RUNTIME_CONTEXT>>, LLMReservedAIKeys | 'system'> & {
      llm?: LLMPrepareStepOptions;
    })
  | undefined;

export type LLMPrepareStepFunction<TOOLS extends ToolSet = ToolSet, RUNTIME_CONTEXT extends Context = Context> = (
  options: Parameters<PrepareStepFunction<TOOLS, RUNTIME_CONTEXT>>[0],
) => LLMPrepareStepResult<TOOLS, RUNTIME_CONTEXT> | PromiseLike<LLMPrepareStepResult<TOOLS, RUNTIME_CONTEXT>>;

export type LLMGenerateTextAIOptions<TOOLS extends ToolSet = ToolSet, RUNTIME_CONTEXT extends Context = Context> = Omit<
  Parameters<typeof generateText<TOOLS, RUNTIME_CONTEXT>>[0],
  LLMWrappedAIKeys
> & {
  prepareStep?: LLMPrepareStepFunction<TOOLS, RUNTIME_CONTEXT>;
};

export type LLMStreamTextAIOptions<
  TOOLS extends ToolSet = ToolSet,
  RUNTIME_CONTEXT extends Context = Context,
  OUTPUT extends Output.Output = Output.Output<string, string, never>,
> = Omit<Parameters<typeof streamText<TOOLS, RUNTIME_CONTEXT, OUTPUT>>[0], LLMWrappedAIKeys> & {
  prepareStep?: LLMPrepareStepFunction<TOOLS, RUNTIME_CONTEXT>;
};

/**
 * `onError` 的返回值：AI SDK 用它承载 `{ retry: true }` 重试指令
 * （需调用方显式配置 `streamRetries`）。lifecycle 包装器必须原样透传。
 */
type StreamOnErrorResult = Awaited<ReturnType<StreamTextOnErrorRetryCallback>>;

/** SDK 契约下 onError 的非空返回值只有 `{ retry: true }` 一种形态，故「是对象」即等价于请求重试。 */
const isStreamRetryRequested = (result: StreamOnErrorResult | undefined): boolean => typeof result === 'object';

/** Canonical AI SDK v7 stream result. The deprecated `fullStream` alias is intentionally hidden. */
export type LLMStreamTextResult<
  TOOLS extends ToolSet = ToolSet,
  RUNTIME_CONTEXT extends Context = Context,
  OUTPUT extends Output.Output = Output.Output,
> = Omit<StreamTextResult<TOOLS, RUNTIME_CONTEXT, OUTPUT>, 'fullStream'>;

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
  /** LLM Model Spec，如 'openrouter:grok-4.3' 或 'openrouter:grok-4.3?reason=low' */
  model: LLMModelSpec;
  /** System prompt（AI SDK v7 词汇：instructions） */
  instructions?: string;
  /** 消息列表 */
  messages: Message[];
  /** Thinking 强度，默认 'none' */
  thinking?: ThinkingEffort;
  /** OpenRouter provider routing options（仅 openrouter 有效） */
  openrouter?: OpenRouterModelOptions;
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
  telemetry?: TelemetryOptions;
}

/** generateObject 参数 */
interface GenerateObjectParams<T> extends BaseParams {
  /** Zod Schema */
  schema: z.ZodType<T>;
}

/** generateText 参数 */
interface GenerateTextParams<
  TOOLS extends ToolSet = ToolSet,
  RUNTIME_CONTEXT extends Context = Context,
> extends BaseParams {
  /** AI SDK 原生参数，LLM 保留 model/providerOptions 并转译 prepareStep.llm */
  ai?: LLMGenerateTextAIOptions<TOOLS, RUNTIME_CONTEXT>;

  /**
   * Model ID 后缀
   *
   * 拼接到 LLMModelRegistry 中的 modelId 后面，用于 provider 特定功能。
   * 例如 OpenRouter 的 `:online` 搜索插件：
   *
   * model='openrouter:grok-4.3' + modelIdSuffix=':online'
   * → provider 收到 'x-ai/grok-4.3:online'
   */
  modelIdSuffix?: string;
}

export interface StreamTextParams<
  TOOLS extends ToolSet = ToolSet,
  RUNTIME_CONTEXT extends Context = Context,
  OUTPUT extends Output.Output = Output.Output<string, string, never>,
> extends BaseParams {
  /** AI SDK 原生参数，LLM 保留 model/providerOptions 并转译 prepareStep.llm */
  ai?: LLMStreamTextAIOptions<TOOLS, RUNTIME_CONTEXT, OUTPUT>;
  /**
   * 结构化输出规格（如 Output.object({schema})），与 ai.tools 同开——工具调用循环的中间
   * step 正常调用工具，循环自然终止的终态 step 按此规格产出结构化对象。镜像
   * StreamObjectParams 的 schema 顶层参数模式；省略时行为与扩展前完全一致（加法式）。
   */
  output?: OUTPUT;
}

interface StreamObjectParams<
  T,
  TOOLS extends ToolSet = ToolSet,
  RUNTIME_CONTEXT extends Context = Context,
> extends GenerateObjectParams<T> {
  /** AI SDK 原生参数（tools/toolChoice/stopWhen 均经此传入），LLM 保留 model/providerOptions/output 并转译 prepareStep.llm */
  ai?: LLMStreamTextAIOptions<TOOLS, RUNTIME_CONTEXT>;
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
  /**
   * Caller/spec intent before per-key registry fallback.
   * Each fallback modelKey re-resolves via resolveThinkingForModel(modelKey, requestedThinking).
   */
  requestedThinking: ThinkingEffort;
  /** Effective thinking for the primary key only (after param fallback if any). */
  thinking: ThinkingEffort;
  maxRetries: number;
  timeout: number;
  fallbackModels: LLMModelKey[];
  /** Provider-namespaced Vertex request options. */
  vertex: VertexModelOptions | undefined;
  /** OpenRouter provider-namespaced options. */
  openrouter: OpenRouterModelOptions | undefined;
  /** Bedrock provider-namespaced options. */
  bedrock: BedrockModelOptions | undefined;
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
  const requestedThinking = callerThinking !== 'none' ? callerThinking : (parsed.thinking ?? 'none');
  // Per-key policy may conservatively map none to a non-none effort.
  const { thinking, paramFallbackApplied } = resolveThinkingForModel(parsed.key, requestedThinking);
  if (paramFallbackApplied) {
    specLogger.warning`[resolveSpec] ${parsed.key} maps thinking=none to thinking=${thinking} by registry policy`;
  }
  const maxRetries = callerMaxRetries ?? parsed.maxRetries ?? SysEnv.AI_LLM_MAX_RETRIES;
  const timeout = callerTimeout ?? parsed.timeout ?? SysEnv.AI_LLM_TIMEOUT_MS;
  const fallbackModels = parsed.fallbackModels;
  const vertex = parsed.vertex;
  const openrouter = parsed.openrouter;
  const bedrock = parsed.bedrock;

  // 有非默认参数时打印生效值，方便排查
  const hasSpecParams =
    parsed.thinking !== undefined ||
    parsed.maxRetries !== undefined ||
    parsed.timeout !== undefined ||
    fallbackModels.length > 0 ||
    vertex !== undefined ||
    openrouter !== undefined ||
    bedrock !== undefined ||
    paramFallbackApplied;
  if (hasSpecParams) {
    const parts: string[] = [];
    if (thinking !== 'none') parts.push(`thinking=${thinking}`);
    if (paramFallbackApplied) parts.push('reasoningParamFallback=true');
    parts.push(`retry=${maxRetries}`);
    parts.push(`timeout=${timeout}ms`);
    if (fallbackModels.length > 0) parts.push(`fallback=[${fallbackModels.join(',')}]`);
    if (vertex?.tier !== undefined) parts.push(`vertex.tier=${vertex.tier}`);
    if (vertex?.requestType !== undefined) parts.push(`vertex.requestType=${vertex.requestType}`);
    if (openrouter?.routing !== undefined) parts.push(`openrouter.routing=${openrouter.routing}`);
    if (bedrock?.serviceTier !== undefined) parts.push(`bedrock.serviceTier=${bedrock.serviceTier}`);
    specLogger.info`[resolveSpec] ${parsed.key} → ${parts.join(', ')}`;
  }

  return {
    key: parsed.key,
    requestedThinking,
    thinking,
    maxRetries,
    timeout,
    fallbackModels,
    vertex,
    openrouter,
    bedrock,
  };
}

function resolveOpenRouterCallOptions(
  specOpenRouter: OpenRouterModelOptions | undefined,
  callOpenRouter: OpenRouterModelOptions | undefined,
): OpenRouterModelOptions | undefined {
  return callOpenRouter ?? specOpenRouter;
}

/**
 * 根据 Provider 和 thinking 强度生成 providerOptions
 *
 * reasoningRequired 模型（如 MiniMax M2.5、Grok 4.1 Fast）：
 * thinking='none' 时不发送 disableThinking，避免 400 错误。
 */
function buildProviderOptions(
  provider: LLMProviderType,
  thinking: ThinkingEffort,
  modelKey: LLMModelKey,
  openrouter?: OpenRouterModelOptions,
  bedrock?: BedrockModelOptions,
): ProviderOptionsSurface {
  const modelConfig = getModel(modelKey);
  const thinkingOptions: ProviderOptionsSurface =
    thinking === 'none'
      ? modelConfig.reasoningRequired
        ? {}
        : disableThinkingOptions(provider, modelConfig.modelId, modelConfig.googleNoneThinking)
      : reasoningEffortOptions(provider, thinking, modelConfig.modelId, modelConfig.googleThinkingMode);

  if (provider === 'bedrock') {
    if (!bedrock?.serviceTier) return thinkingOptions;
    const serviceTierOptions = bedrockServiceTierOptions(bedrock.serviceTier);
    return {
      bedrock: {
        ...thinkingOptions.bedrock,
        ...serviceTierOptions.bedrock,
      },
    };
  }

  if (bedrock) {
    aiLogger.warning`[buildProviderOptions] bedrock options requested for non-bedrock provider=${provider} (model=${modelKey}), ignoring`;
  }

  if (provider !== 'openrouter') {
    if (openrouter) {
      aiLogger.warning`[buildProviderOptions] openrouter options requested for non-openrouter provider=${provider} (model=${modelKey}), ignoring`;
    }
    return thinkingOptions;
  }

  const routingOptions = resolveOpenRouterOptions(openrouter, (name) => {
    aiLogger.warning`[buildProviderOptions] unknown OpenRouter routing profile="${name}" (model=${modelKey}), ignoring`;
  });

  if (routingOptions?.openrouter) {
    return {
      openrouter: {
        ...thinkingOptions.openrouter,
        ...routingOptions.openrouter,
      },
    };
  }

  return thinkingOptions;
}

const aiLogger = getAppLogger('features', 'LLM', 'ai');

function stripJsonCodeFence(text: string): string {
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (jsonMatch?.[1]) return jsonMatch[1].trim();
  if (trimmed.startsWith('```')) return trimmed.replace(/^```(?:json)?\s*\n?/, '').trim();
  return trimmed;
}

function createLanguageModelForCall(
  modelKey: LLMModelKey,
  modelIdSuffix: string | undefined,
  options?: { extractJson?: boolean },
): LanguageModel {
  const languageModel = createLanguageModel(modelKey, modelIdSuffix);
  if (!options?.extractJson || !MODELS_NEEDING_EXTRACT_JSON.has(modelKey)) {
    return languageModel;
  }

  return wrapLanguageModel({
    model: languageModel as Parameters<typeof wrapLanguageModel>[0]['model'],
    middleware: extractJsonMiddleware({ transform: stripJsonCodeFence }),
  });
}

function getRuntimeContextTags(runtimeContext: Context | undefined): string[] {
  const tags = runtimeContext?.tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [];
}

export function mergeProvenanceRuntimeContext<RUNTIME_CONTEXT extends Context>(
  runtimeContext?: RUNTIME_CONTEXT,
): RUNTIME_CONTEXT | undefined {
  const tags = mergeProvenanceLlmTags(getRuntimeContextTags(runtimeContext));
  if (tags.length === 0) return runtimeContext;

  if (runtimeContext !== undefined) {
    return {
      ...runtimeContext,
      tags,
    };
  }

  return { tags } as unknown as RUNTIME_CONTEXT;
}

function withProvenanceTelemetry<RUNTIME_CONTEXT extends Context, TOOLS extends ToolSet>(
  telemetry: TelemetryOptions<RUNTIME_CONTEXT, TOOLS>,
): TelemetryOptions<RUNTIME_CONTEXT, TOOLS> {
  if (telemetry.isEnabled === false) {
    return telemetry;
  }

  return {
    ...telemetry,
    includeRuntimeContext: {
      ...telemetry.includeRuntimeContext,
      tags: true,
    },
  };
}

interface ResolveAIOptionsContext {
  id: string;
  method: string;
  modelSpec: LLMModelSpec;
  modelIdSuffix?: string;
  thinking: ThinkingEffort;
  openrouter?: OpenRouterModelOptions;
  extractJson?: boolean;
  /** A step may switch models; the privacy decision has to travel with it. */
  privateTelemetry?: boolean;
}

/** @internal exported for testing */
export function wrapPrepareStep<TOOLS extends ToolSet, RUNTIME_CONTEXT extends Context>(
  prepareStep: LLMPrepareStepFunction<TOOLS, RUNTIME_CONTEXT> | undefined,
  context: ResolveAIOptionsContext,
): PrepareStepFunction<TOOLS, RUNTIME_CONTEXT> | undefined {
  if (!prepareStep) return undefined;

  return async (options) => {
    const result = await prepareStep(options);
    if (!result) return undefined;

    const unsafe = result as Record<string, unknown>;
    if ('model' in unsafe || 'providerOptions' in unsafe) {
      aiLogger.warning`[prepareStep] id=${context.id}, method=${context.method}: raw model/providerOptions are managed by LLM and ignored; use llm.model instead`;
    }

    const { model: _model, providerOptions: _providerOptions, llm, ...safe } = unsafe;
    if (safe.runtimeContext !== undefined) {
      safe.runtimeContext = mergeProvenanceRuntimeContext(safe.runtimeContext as RUNTIME_CONTEXT);
    }

    if (!llm) {
      return safe;
    }

    const llmOptions = llm as LLMPrepareStepOptions;
    const targetModelSpec = llmOptions.model ?? context.modelSpec;
    const targetModelIdSuffix = llmOptions.modelIdSuffix ?? (llmOptions.model ? undefined : context.modelIdSuffix);
    const stepThinking = llmOptions.thinking ?? (llmOptions.model ? 'none' : context.thinking);
    const stepSpec = resolveSpec(targetModelSpec, stepThinking, undefined, undefined);

    if (stepSpec.fallbackModels.length > 0) {
      aiLogger.warning`[prepareStep] id=${context.id}, method=${context.method}: step-level fallback models are ignored because AI SDK PrepareStepResult can only return one model`;
    }
    const stepTier = stepSpec.vertex?.tier;
    if ((stepTier && stepTier !== 'standard') || stepSpec.vertex?.requestType) {
      aiLogger.warning`[prepareStep] id=${context.id}, method=${context.method}: step-level tier/requestType is ignored because AI SDK PrepareStepResult does not support step-level headers`;
    }

    const provider = getProvider(stepSpec.key);
    const stepOpenRouter = resolveOpenRouterCallOptions(
      llmOptions.model ? stepSpec.openrouter : context.openrouter,
      llmOptions.openrouter,
    );
    return {
      ...safe,
      model: privateModel(
        createLanguageModelForCall(stepSpec.key, targetModelIdSuffix, {
          extractJson: context.extractJson,
        }),
        context.privateTelemetry === true,
      ),
      providerOptions: buildProviderOptions(
        provider,
        stepSpec.thinking,
        stepSpec.key,
        stepOpenRouter,
        stepSpec.bedrock,
      ),
    };
  };
}

function resolveLLMAIOptions<
  TOOLS extends ToolSet,
  RUNTIME_CONTEXT extends Context,
  OPTIONS extends {
    tools?: TOOLS;
    stopWhen?: StopCondition<TOOLS, RUNTIME_CONTEXT> | Array<StopCondition<TOOLS, RUNTIME_CONTEXT>>;
    prepareStep?: LLMPrepareStepFunction<TOOLS, RUNTIME_CONTEXT>;
  },
>(ai: OPTIONS | undefined, context: ResolveAIOptionsContext): OPTIONS | undefined {
  if (!ai) return undefined;

  const source = ai as Record<string, unknown>;
  if ('model' in source || 'providerOptions' in source) {
    aiLogger.warning`[options] id=${context.id}, method=${context.method}: raw model/providerOptions are managed by LLM and ignored`;
  }

  const { model: _model, providerOptions: _providerOptions, ...safe } = source;
  const merged = { ...safe } as Record<string, unknown>;
  if (merged.prepareStep) {
    merged.prepareStep = wrapPrepareStep(merged.prepareStep as LLMPrepareStepFunction<TOOLS, RUNTIME_CONTEXT>, context);
  }

  return merged as OPTIONS;
}

function mergeHeaders(
  aiHeaders: Record<string, string | undefined> | undefined,
  llmHeaders: Record<string, string> | undefined,
): Record<string, string | undefined> | undefined {
  if (!aiHeaders && !llmHeaders) return undefined;
  return {
    ...aiHeaders,
    ...llmHeaders,
  };
}

/** 导出给测试文件共享同一真相源 */
/**
 * 非 standard tier 命中时 Vertex 在 `usageMetadata.trafficType` 回报的值。
 * 实测 2026-09-05：无 header → `ON_DEMAND`，`tier=priority` → `ON_DEMAND_PRIORITY`。
 */
const VERTEX_TIER_TRAFFIC_TYPE: Record<Exclude<VertexTier, 'standard'>, string> = {
  priority: 'ON_DEMAND_PRIORITY',
  flex: 'ON_DEMAND_FLEX',
};

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

/** 一步生成的 provider metadata 载体 —— `StepResult` 与 end event 的 steps 都满足。 */
interface StepProviderMetadataCarrier {
  readonly providerMetadata?: ProviderMetadata;
}

/**
 * Provider 报告的权威成本（USD）。
 *
 * OpenRouter 的 usage accounting 默认开启，每次响应都在
 * `providerMetadata.openrouter.usage.cost` 带回实际扣费额 —— 它反映真实命中的
 * provider 与 service tier，而 MODEL_PRICING 只是标价快照，可能过期或记错档位。
 *
 * 多步生成里每一步各有自己的 cost，必须逐步累加：`finalStep` 只是 `steps.at(-1)`，
 * 拿它单独算会漏掉前面所有步骤。
 *
 * 返回 undefined 表示该 provider 没报告成本（如 Google/Vertex/Bedrock 直连），
 * 调用方回退到定价表估算。
 */
export function sumProviderReportedCost(steps: readonly StepProviderMetadataCarrier[]): number | undefined {
  if (steps.length === 0) return undefined;
  let total = 0;
  for (const step of steps) {
    const openrouter = step.providerMetadata?.openrouter as { usage?: { cost?: unknown } } | undefined;
    const cost = openrouter?.usage?.cost;
    // 覆盖不全就整体不可信：prepareStep 的 llm.model 可以逐 step 切 provider，
    // 混合调用里只有 OpenRouter 步骤带 cost。返回部分和会被 getCostFromUsage 当成权威值、
    // 跳过兜底估算，于是非 OpenRouter 步骤的花费被静默漏掉 —— 方向是低估。
    // 宁可整体退回估算（口径一致、覆盖全部 token），也不要「权威值 + 漏项」。
    if (typeof cost !== 'number') return undefined;
    total += cost;
  }
  return total;
}

/**
 * Provider 原始 usage metadata，挂到 `TokenUsage.raw` 供 extractTrafficType 读取。
 *
 * Vertex / Google 把 PayGo 验证字段放在 `providerMetadata.<provider>.usageMetadata`
 * （实测 vertex 路由的 key 是 `vertex`，值形如 `{ trafficType: 'ON_DEMAND_PRIORITY', ... }`），
 * 而 AI SDK 标准 usage 只有 token 计数。不接上这一步，`raw` 永远是 undefined，
 * buildTierHeaders 日志里那句「verify actual routing via usage.raw.trafficType」就指向空值，
 * tier header 到底有没有命中 Priority/Flex PayGo 无从验证。
 *
 * 多步生成只取最后一个带 usageMetadata 的 step：trafficType 是枚举不是数值，累加无意义。
 */
export function extractProviderUsageMetadata(steps: readonly StepProviderMetadataCarrier[]): unknown {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const providerMetadata = steps[i]?.providerMetadata;
    if (!providerMetadata) continue;
    for (const providerKey of ['vertex', 'google'] as const) {
      const metadata = (providerMetadata[providerKey] as { usageMetadata?: unknown } | undefined)?.usageMetadata;
      if (metadata !== undefined && metadata !== null) return metadata;
    }
  }
  return undefined;
}

/**
 * 把 provider 侧的权威 usage 事实并入 usage：
 * - `cost` → getCostFromUsage 优先采用它而非本地估算
 * - `raw`  → extractTrafficType 据此报告实际命中的 Vertex tier
 */
function withProviderUsage(usage: TokenUsage, steps: readonly StepProviderMetadataCarrier[]): TokenUsage {
  const cost = sumProviderReportedCost(steps);
  const raw = extractProviderUsageMetadata(steps);
  if (cost === undefined && raw === undefined) return usage;
  return { ...usage, ...(cost !== undefined && { cost }), ...(raw !== undefined && { raw }) };
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

function observeStreamFailure(usage: PromiseLike<unknown>, onFailure: (error: unknown) => void): void {
  // Fatal streams can reject usage without an onEnd/onAbort terminal callback.
  void Promise.resolve(usage).catch(onFailure);
}

// ═══════════════════════════════════════════════════════════════════════════
// Retry & Fallback
// ═══════════════════════════════════════════════════════════════════════════

const fallbackLogger = getAppLogger('features', 'LLM', 'fallback');

/** Reasoning-policy 400s: after param-level fallback still fails → allow provider fallback chain */
function isReasoningPolicyError(error: unknown): boolean {
  // APICallError extends Error — check it first so responseBody is included
  const msg = APICallError.isInstance(error)
    ? `${error.message} ${error.responseBody ?? ''}`
    : error instanceof Error
      ? error.message
      : String(error);
  return /reasoning is mandatory/i.test(msg) || /cannot be disabled/i.test(msg);
}

/**
 * A call that opts out of recording inputs or outputs must not let provider
 * payloads leave the process — not through captured requests, not through the
 * exceptions handed to logging and error telemetry.
 */
function isPrivateTelemetry(telemetry: { recordInputs?: boolean; recordOutputs?: boolean } | undefined): boolean {
  return telemetry?.recordInputs === false || telemetry?.recordOutputs === false;
}

/**
 * Validation issues name the failing path, and normally quote the value that
 * failed. That value is model output, so a caller that opted out of recording
 * outputs gets the paths and messages without it.
 *
 * @internal exported for testing
 */
export function formatValidationIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
  preprocessed: unknown,
  withholdOutput: boolean,
): string {
  return issues
    .slice(0, 5)
    .map((issue) => {
      // 从原始输入中提取失败字段的实际值
      let actual: unknown = preprocessed;
      for (const seg of issue.path) {
        if (actual != null && typeof actual === 'object') {
          actual = (actual as Record<string, unknown>)[String(seg)];
        } else {
          actual = undefined;
          break;
        }
      }
      const actualStr = withholdOutput || actual === undefined ? '' : ` (got ${JSON.stringify(actual)})`;
      return `${issue.path.join('.')}: ${issue.message}${actualStr}`;
    })
    .join('; ');
}

/** 判断错误是否值得 fallback（429/5xx/timeout/生成失败/reasoning 策略 400），非 retryable 的直接抛 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof Oops || error instanceof Oops.Block || error instanceof Oops.Panic) {
    const cause = error.cause;
    if (cause !== undefined) return isRetryableError(cause);
    if (error instanceof Oops.Block && error.httpStatus === 429) return true;
    // AI model error wrapper may carry reasoning-mandatory 400 in message
    if (isReasoningPolicyError(error)) return true;
    return false;
  }
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status === 429 || (status !== undefined && status >= 500)) return true;
    // Param fallback already applied at resolveSpec; remaining reasoning 400s → next provider in chain
    if (status === 400 && isReasoningPolicyError(error)) return true;
    return false;
  }
  // NoObjectGeneratedError：模型生成了文本但无法解析为合法 JSON。
  // HTTP 层面是 200 OK，但实际上是模型能力或格式问题，应 fallback 到其他模型重试。
  if (NoObjectGeneratedError.isInstance(error)) return true;
  // NoOutputGeneratedError：名字与上面几乎一样，含义完全不同 —— 模型**什么都没生成**
  // （`_output == null`），不像上面那个还带 text/finishReason/usage。
  // 生产实测（unee-ai-persona）：同 trace 的 `[LLM:end]` 是 `tokens=- (in=0, out=0)` ——
  // 连输入 token 都没计，说明 provider 返回的是空壳响应，与安全过滤 / token 上限 /
  // 模型能力都无关。这是典型的可重试场景，换个 provider 通常就好。
  // 漏了这一条的后果：配好的 fallback 一次都不会被调用，日志里表现为
  // `[LLM:fallback-exhausted] tried=[<只有主模型>]`（24h 内 70 events / 36 users）。
  if (NoOutputGeneratedError.isInstance(error)) return true;
  if (error instanceof DOMException && error.name === 'TimeoutError') return true;
  if (error instanceof Error && error.message.includes('timed out')) return true;
  if (isReasoningPolicyError(error)) return true;
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

/** checkBedrockServiceTierSupport 的单行结果 */
export interface BedrockServiceTierAvailability {
  /** registry key(如 'bedrock:kimi-k2.5') */
  key: string;
  /** Bedrock modelId(如 'moonshotai.kimi-k2.5') */
  modelId: string;
  flex: boolean | 'unknown';
  priority: boolean | 'unknown';
  /** 判定为 unknown 时的错误信息 */
  errors?: { flex?: string; priority?: string };
}

/** checkBedrockServiceTierSupport 的选项 */
export interface CheckBedrockServiceTierSupportOptions {
  /** 要探测的 key,默认全部注册的 bedrock:* */
  keys?: LLMModelKey[];
  /** 要探测的 tier,默认 ['flex', 'priority'] */
  tiers?: Array<'flex' | 'priority'>;
  /** 单次探测超时(毫秒),默认 45000 */
  timeoutMs?: number;
  /** 可注入的探测执行器(测试用),默认走真实 generateText */
  probe?: (spec: string) => Promise<void>;
}

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
   * 包含重放所需的一切：instructions（system prompt）、messages、完整 JSON Schema、model。
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
    instructions?: string,
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
            instructions,
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

    const rawData: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const parsedCapture = llmCaptureSchema.safeParse(rawData);
    if (!parsedCapture.success) {
      throw new Error(`Invalid AI SDK v7 capture file:\n${z.prettifyError(parsedCapture.error)}`);
    }

    const data = parsedCapture.data;
    const { id, method, model: modelKey, messages, jsonSchema: schemaObj, toolName, toolDescription } = data;
    const { instructions } = data;

    LLM.logger.info`[LLM:replay] id=${id}, method=${method}, model=${modelKey}`;

    const schema = wrapJsonSchema(schemaObj);
    const languageModel = createLanguageModel(modelKey as LLMModelKey);
    const startTime = Date.now();

    let output: unknown;
    let usage: unknown;

    if (method === 'generateObject' || method === 'streamObject') {
      // streamObject/generateObject 都走 Output.object（replay 不需要流式）
      const result = await generateText({
        model: languageModel,
        output: Output.object({ schema }),
        instructions,
        messages,
        allowSystemInMessages: allowsSystemInMessages(modelKey as LLMModelKey),
      });

      const duration = Date.now() - startTime;
      const cost = getCostFromUsage(result.usage, modelKey);
      LLM.logger
        .info`[LLM:replay:end] duration=${duration}ms, tokens=${result.usage.totalTokens ?? '-'}, cost=${cost !== null ? `$${cost.toFixed(6)}` : 'N/A'}`;

      output = result.output;
      usage = { ...result.usage, cost };
    } else {
      const tName = toolName ?? 'extract';
      const tools: ToolSet = {
        [tName]: tool({
          description: toolDescription ?? 'Extract structured data',
          inputSchema: schema,
        }),
      };
      const toolChoice: ToolChoice<typeof tools> = { type: 'tool', toolName: tName };
      const result = await generateText({
        model: languageModel,
        instructions,
        messages,
        tools,
        toolChoice,
        allowSystemInMessages: allowsSystemInMessages(modelKey as LLMModelKey),
      });

      const duration = Date.now() - startTime;
      const cost = getCostFromUsage(result.usage, modelKey);
      LLM.logger
        .info`[LLM:replay:end] duration=${duration}ms, tokens=${result.usage.totalTokens ?? '-'}, cost=${cost !== null ? `$${cost.toFixed(6)}` : 'N/A'}`;

      const toolCall = result.toolCalls.at(0);
      if (!toolCall || !('input' in toolCall)) {
        throw new Error('No tool call returned from LLM replay');
      }
      output = toolCall.input;
      usage = { ...result.usage, cost };
    }

    return { output, usage };
  }

  /**
   * Schema keys + messages 摘要日志
   *
   * 帮助排查"空 schema"等结构性问题，不需要开 Proxyman。
   */
  private static logInputSummary(id: string, schema: z.ZodType, messages: Message[], instructions?: string): void {
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

    const instructionsPart = instructions ? `, instructions=${instructions.length}ch` : '';

    LLM.logger
      .debug`[LLM:input] id=${id}, schema=[${schemaKeys.join(',')}], messages=[${msgSummary}]${instructionsPart}`;
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
    bedrockServiceTier?: BedrockServiceTier,
  ): void {
    const duration = Date.now() - startTime;
    const inputTokens = usage.inputTokens ?? usage.promptTokens ?? 0;
    const outputTokens = usage.outputTokens ?? usage.completionTokens ?? 0;
    const totalTokens = inputTokens + outputTokens;
    const cost = getCostFromUsage(usage, modelKey, { bedrockServiceTier });
    // 标注来源：reported=provider 实际扣费额，est=MODEL_PRICING 标价估算（可能过期/档位不符）
    const costSource = usage.cost !== undefined ? 'reported' : 'est';
    const costStr = cost !== null ? `, cost=$${cost.toFixed(6)}(${costSource})` : '';
    const fbPart = fb && fb.total > 1 ? `, attempt=${fb.attempt}/${fb.total}` : '';
    const trafficType = extractTrafficType(usage);
    const trafficPart = trafficType ? `, trafficType=${trafficType}` : '';
    const tierPart = formatTierLogPart(tier, vertexRequestType);
    const serviceTierPart = bedrockServiceTier ? `, bedrockServiceTier=${bedrockServiceTier}` : '';
    LLM.logger
      .info`[LLM:end] id=${id}, method=${method}, model=${modelKey}${tierPart}${serviceTierPart}, duration=${duration}ms, tokens=${totalTokens || '-'} (in=${inputTokens}, out=${outputTokens})${costStr}${fbPart}${trafficPart}`;

    // 请求了非 standard tier 但 Vertex 实际按别的档路由 —— 不报错、按标准价计费，
    // 只有把请求的 tier 与回报的 trafficType 并排比才看得出来。不改路由行为，只暴露事实。
    if (tier && tier !== 'standard' && trafficType) {
      const expected = VERTEX_TIER_TRAFFIC_TYPE[tier];
      if (trafficType !== expected) {
        LLM.logger
          .warning`[LLM:tier-not-honored] id=${id}, model=${modelKey}, requested=${tier}, expected=${expected}, actual=${trafficType}`;
      }
    }
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

  /**
   * 流式错误事件（非终态）。
   *
   * `onErrorResult` 是 caller onError 回调透传回 AI SDK 的返回值 —— 记录它是为了让
   * 「retry 指令确实被交回 SDK」这件事在生产可观测；`streamRetries` 未配置时 SDK 会
   * 静默忽略该指令，这里显式告警，避免又一个「注册了但没进管线」。
   */
  private static logErrorEvent(
    id: string,
    method: string,
    modelKey: string,
    error: unknown,
    onErrorResult?: StreamOnErrorResult,
    streamRetries?: number,
  ): void {
    // onErrorResult 原值直出，不经任何判断 —— 判断写错会让日志本身骗人
    LLM.logger
      .warning`[LLM:error-event] id=${id}, method=${method}, model=${modelKey}, onErrorResult=${onErrorResult} ${error}`;
    if (isStreamRetryRequested(onErrorResult) && streamRetries === undefined) {
      LLM.logger
        .warning`[LLM:retry-ignored] id=${id}, method=${method}, model=${modelKey} — onError returned {retry:true} but ai.streamRetries is unset, the AI SDK will ignore it`;
    }
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
   * Internal throwing implementation used by the Result boundary adapter.
   * @see neverthrow-result-pattern skill
   */
  private static async generateObjectCore<T>(params: GenerateObjectParams<T>): Promise<GenerateObjectResult<T>> {
    const {
      model: modelSpec,
      id,
      schema,
      instructions,
      messages,
      thinking: callerThinking = 'none',
      openrouter,
      temperature,
      maxOutputTokens,
      abortSignal,
      timeout: callerTimeout,
      maxRetries: callerMaxRetries,
      telemetry = DEFAULT_TELEMETRY,
    } = params;

    const spec = resolveSpec(modelSpec, callerThinking, callerMaxRetries, callerTimeout);
    const openrouterOptions = resolveOpenRouterCallOptions(spec.openrouter, openrouter);

    return withFallback(id, 'generateObject', spec, async (modelKey, fb) => {
      const startTime = Date.now();
      // Per-key policy from original intent (not primary's already-fallback'd thinking)
      const effectiveThinking = resolveThinkingForModel(modelKey, spec.requestedThinking).thinking;
      LLM.logStart(id, 'generateObject', modelKey, effectiveThinking, fb, spec.vertex?.tier, spec.vertex?.requestType);
      LLM.logInputSummary(id, schema, messages, instructions);
      if (telemetry.recordInputs !== false) {
        LLM.captureRequest(id, 'generateObject', modelKey, schema, messages, instructions);
      }

      const languageModel = privateModel(createLanguageModel(modelKey), isPrivateTelemetry(telemetry));
      const provider = getProvider(modelKey);
      const providerOptions = buildProviderOptions(
        provider,
        effectiveThinking,
        modelKey,
        openrouterOptions,
        spec.bedrock,
      );
      const tierHeaders = buildTierHeaders(modelKey, spec.vertex?.tier, spec.vertex?.requestType);

      const { signal, cleanup } = createManagedSignal(spec.timeout, abortSignal);

      try {
        const result = await generateText({
          model: languageModel,
          output: Output.object({ schema }),
          instructions,
          messages,
          providerOptions,
          headers: tierHeaders,
          temperature,
          maxOutputTokens,
          maxRetries: spec.maxRetries,
          abortSignal: signal,
          telemetry: withProvenanceTelemetry(telemetry),
          runtimeContext: mergeProvenanceRuntimeContext(),
          allowSystemInMessages: allowsSystemInMessages(modelKey),
        });

        cleanup();
        LLM.logEnd(
          id,
          'generateObject',
          modelKey,
          startTime,
          withProviderUsage(result.usage, result.steps),
          fb,
          spec.vertex?.tier,
          spec.vertex?.requestType,
          spec.bedrock?.serviceTier,
        );

        return {
          object: result.output,
          usage: withProviderUsage(result.usage, result.steps),
        };
      } catch (error) {
        cleanup();
        // SDK errors can contain prompt/response bodies, including in their causes.
        const safeError = isPrivateTelemetry(telemetry) ? privateModelError(error) : error;
        const classified = LLM.classifyError(safeError, modelKey);
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
   * 这是受支持的 Promise/throw 边界。内部编排应使用 `safeGenerateObject`；
   * 需要 Promise 契约的框架边界可使用本方法，将 Err(OopsError) 转为 throw。
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
   * 这是受支持的 Promise/throw 边界。内部编排应使用 `safeGenerateObjectViaTool`；
   * 需要 Promise 契约的框架边界可使用本方法，将 Err(OopsError) 转为 throw。
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
  static safeGenerateText<TOOLS extends ToolSet = ToolSet, RUNTIME_CONTEXT extends Context = Context>(
    params: GenerateTextParams<TOOLS, RUNTIME_CONTEXT>,
  ): ResultAsync<GenerateTextResult, OopsError> {
    return LLM.toResult(LLM.generateTextCore(params), params.model);
  }

  /**
   * 文本生成（边界适配层）
   *
   * 内部实现统一走 `safeGenerateText`，这里只在边界处将 Err(OopsError) 转为 throw。
   */
  static async generateText<TOOLS extends ToolSet = ToolSet, RUNTIME_CONTEXT extends Context = Context>(
    params: GenerateTextParams<TOOLS, RUNTIME_CONTEXT>,
  ): Promise<GenerateTextResult> {
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
   *   model: 'openrouter:grok-4.3',
   *   messages: [{ role: 'user', content: 'Hello' }],
   * });
   * ```
   */
  private static async generateTextCore<TOOLS extends ToolSet = ToolSet, RUNTIME_CONTEXT extends Context = Context>(
    params: GenerateTextParams<TOOLS, RUNTIME_CONTEXT>,
  ): Promise<GenerateTextResult> {
    const {
      model: modelSpec,
      id,
      instructions,
      messages,
      thinking: callerThinking = 'none',
      openrouter,
      temperature,
      maxOutputTokens,
      abortSignal,
      timeout: callerTimeout,
      maxRetries: callerMaxRetries,
      telemetry: callerTelemetry,
      ai,
      modelIdSuffix,
    } = params;

    const spec = resolveSpec(modelSpec, callerThinking, callerMaxRetries, callerTimeout);
    const openrouterOptions = resolveOpenRouterCallOptions(spec.openrouter, openrouter);
    const telemetry = callerTelemetry ?? ai?.telemetry ?? DEFAULT_TELEMETRY;

    return withFallback(id, 'generateText', spec, async (modelKey, fb) => {
      const startTime = Date.now();
      const effectiveThinking = resolveThinkingForModel(modelKey, spec.requestedThinking).thinking;
      LLM.logStart(id, 'generateText', modelKey, effectiveThinking, fb, spec.vertex?.tier, spec.vertex?.requestType);

      const aiOptions = resolveLLMAIOptions<TOOLS, RUNTIME_CONTEXT, LLMGenerateTextAIOptions<TOOLS, RUNTIME_CONTEXT>>(
        ai,
        {
          id,
          method: 'generateText',
          modelSpec: modelKey,
          modelIdSuffix,
          thinking: effectiveThinking,
          openrouter: openrouterOptions,
          privateTelemetry: isPrivateTelemetry(telemetry),
        },
      );
      const languageModel = privateModel(
        createLanguageModelForCall(modelKey, modelIdSuffix),
        isPrivateTelemetry(telemetry),
      );
      const provider = getProvider(modelKey);
      const providerOptions = buildProviderOptions(
        provider,
        effectiveThinking,
        modelKey,
        openrouterOptions,
        spec.bedrock,
      );
      const tierHeaders = buildTierHeaders(modelKey, spec.vertex?.tier, spec.vertex?.requestType);
      const headers = mergeHeaders(aiOptions?.headers, tierHeaders);

      const { signal, cleanup } = createManagedSignal(spec.timeout, abortSignal ?? aiOptions?.abortSignal);
      const runtimeContext = mergeProvenanceRuntimeContext<RUNTIME_CONTEXT>(aiOptions?.runtimeContext);

      try {
        const result = await generateText({
          ...(aiOptions ?? {}),
          model: languageModel,
          ...(instructions !== undefined ? { instructions } : {}),
          prompt: undefined,
          messages,
          providerOptions,
          headers,
          ...(temperature !== undefined ? { temperature } : {}),
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
          maxRetries: spec.maxRetries,
          abortSignal: signal,
          telemetry: withProvenanceTelemetry(telemetry),
          ...(runtimeContext !== undefined ? { runtimeContext } : {}),
          allowSystemInMessages: allowsSystemInMessages(modelKey),
        });

        cleanup();

        const sourcesCount = result.sources.length;
        if (sourcesCount > 0) {
          LLM.logger.debug`[LLM:sources] id=${id}, sources=${sourcesCount}`;
        }

        LLM.logEnd(
          id,
          'generateText',
          modelKey,
          startTime,
          withProviderUsage(result.usage, result.steps),
          fb,
          spec.vertex?.tier,
          spec.vertex?.requestType,
          spec.bedrock?.serviceTier,
        );

        return {
          text: result.text,
          usage: withProviderUsage(result.usage, result.steps),
          sources: extractWebSources(result.sources),
        };
      } catch (error) {
        cleanup();
        const classified = LLM.classifyError(
          isPrivateTelemetry(telemetry) ? privateModelError(error) : error,
          modelKey,
        );
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
   *   model: 'openrouter:grok-4.3',
   *   schema: MySchema,
   *   messages,
   * });
   *
   * for await (const chunk of stream.partialObjectStream) {
   *   console.log(chunk);
   * }
   * ```
   */
  static streamObject<T, TOOLS extends ToolSet = ToolSet, RUNTIME_CONTEXT extends Context = Context>(
    params: StreamObjectParams<T, TOOLS, RUNTIME_CONTEXT>,
  ): LLMStreamTextResult<TOOLS, RUNTIME_CONTEXT, ReturnType<typeof Output.object<T>>> {
    const startTime = Date.now();
    const {
      model: modelSpec,
      id,
      schema,
      instructions,
      messages,
      thinking: callerThinking = 'none',
      openrouter,
      temperature,
      maxOutputTokens,
      abortSignal,
      timeout: callerTimeout,
      maxRetries: callerMaxRetries,
      telemetry: callerTelemetry,
      ai,
    } = params;

    const spec = resolveSpec(modelSpec, callerThinking, callerMaxRetries, callerTimeout);
    const openrouterOptions = resolveOpenRouterCallOptions(spec.openrouter, openrouter);
    const telemetry: TelemetryOptions<RUNTIME_CONTEXT, TOOLS> = callerTelemetry ?? ai?.telemetry ?? DEFAULT_TELEMETRY;
    const aiOptions = resolveLLMAIOptions<TOOLS, RUNTIME_CONTEXT, LLMStreamTextAIOptions<TOOLS, RUNTIME_CONTEXT>>(ai, {
      id,
      method: 'streamObject',
      modelSpec,
      thinking: spec.thinking,
      openrouter: openrouterOptions,
      extractJson: true,
      privateTelemetry: isPrivateTelemetry(telemetry),
    });
    const { key: modelKey } = spec;
    if (spec.fallbackModels.length > 0) {
      fallbackLogger.warning`[LLM:fallback-ignored] id=${id}, method=streamObject — stream methods do not support fallback, only primary model=${modelKey} will be used. fallback=[${spec.fallbackModels.join(',')}]`;
    }
    LLM.logStart(id, 'streamObject', modelKey, spec.thinking, undefined, spec.vertex?.tier, spec.vertex?.requestType);
    LLM.logInputSummary(id, schema, messages, instructions);
    if (telemetry.recordInputs !== false) {
      LLM.captureRequest(id, 'streamObject', modelKey, schema, messages, instructions);
    }

    const model = privateModel(
      createLanguageModelForCall(modelKey, undefined, { extractJson: true }),
      isPrivateTelemetry(telemetry),
    );

    const provider = getProvider(modelKey);
    const providerOptions = buildProviderOptions(provider, spec.thinking, modelKey, openrouterOptions, spec.bedrock);
    const tierHeaders = buildTierHeaders(modelKey, spec.vertex?.tier, spec.vertex?.requestType);
    const headers = mergeHeaders(aiOptions?.headers, tierHeaders);

    const { signal, cleanup } = createManagedSignal(spec.timeout, abortSignal ?? aiOptions?.abortSignal);

    let ttftLogged = false;

    type StreamOnErrorEvent = Parameters<NonNullable<LLMStreamTextAIOptions<TOOLS, RUNTIME_CONTEXT>['onError']>>[0];
    type StreamOnChunkEvent = Parameters<NonNullable<LLMStreamTextAIOptions<TOOLS, RUNTIME_CONTEXT>['onChunk']>>[0];
    type StreamOnEndEvent = Parameters<NonNullable<LLMStreamTextAIOptions<TOOLS, RUNTIME_CONTEXT>['onEnd']>>[0];
    type StreamOnAbortEvent = Parameters<NonNullable<LLMStreamTextAIOptions<TOOLS, RUNTIME_CONTEXT>['onAbort']>>[0];

    // spread 前剥离 caller 的原始生命周期回调，统一在下方组合为单一 handler，
    // 保证 caller 回调 → managed-signal cleanup → 内部日志各恰好执行一次
    const {
      onEnd: callerOnEnd,
      onError: callerOnError,
      onChunk: callerOnChunk,
      onAbort: callerOnAbort,
      ...restAiOptions
    } = aiOptions ?? {};

    const lifecycle = createStreamLifecycle<
      StreamOnErrorEvent,
      StreamOnEndEvent,
      StreamOnAbortEvent,
      StreamOnErrorResult
    >(
      {
        onError: callerOnError,
        onEnd: callerOnEnd,
        onAbort: callerOnAbort,
      },
      {
        cleanup,
        logErrorEvent: (event, result) => {
          LLM.logErrorEvent(
            id,
            'streamObject',
            modelKey,
            isPrivateTelemetry(telemetry) ? privateModelError(event.error) : event.error,
            result,
            aiOptions?.streamRetries,
          );
        },
        logSuccess: (event) => {
          LLM.logEnd(
            id,
            'streamObject',
            modelKey,
            startTime,
            withProviderUsage(event.usage, event.steps),
            undefined,
            spec.vertex?.tier,
            spec.vertex?.requestType,
            spec.bedrock?.serviceTier,
          );
        },
        logAbort: () => {
          LLM.logger
            .info`[LLM:abort] id=${id}, method=streamObject, model=${modelKey}, duration=${Date.now() - startTime}ms`;
        },
        logFailure: (error) => {
          LLM.logError(id, 'streamObject', modelKey, isPrivateTelemetry(telemetry) ? privateModelError(error) : error);
        },
      },
    );

    const output = Output.object({ schema });
    const streamRequest = {
      ...restAiOptions,
      model,
      output,
      ...(instructions !== undefined ? { instructions } : {}),
      prompt: undefined,
      messages,
      providerOptions,
      headers,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      maxRetries: spec.maxRetries,
      abortSignal: signal,
      telemetry: withProvenanceTelemetry(telemetry),
      runtimeContext: mergeProvenanceRuntimeContext<RUNTIME_CONTEXT>(aiOptions?.runtimeContext),
      allowSystemInMessages: allowsSystemInMessages(modelKey),
      onError: lifecycle.onError,
      onChunk: async (event: StreamOnChunkEvent) => {
        await callerOnChunk?.(event);
        if (!ttftLogged) {
          LLM.logTTFT(id, startTime);
          ttftLogged = true;
        }
      },
      onAbort: lifecycle.onAbort,
      onEnd: lifecycle.onEnd,
    } as Parameters<typeof streamText<TOOLS, RUNTIME_CONTEXT, typeof output>>[0];

    try {
      const result = streamText<TOOLS, RUNTIME_CONTEXT, typeof output>(streamRequest);
      observeStreamFailure(result.usage, (error) => {
        lifecycle.fail(error);
      });
      return result;
    } catch (error) {
      lifecycle.fail(error);
      throw error;
    }
  }

  /**
   * 流式文本生成
   *
   * @example
   * ```typescript
   * const stream = LLM.streamText({
   *   model: 'openrouter:grok-4.3',
   *   messages,
   * });
   *
   * for await (const chunk of stream.textStream) {
   *   process.stdout.write(chunk);
   * }
   * ```
   */
  static streamText<
    TOOLS extends ToolSet = ToolSet,
    RUNTIME_CONTEXT extends Context = Context,
    OUTPUT extends Output.Output = Output.Output<string, string, never>,
  >(params: StreamTextParams<TOOLS, RUNTIME_CONTEXT, OUTPUT>): LLMStreamTextResult<TOOLS, RUNTIME_CONTEXT, OUTPUT> {
    const startTime = Date.now();
    const {
      model: modelSpec,
      id,
      instructions,
      messages,
      thinking: callerThinking = 'none',
      openrouter,
      temperature,
      maxOutputTokens,
      abortSignal,
      timeout: callerTimeout,
      maxRetries: callerMaxRetries,
      telemetry: callerTelemetry,
      output,
      ai,
    } = params;

    const spec = resolveSpec(modelSpec, callerThinking, callerMaxRetries, callerTimeout);
    const openrouterOptions = resolveOpenRouterCallOptions(spec.openrouter, openrouter);
    const telemetry: TelemetryOptions<RUNTIME_CONTEXT, TOOLS> = callerTelemetry ?? ai?.telemetry ?? DEFAULT_TELEMETRY;
    const aiOptions = resolveLLMAIOptions<
      TOOLS,
      RUNTIME_CONTEXT,
      LLMStreamTextAIOptions<TOOLS, RUNTIME_CONTEXT, OUTPUT>
    >(ai, {
      id,
      method: 'streamText',
      modelSpec,
      thinking: spec.thinking,
      openrouter: openrouterOptions,
      privateTelemetry: isPrivateTelemetry(telemetry),
    });
    const { key: modelKey } = spec;
    if (spec.fallbackModels.length > 0) {
      fallbackLogger.warning`[LLM:fallback-ignored] id=${id}, method=streamText — stream methods do not support fallback, only primary model=${modelKey} will be used. fallback=[${spec.fallbackModels.join(',')}]`;
    }
    LLM.logStart(id, 'streamText', modelKey, spec.thinking, undefined, spec.vertex?.tier, spec.vertex?.requestType);

    const languageModel = privateModel(createLanguageModelForCall(modelKey, undefined), isPrivateTelemetry(telemetry));
    const provider = getProvider(modelKey);
    const providerOptions = buildProviderOptions(provider, spec.thinking, modelKey, openrouterOptions, spec.bedrock);
    const tierHeaders = buildTierHeaders(modelKey, spec.vertex?.tier, spec.vertex?.requestType);
    const headers = mergeHeaders(aiOptions?.headers, tierHeaders);

    const { signal, cleanup } = createManagedSignal(spec.timeout, abortSignal ?? aiOptions?.abortSignal);

    let ttftLogged = false;

    type StreamOnErrorEvent = Parameters<
      NonNullable<LLMStreamTextAIOptions<TOOLS, RUNTIME_CONTEXT, OUTPUT>['onError']>
    >[0];
    type StreamOnChunkEvent = Parameters<
      NonNullable<LLMStreamTextAIOptions<TOOLS, RUNTIME_CONTEXT, OUTPUT>['onChunk']>
    >[0];
    type StreamOnEndEvent = Parameters<NonNullable<LLMStreamTextAIOptions<TOOLS, RUNTIME_CONTEXT, OUTPUT>['onEnd']>>[0];
    type StreamOnAbortEvent = Parameters<
      NonNullable<LLMStreamTextAIOptions<TOOLS, RUNTIME_CONTEXT, OUTPUT>['onAbort']>
    >[0];

    const {
      onEnd: callerOnEnd,
      onError: callerOnError,
      onChunk: callerOnChunk,
      onAbort: callerOnAbort,
      ...restAiOptions
    } = aiOptions ?? {};

    const lifecycle = createStreamLifecycle<
      StreamOnErrorEvent,
      StreamOnEndEvent,
      StreamOnAbortEvent,
      StreamOnErrorResult
    >(
      {
        onError: callerOnError,
        onEnd: callerOnEnd,
        onAbort: callerOnAbort,
      },
      {
        cleanup,
        logErrorEvent: (event, result) => {
          LLM.logErrorEvent(
            id,
            'streamText',
            modelKey,
            isPrivateTelemetry(telemetry) ? privateModelError(event.error) : event.error,
            result,
            aiOptions?.streamRetries,
          );
        },
        logSuccess: (event) => {
          LLM.logEnd(
            id,
            'streamText',
            modelKey,
            startTime,
            withProviderUsage(event.usage, event.steps),
            undefined,
            spec.vertex?.tier,
            spec.vertex?.requestType,
            spec.bedrock?.serviceTier,
          );
        },
        logAbort: () => {
          LLM.logger
            .info`[LLM:abort] id=${id}, method=streamText, model=${modelKey}, duration=${Date.now() - startTime}ms`;
        },
        logFailure: (error) => {
          LLM.logError(id, 'streamText', modelKey, isPrivateTelemetry(telemetry) ? privateModelError(error) : error);
        },
      },
    );

    const streamRequest: Parameters<typeof streamText<TOOLS, RUNTIME_CONTEXT, OUTPUT>>[0] = {
      ...restAiOptions,
      model: languageModel,
      ...(instructions !== undefined ? { instructions } : {}),
      prompt: undefined,
      messages,
      providerOptions,
      headers,
      ...(output !== undefined ? { output } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      maxRetries: spec.maxRetries,
      abortSignal: signal,
      telemetry: withProvenanceTelemetry(telemetry),
      runtimeContext: mergeProvenanceRuntimeContext<RUNTIME_CONTEXT>(aiOptions?.runtimeContext),
      allowSystemInMessages: allowsSystemInMessages(modelKey),
      onError: lifecycle.onError,
      onChunk: async (event: StreamOnChunkEvent) => {
        await callerOnChunk?.(event);
        if (!ttftLogged) {
          LLM.logTTFT(id, startTime);
          ttftLogged = true;
        }
      },
      onAbort: lifecycle.onAbort,
      onEnd: lifecycle.onEnd,
    };

    try {
      const result = streamText<TOOLS, RUNTIME_CONTEXT, OUTPUT>(streamRequest);
      observeStreamFailure(result.usage, (error) => {
        lifecycle.fail(error);
      });
      return result;
    } catch (error) {
      lifecycle.fail(error);
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tool Calling 模式
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 通过 Tool Calling 生成结构化对象（Promise 版，throws on error）
   *
   * Internal throwing implementation used by the Result boundary adapter.
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
      instructions,
      messages,
      thinking: callerThinking = 'none',
      openrouter,
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
    const openrouterOptions = resolveOpenRouterCallOptions(spec.openrouter, openrouter);

    return withFallback(id, 'generateObjectViaTool', spec, async (modelKey, fb) => {
      const startTime = Date.now();
      const effectiveThinking = resolveThinkingForModel(modelKey, spec.requestedThinking).thinking;
      LLM.logStart(
        id,
        'generateObjectViaTool',
        modelKey,
        effectiveThinking,
        fb,
        spec.vertex?.tier,
        spec.vertex?.requestType,
      );
      LLM.logInputSummary(id, schema, messages, instructions);
      if (telemetry.recordInputs !== false) {
        LLM.captureRequest(id, 'generateObjectViaTool', modelKey, schema, messages, instructions, {
          toolName,
          toolDescription,
        });
      }

      const languageModel = privateModel(createLanguageModel(modelKey), isPrivateTelemetry(telemetry));
      const provider = getProvider(modelKey);
      const baseProviderOptions = buildProviderOptions(
        provider,
        effectiveThinking,
        modelKey,
        openrouterOptions,
        spec.bedrock,
      );

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
      const tierHeaders = buildTierHeaders(modelKey, spec.vertex?.tier, spec.vertex?.requestType);

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
          instructions,
          messages,
          tools,
          toolChoice,
          providerOptions,
          headers: tierHeaders,
          temperature,
          maxOutputTokens,
          maxRetries: spec.maxRetries,
          abortSignal: signal,
          telemetry: withProvenanceTelemetry(telemetry),
          runtimeContext: mergeProvenanceRuntimeContext(),
          allowSystemInMessages: allowsSystemInMessages(modelKey),
        });

        cleanup();
        LLM.logEnd(
          id,
          'generateObjectViaTool',
          modelKey,
          startTime,
          withProviderUsage(result.usage, result.steps),
          fb,
          spec.vertex?.tier,
          spec.vertex?.requestType,
          spec.bedrock?.serviceTier,
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
          // 完整打印原始 tool call 输出——这是诊断 validation 失败的关键证据。
          // 调用方要求不记录输出时，这里同样不能打印，否则脱敏只是形式。
          const withholdOutput = isPrivateTelemetry(telemetry);
          if (!withholdOutput) {
            LLM.logger.warning`[LLM:validation-failed] id=${id} rawInput=${JSON.stringify(rawInput)}`;
            LLM.logger.warning`[LLM:validation-failed] id=${id} preprocessed=${JSON.stringify(preprocessed)}`;
          } else {
            LLM.logger.warning`[LLM:validation-failed] id=${id} output withheld`;
          }

          const issues = formatValidationIssues(parseResult.error.issues, preprocessed, withholdOutput);
          throw Oops.Panic.AIObjectGenerationFailed(modelKey, 'validation-failed', issues);
        }

        return {
          object: parseResult.data,
          usage: withProviderUsage(result.usage, result.steps),
        };
      } catch (error) {
        cleanup();
        const classified = LLM.classifyError(
          isPrivateTelemetry(telemetry) ? privateModelError(error) : error,
          modelKey,
        );
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
   *   model: 'openrouter:gemini-3.7-flash',
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
      instructions,
      messages,
      thinking: callerThinking = 'none',
      openrouter,
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
    const openrouterOptions = resolveOpenRouterCallOptions(spec.openrouter, openrouter);
    const { key: modelKey } = spec;
    if (spec.fallbackModels.length > 0) {
      fallbackLogger.warning`[LLM:fallback-ignored] id=${id}, method=streamObjectViaTool — stream methods do not support fallback, only primary model=${modelKey} will be used. fallback=[${spec.fallbackModels.join(',')}]`;
    }
    LLM.logStart(
      id,
      'streamObjectViaTool',
      modelKey,
      spec.thinking,
      undefined,
      spec.vertex?.tier,
      spec.vertex?.requestType,
    );

    const languageModel = privateModel(createLanguageModel(modelKey), isPrivateTelemetry(telemetry));
    const provider = getProvider(modelKey);
    const providerOptions = buildProviderOptions(provider, spec.thinking, modelKey, openrouterOptions, spec.bedrock);
    const tierHeaders = buildTierHeaders(modelKey, spec.vertex?.tier, spec.vertex?.requestType);

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
      instructions,
      messages,
      tools,
      toolChoice,
      providerOptions,
      headers: tierHeaders,
      temperature,
      maxOutputTokens,
      maxRetries: spec.maxRetries,
      abortSignal: signal,
      telemetry: withProvenanceTelemetry(telemetry),
      runtimeContext: mergeProvenanceRuntimeContext(),
      allowSystemInMessages: allowsSystemInMessages(modelKey),
      onError: ({ error }) => {
        LLM.logErrorEvent(
          id,
          'streamObjectViaTool',
          modelKey,
          isPrivateTelemetry(telemetry) ? privateModelError(error) : error,
        );
      },
    });

    let ttftLogged = false;

    // 用于累积 JSON 字符串
    let jsonBuffer = '';
    let lastPartial: Partial<T> | null = null;

    try {
      // 遍历 v7 canonical stream 获取 tool-input 相关事件
      for await (const event of result.stream) {
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

      const usage = withProviderUsage(await result.usage, await result.steps);
      LLM.logEnd(
        id,
        'streamObjectViaTool',
        modelKey,
        startTime,
        usage,
        undefined,
        spec.vertex?.tier,
        spec.vertex?.requestType,
        spec.bedrock?.serviceTier,
      );
      yield { type: 'usage', usage };
    } catch (error) {
      LLM.logError(
        id,
        'streamObjectViaTool',
        modelKey,
        isPrivateTelemetry(telemetry) ? privateModelError(error) : error,
      );
      throw error;
    } finally {
      cleanup();
    }
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
      throw Oops.Panic.Invariant(`Embedding input text is empty: id=${id} type=${typeof text} length=${text.length}`);
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
        const apiKey = SysEnv.AI_JINA_API_KEY;
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
        const apiKey = SysEnv.AI_VOYAGE_API_KEY;
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
    return createLanguageModel(key);
  }

  /**
   * 探测当前账号/区域下各 bedrock 模型的 serviceTier 支持矩阵(live 调用)。
   *
   * tier 支持度随账号/区域/AWS 扩容动态变化(2026-07-20 实证:Claude 全系与 nova-lite
   * 在 us-east-1/us-east-2 均不接受 flex/priority,kimi/deepseek/minimax/nova-pro/
   * nova-2 接受),因此库内不写死矩阵,由使用方在目标账号/区域自查。
   * 每次探测对每个 key 的每个 tier 发一次最小 generateText(maxRetries=0),
   * "service tier is not supported" 判定为不支持,其余错误标 unknown 并附错误信息。
   *
   * @example
   * ```ts
   * const matrix = await LLM.checkBedrockServiceTierSupport();
   * console.table(matrix);
   * ```
   */
  static async checkBedrockServiceTierSupport(
    options?: CheckBedrockServiceTierSupportOptions,
  ): Promise<BedrockServiceTierAvailability[]> {
    const keys = options?.keys ?? (getRegisteredModels().filter((k) => k.startsWith('bedrock:')) as LLMModelKey[]);
    const tiers = options?.tiers ?? ['flex', 'priority'];
    const probe =
      options?.probe ??
      (async (spec: string) => {
        await LLM.generateText({
          id: 'bedrock-tier-availability-probe',
          model: spec as LLMModelSpec,
          messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
          maxRetries: 0,
          timeout: options?.timeoutMs ?? 45_000,
        });
      });

    const matrix: BedrockServiceTierAvailability[] = [];
    for (const key of keys) {
      const row: BedrockServiceTierAvailability = {
        key,
        modelId: getModel(key).modelId,
        flex: 'unknown',
        priority: 'unknown',
      };
      for (const tier of tiers) {
        try {
          await probe(`${key}?bedrock.serviceTier=${tier}`);
          row[tier] = true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/service tier is not supported/i.test(message)) {
            row[tier] = false;
          } else {
            row[tier] = 'unknown';
            row.errors = { ...row.errors, [tier]: message.slice(0, 200) };
          }
        }
      }
      matrix.push(row);
    }
    return matrix;
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
