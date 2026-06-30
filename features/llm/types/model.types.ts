/**
 * LLM Model Registry 类型定义
 *
 * 设计意图：
 * - Provider 和 Model 直接绑定（一个 Model Key 对应一个 Provider）
 * - Key 格式：provider:model（如 openrouter:gemini-2.5-flash）
 * - 同一模型可通过不同 Provider 访问（如 openrouter:gemini vs google:gemini）
 * - Provider 类型从 Model Registry 自动推导，无需单独维护
 *
 * Fallback 机制：
 * - 开发环境：model 不存在时直接报错（fail fast）
 * - 生产环境：model 不存在时 warning + fallback 到 DEFAULT_LLM_MODEL
 *
 * 扩展方式：
 * ```typescript
 * declare module '@app/llm-core' {
 *   interface LLMModelRegistry {
 *     'moonshot:kimi-k2': ModelConfig<'moonshot'>;
 *   }
 * }
 * registerModel('moonshot:kimi-k2', { provider: 'moonshot', modelId: 'kimi-k2' });
 * ```
 */

import { getLLMModelFields, SysEnv } from '@app/env';
import { getAppLogger } from '@app/utils/app-logger';

/**
 * Vertex 特有概念，通过 `X-Vertex-AI-LLM-Shared-Request-Type` header 传递。
 * `vertex-global:*` 是与 Google 官方 Priority/Flex PayGo URL 完全一致的路径；
 * `vertex:*` 是 Express Mode 兼容路径。
 * 具体哪些模型支持以 Google 官方文档为准（运行时由 `supportedTiers` 标注 + 降级）。
 *
 * - `standard`: 共享配额池（默认）
 * - `flex`: 低优先级 / 低价，请求可能排队
 * - `priority`: 独立配额桶，价格溢价
 *
 * @see https://docs.cloud.google.com/vertex-ai/generative-ai/docs/flex-paygo
 * @see https://docs.cloud.google.com/vertex-ai/generative-ai/docs/priority-paygo
 */
export type VertexTier = 'standard' | 'flex' | 'priority';

/**
 * Vertex `X-Vertex-AI-LLM-Request-Type` header.
 *
 * 目前只暴露 Google 文档中用于“只使用 Flex/Priority PayGo”的 `shared`。
 * 未设置时保留默认行为：如有 Provisioned Throughput，先用 PT，再溢出到对应 tier。
 *
 * @see https://docs.cloud.google.com/vertex-ai/generative-ai/docs/flex-paygo
 * @see https://docs.cloud.google.com/vertex-ai/generative-ai/docs/priority-paygo
 */
export type VertexRequestType = 'shared';

/** 模块级单例，避免 `supportedTiers` 缺省时每次调用都分配新数组 */
export const DEFAULT_SUPPORTED_TIERS: readonly VertexTier[] = ['standard'];

/**
 * Model 配置接口
 */
export interface ModelConfig<P extends string = string> {
  /** Provider 标识 */
  provider: P;
  /** 实际 API Model ID（发送给 Provider 的值） */
  modelId: string;
  /** UI 显示名称（可选） */
  displayName?: string;
  /**
   * 模型强制启用 reasoning，无法关闭
   *
   * 标记为 true 时，LLM class 不会发送 disableThinking 选项。
   * 例：MiniMax M2.5（400 "Reasoning is mandatory"）、Grok 4.1 Fast（参数无效）
   */
  reasoningRequired?: boolean;
  /**
   * 该模型支持的 Vertex tier 列表（仅 vertex / vertex-global provider 相关）
   *
   * - 未填 = 默认只支持 `standard`
   * - 其他 provider 应留空
   * - 以 Google 官方 Flex/Priority PayGo 文档列表为准
   *
   * 运行时传入不支持的 tier 不会抛异常，只 warn + 降级到 standard。
   */
  supportedTiers?: readonly VertexTier[];
}

/**
 * Model Registry 接口（项目层可通过 Declaration Merging 扩展）
 *
 * Key 格式：provider:model
 */
/**
 * Model Registry 接口（项目层可通过 Declaration Merging 扩展）
 *
 * Key 格式：provider:model
 *
 * OpenRouter Key 支持两种格式（等价，并存）：
 * - 简称：openrouter:gemini-2.5-flash
 * - 全称：openrouter:google/gemini-2.5-flash（与 OpenRouter modelId 一致）
 *
 * OpenRouter Provider 定价差异：
 * 各 provider 定价不同，选型时可通过 providerSort（price/throughput/latency）控制路由偏好。
 *
 * @see https://openrouter.ai/models
 */
export interface LLMModelRegistry {
  // ==================== OpenRouter ====================
  /**
   * Gemini 2.5 Flash
   *
   * 定价参考（2026.02）：Input $0.30/M, Output $2.50/M, Context 1M
   *
   * @see https://openrouter.ai/google/gemini-2.5-flash
   */
  'openrouter:gemini-2.5-flash': ModelConfig<'openrouter'>;
  'openrouter:google/gemini-2.5-flash': ModelConfig<'openrouter'>;
  /**
   * Gemini 2.5 Pro
   *
   * 定价参考（2026.02）：Input $1.25/M, Output $10/M（≤200K），Context 1M
   *
   * @see https://openrouter.ai/google/gemini-2.5-pro
   */
  'openrouter:gemini-2.5-pro': ModelConfig<'openrouter'>;
  'openrouter:google/gemini-2.5-pro': ModelConfig<'openrouter'>;
  /**
   * Gemini 2.5 Flash Lite
   *
   * 定价参考（2026.02）：Input $0.10/M, Output $0.40/M, Context 1M
   *
   * @see https://openrouter.ai/google/gemini-2.5-flash-lite
   */
  'openrouter:gemini-2.5-flash-lite': ModelConfig<'openrouter'>;
  'openrouter:google/gemini-2.5-flash-lite': ModelConfig<'openrouter'>;
  /**
   * Gemini 3 Flash Preview - Tool Calling #1
   *
   * 定价参考（2026.02）：Input $0.50/M, Output $3/M, Context 1M
   *
   * @see https://openrouter.ai/google/gemini-3-flash-preview
   */
  'openrouter:gemini-3-flash-preview': ModelConfig<'openrouter'>;
  'openrouter:google/gemini-3-flash-preview': ModelConfig<'openrouter'>;
  /**
   * Claude 3.5 Sonnet
   *
   * 定价参考（2026.02）：Input $6/M, Output $30/M, Context 200K
   *
   * @see https://openrouter.ai/anthropic/claude-3.5-sonnet
   */
  'openrouter:claude-3.5-sonnet': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-3.5-sonnet': ModelConfig<'openrouter'>;
  /**
   * Claude 3.5 Haiku
   *
   * 定价参考（2026.02）：Input $0.80/M, Output $4/M, Context 200K
   *
   * @see https://openrouter.ai/anthropic/claude-3.5-haiku
   */
  'openrouter:claude-3.5-haiku': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-3.5-haiku': ModelConfig<'openrouter'>;
  /**
   * Claude 4 Sonnet
   *
   * 定价参考（2026.02）：Input $3/M, Output $15/M（≤200K），Context 1M
   *
   * @see https://openrouter.ai/anthropic/claude-sonnet-4
   */
  'openrouter:claude-4-sonnet': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-sonnet-4': ModelConfig<'openrouter'>;
  /**
   * Claude Sonnet 4.5
   *
   * 定价参考（2026.02）：Input $3/M, Output $15/M, Context 1M
   *
   * @see https://openrouter.ai/anthropic/claude-sonnet-4.5
   */
  'openrouter:claude-sonnet-4.5': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-sonnet-4.5': ModelConfig<'openrouter'>;
  // claude-sonnet-4.6 declared in the upstream Anthropic group below (deduped on libs union merge)
  /**
   * Claude Opus 4.1
   *
   * 定价参考（2026.02）：Input $15/M, Output $75/M, Context 200K
   *
   * @see https://openrouter.ai/anthropic/claude-opus-4.1
   */
  'openrouter:claude-4.1-opus': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-opus-4.1': ModelConfig<'openrouter'>;
  /**
   * Claude Opus 4.5 - 最强 coding
   *
   * 定价参考（2026.02）：Input $5/M, Output $25/M, Context 200K
   *
   * @see https://openrouter.ai/anthropic/claude-opus-4.5
   */
  'openrouter:claude-opus-4.5': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-opus-4.5': ModelConfig<'openrouter'>;
  /**
   * GPT-4o Mini
   *
   * 定价参考（2026.02）：Input $0.15/M, Output $0.60/M, Context 128K
   *
   * @see https://openrouter.ai/openai/gpt-4o-mini
   */
  'openrouter:gpt-4o-mini': ModelConfig<'openrouter'>;
  'openrouter:openai/gpt-4o-mini': ModelConfig<'openrouter'>;
  // gpt-5.5 declared in the upstream GPT-5 group below (deduped on libs union merge)
  /**
   * Grok 3 Mini - thinking
   *
   * 定价参考（2026.02）：Input $0.30/M, Output $0.50/M, Context 131K
   *
   * @see https://openrouter.ai/x-ai/grok-3-mini
   */
  'openrouter:grok-3-mini': ModelConfig<'openrouter'>;
  'openrouter:x-ai/grok-3-mini': ModelConfig<'openrouter'>;
  /**
   * Grok 4.1 Fast - best tool calling
   *
   * 定价参考（2026.02）：Input $0.20/M, Output $0.50/M, Context 2M
   *
   * ⚠️ 注意：reasoning 无法关闭！
   * - noThinking 参数对此模型无效
   * - TTFT 固定 12-17 秒（模型内部始终进行 reasoning）
   * - 不适合需要低延迟的场景（如实时对话）
   *
   * @see https://openrouter.ai/x-ai/grok-4.1-fast
   * @see ~/.claude/gotchas/openrouter-grok-reasoning-cannot-disable.md
   */
  'openrouter:grok-4.1-fast': ModelConfig<'openrouter'>;
  'openrouter:x-ai/grok-4.1-fast': ModelConfig<'openrouter'>;
  /**
   * Step 3.5 Flash - 免费 MoE 模型
   *
   * 定价：免费（Input $0/M, Output $0/M），Context 256K
   *
   * 特点：
   * - MoE 架构 196B/11B（稀疏激活）
   * - Tool Call Error Rate 2.19%
   * - Reasoning 模型，速度高效
   *
   * @see https://openrouter.ai/stepfun/step-3.5-flash:free
   */
  'openrouter:stepfun/step-3.5-flash:free': ModelConfig<'openrouter'>;
  /**
   * DeepSeek V3.2 - Roleplay #1
   *
   * 定价参考（2026.02）：Input $0.26/M, Output $0.38/M, Context 164K
   *
   * 特点：
   * - Roleplay 排名 #1
   * - 支持 reasoning 模式（可通过 reasoning_enabled 控制）
   * - DSA 稀疏注意力，长上下文高效
   * - GPT-5 级别推理能力
   *
   * Provider 定价（选型时注意）：
   * | Provider | Input | Output |
   * |----------|-------|--------|
   * | DeepInfra / AtlasCloud | $0.26 | $0.38 |
   * | NovitaAI | $0.269 | $0.40 |
   * | SiliconFlow | $0.27 | $0.42 |
   * | Parasail | $0.28 | $0.45 |
   * | Google Vertex | $0.56 | $1.68 | ← 贵 2-4x，慎用
   *
   * 建议：providerSort: 'price' 优先低价 provider
   */
  'openrouter:deepseek-v3.2': ModelConfig<'openrouter'>;
  'openrouter:deepseek/deepseek-v3.2': ModelConfig<'openrouter'>;
  /**
   * Kimi K2.5 - MoonshotAI 多模态模型
   *
   * 定价参考（2026.02）：Input $0.23/M, Output $3/M, Context 262K
   *
   * 视觉编码、Agent 工具调用能力强
   *
   * Provider 定价（选型时注意）：
   * | Provider | Input | Output |
   * |----------|-------|--------|
   * | SiliconFlow | $0.23 | $3 | ← 最低价
   * | DeepInfra | $0.45 | $2.25 |
   * | Inceptron / AtlasCloud / Together | $0.50 | $2.40-2.80 |
   * | NovitaAI / Moonshot / Fireworks / Baseten | $0.60 | $2.85-3 |
   * | Venice | $0.75 | $3.75 | ← 贵 2-3x
   *
   * 建议：providerSort: 'price' 优先 SiliconFlow
   *
   * @see https://openrouter.ai/moonshotai/kimi-k2.5
   */
  'openrouter:kimi-k2.5': ModelConfig<'openrouter'>;
  'openrouter:moonshotai/kimi-k2.5': ModelConfig<'openrouter'>;
  // GLM 5 - 不考虑使用（Z.ai，质量不够稳定）
  // 'openrouter:glm-5': ModelConfig<'openrouter'>;
  // 'openrouter:z-ai/glm-5': ModelConfig<'openrouter'>;
  /**
   * MiniMax M2.5 - Programming #1, Technology #1
   *
   * 定价参考（2026.02）：Input $0.30/M, Output $1.10/M, Context 196K
   *
   * 特点：
   * - SWE-Bench Verified 80.2%，Multi-SWE-Bench 51.3%
   * - 基于 M2.1 扩展到通用办公（Word/Excel/PPT）
   * - 多 Agent 协作、跨软件环境切换
   * - token 效率优化，规划式输出
   *
   * ⚠️ 限制：
   * - reasoning 强制开启，无法关闭（400 "Reasoning is mandatory"）
   * - Function Calling / 结构化输出能力差，容易漏字段（finishReason=stop 但 schema 不完整）
   * - 不适合需要严格 JSON Schema 遵守的场景（如 generateObject）
   *
   * Provider 定价（选型时注意）：
   * | Provider | Input | Output |
   * |----------|-------|--------|
   * | Inceptron | $0.30 | $1.10 | ← 最低价
   * | Parasail / Fireworks / AtlasCloud / Friendli / MiniMax | $0.30 | $1.20 |
   *
   * @see https://openrouter.ai/minimax/minimax-m2.5
   */
  'openrouter:minimax-m2.5': ModelConfig<'openrouter'>;
  'openrouter:minimax/minimax-m2.5': ModelConfig<'openrouter'>;

  /**
   * Gemini 3.1 Flash Lite - 轻量快速
   *
   * 定价参考（2026.03）：Input $0.25/M, Output $1.50/M, Context 1M
   *
   * 接近 Gemini 2.5 Flash 质量，比 2.5 Flash Lite 显著提升
   *
   * @see https://openrouter.ai/google/gemini-3.1-flash-lite
   */
  'openrouter:gemini-3.1-flash-lite': ModelConfig<'openrouter'>;
  'openrouter:google/gemini-3.1-flash-lite': ModelConfig<'openrouter'>;

  /**
   * Gemini 3.5 Flash - GA
   *
   * 定价参考（2026.05）：Input $1.50/M, Output $9/M, Context 1M
   *
   * 默认 medium thinking effort，支持 minimal/low/medium/high。
   * 价格相对 2.5 Flash 显著上行（input 5x、output 3.6x），定位非"性价比" Flash。
   *
   * @see https://openrouter.ai/google/gemini-3.5-flash
   */
  'openrouter:gemini-3.5-flash': ModelConfig<'openrouter'>;
  'openrouter:google/gemini-3.5-flash': ModelConfig<'openrouter'>;

  /**
   * Gemini 3.1 Pro Preview
   *
   * 定价参考（2026.04）：Input $2/M, Output $12/M, Context 1M
   *
   * @see https://openrouter.ai/google/gemini-3.1-pro-preview
   */
  'openrouter:gemini-3.1-pro-preview': ModelConfig<'openrouter'>;
  'openrouter:google/gemini-3.1-pro-preview': ModelConfig<'openrouter'>;

  // ---- Anthropic Claude (4.5+) ----
  /**
   * Claude Haiku 4.5 - 低价快速
   *
   * 定价参考（2026.05）：Input $1/M, Output $5/M, Context 200K
   *
   * @see https://openrouter.ai/anthropic/claude-haiku-4.5
   */
  'openrouter:claude-haiku-4.5': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-haiku-4.5': ModelConfig<'openrouter'>;
  /**
   * Claude Sonnet 4.6 - 旗舰对话/工具调用
   *
   * 定价参考（2026.05）：Input $3/M, Output $15/M, Context 1M
   *
   * @see https://openrouter.ai/anthropic/claude-sonnet-4.6
   */
  'openrouter:claude-sonnet-4.6': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-sonnet-4.6': ModelConfig<'openrouter'>;
  /**
   * Claude Opus 4.6
   *
   * 定价参考（2026.05）：Input $5/M, Output $25/M, Context 1M
   *
   * @see https://openrouter.ai/anthropic/claude-opus-4.6
   */
  'openrouter:claude-opus-4.6': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-opus-4.6': ModelConfig<'openrouter'>;
  /**
   * Claude Opus 4.7 - 最新旗舰
   *
   * 定价参考（2026.05）：Input $5/M, Output $25/M, Context 1M
   *
   * @see https://openrouter.ai/anthropic/claude-opus-4.7
   */
  'openrouter:claude-opus-4.7': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-opus-4.7': ModelConfig<'openrouter'>;

  // ---- OpenAI GPT-5 ----
  /**
   * GPT-5.1
   *
   * 定价参考（2026.05）：Input $1.25/M, Output $10/M, Context 400K
   *
   * @see https://openrouter.ai/openai/gpt-5.1
   */
  'openrouter:gpt-5.1': ModelConfig<'openrouter'>;
  'openrouter:openai/gpt-5.1': ModelConfig<'openrouter'>;
  /**
   * GPT-5.2
   *
   * 定价参考（2026.05）：Input $1.75/M, Output $14/M, Context 400K
   *
   * @see https://openrouter.ai/openai/gpt-5.2
   */
  'openrouter:gpt-5.2': ModelConfig<'openrouter'>;
  'openrouter:openai/gpt-5.2': ModelConfig<'openrouter'>;
  /**
   * GPT-5.4 - 主力
   *
   * 定价参考（2026.05）：Input $2.50/M, Output $15/M, Context 1.05M
   *
   * @see https://openrouter.ai/openai/gpt-5.4
   */
  'openrouter:gpt-5.4': ModelConfig<'openrouter'>;
  'openrouter:openai/gpt-5.4': ModelConfig<'openrouter'>;
  /**
   * GPT-5.4 Mini
   *
   * 定价参考（2026.05）：Input $0.75/M, Output $4.50/M, Context 400K
   *
   * @see https://openrouter.ai/openai/gpt-5.4-mini
   */
  'openrouter:gpt-5.4-mini': ModelConfig<'openrouter'>;
  'openrouter:openai/gpt-5.4-mini': ModelConfig<'openrouter'>;
  /**
   * GPT-5.4 Nano
   *
   * 定价参考（2026.05）：Input $0.20/M, Output $1.25/M, Context 400K
   *
   * @see https://openrouter.ai/openai/gpt-5.4-nano
   */
  'openrouter:gpt-5.4-nano': ModelConfig<'openrouter'>;
  'openrouter:openai/gpt-5.4-nano': ModelConfig<'openrouter'>;
  /**
   * GPT-5.5 - 最新旗舰
   *
   * 定价参考（2026.05）：Input $5/M, Output $30/M, Context 1.05M
   *
   * @see https://openrouter.ai/openai/gpt-5.5
   */
  'openrouter:gpt-5.5': ModelConfig<'openrouter'>;
  'openrouter:openai/gpt-5.5': ModelConfig<'openrouter'>;

  // ---- xAI Grok (4.20+) ----
  /**
   * Grok 4.20 - 2M context
   *
   * 定价参考（2026.05）：Input $1.25/M, Output $2.50/M, Context 2M
   *
   * @see https://openrouter.ai/x-ai/grok-4.20
   */
  'openrouter:grok-4.20': ModelConfig<'openrouter'>;
  'openrouter:x-ai/grok-4.20': ModelConfig<'openrouter'>;
  /**
   * Grok 4.3 - 最新旗舰
   *
   * 定价参考（2026.05）：Input $1.25/M, Output $2.50/M, Context 1M
   *
   * @see https://openrouter.ai/x-ai/grok-4.3
   */
  'openrouter:grok-4.3': ModelConfig<'openrouter'>;
  'openrouter:x-ai/grok-4.3': ModelConfig<'openrouter'>;

  // ---- DeepSeek / MoonshotAI Kimi / Qwen ----
  /**
   * DeepSeek V4 Flash - 高性价比
   *
   * 定价参考（2026.05）：Input $0.112/M, Output $0.224/M, Context 1M
   *
   * @see https://openrouter.ai/deepseek/deepseek-v4-flash
   */
  'openrouter:deepseek-v4-flash': ModelConfig<'openrouter'>;
  'openrouter:deepseek/deepseek-v4-flash': ModelConfig<'openrouter'>;
  /**
   * DeepSeek V4 Pro - 旗舰推理
   *
   * 定价参考（2026.05）：Input $0.435/M, Output $0.87/M, Context 1M
   *
   * @see https://openrouter.ai/deepseek/deepseek-v4-pro
   */
  'openrouter:deepseek-v4-pro': ModelConfig<'openrouter'>;
  'openrouter:deepseek/deepseek-v4-pro': ModelConfig<'openrouter'>;
  /**
   * Kimi K2.6 - MoonshotAI 新一代
   *
   * 定价参考（2026.05）：Input $0.73/M, Output $3.49/M, Context 262K
   *
   * @see https://openrouter.ai/moonshotai/kimi-k2.6
   */
  'openrouter:kimi-k2.6': ModelConfig<'openrouter'>;
  'openrouter:moonshotai/kimi-k2.6': ModelConfig<'openrouter'>;
  /**
   * Kimi K2 Thinking - 推理特化（reasoning 强制开启）
   *
   * 定价参考（2026.05）：Input $0.60/M, Output $2.50/M, Context 262K
   *
   * @see https://openrouter.ai/moonshotai/kimi-k2-thinking
   */
  'openrouter:kimi-k2-thinking': ModelConfig<'openrouter'>;
  'openrouter:moonshotai/kimi-k2-thinking': ModelConfig<'openrouter'>;
  /**
   * Qwen3.6 Flash - 高性价比
   *
   * 定价参考（2026.05）：Input $0.1875/M, Output $1.125/M, Context 1M
   *
   * @see https://openrouter.ai/qwen/qwen3.6-flash
   */
  'openrouter:qwen3.6-flash': ModelConfig<'openrouter'>;
  'openrouter:qwen/qwen3.6-flash': ModelConfig<'openrouter'>;
  /**
   * Qwen3.7 Max - 最新旗舰
   *
   * 定价参考（2026.05）：Input $2.50/M, Output $7.50/M, Context 1M
   *
   * @see https://openrouter.ai/qwen/qwen3.7-max
   */
  'openrouter:qwen3.7-max': ModelConfig<'openrouter'>;
  'openrouter:qwen/qwen3.7-max': ModelConfig<'openrouter'>;

  // ==================== Google Direct ====================
  'google:gemini-2.5-flash': ModelConfig<'google'>;
  'google:gemini-2.5-pro': ModelConfig<'google'>;
  'google:gemini-2.5-flash-lite': ModelConfig<'google'>;
  'google:gemini-3-flash-preview': ModelConfig<'google'>;
  'google:gemini-3.1-flash-lite': ModelConfig<'google'>;
  'google:gemini-3.1-pro-preview': ModelConfig<'google'>;

  // ==================== Vertex AI (Express Mode) ====================
  'vertex:gemini-2.5-flash': ModelConfig<'vertex'>;
  'vertex:gemini-2.5-pro': ModelConfig<'vertex'>;
  'vertex:gemini-2.5-flash-lite': ModelConfig<'vertex'>;
  'vertex:gemini-3-flash-preview': ModelConfig<'vertex'>;
  'vertex:gemini-3.1-flash-lite': ModelConfig<'vertex'>;
  /**
   * Gemini 3.5 Flash 直连 Vertex — 与 openrouter 版关键差异: **thinking 可关**!
   * 2026-06-05 实测 (aiplatform v1 + thinkingConfig): 默认 thoughts=182tok;
   * thinkingBudget:0 → 0; thinkingLevel:minimal → 0。"Reasoning is mandatory"
   * 是 OpenRouter 中转层限制, 非模型限制。noThinking 路径 (disableThinkingOptions
   * → thinkingBudget:0) 即插即用。定价 $1.50/$9。
   */
  'vertex:gemini-3.5-flash': ModelConfig<'vertex'>;
  'vertex:gemini-3.1-pro-preview': ModelConfig<'vertex'>;

  // ==================== Vertex AI (project/global mode) ====================
  'vertex-global:gemini-2.5-flash': ModelConfig<'vertex-global'>;
  'vertex-global:gemini-2.5-pro': ModelConfig<'vertex-global'>;
  'vertex-global:gemini-2.5-flash-lite': ModelConfig<'vertex-global'>;
  'vertex-global:gemini-3-flash-preview': ModelConfig<'vertex-global'>;
  'vertex-global:gemini-3.1-flash-lite': ModelConfig<'vertex-global'>;
  'vertex-global:gemini-3.5-flash': ModelConfig<'vertex-global'>;
  'vertex-global:gemini-3.1-pro-preview': ModelConfig<'vertex-global'>;
}

/**
 * 从 Registry 推导的 Model Key 联合类型
 */
export type LLMModelKey = keyof LLMModelRegistry;

/**
 * Thinking effort 级别（与 llm.class.ts 中的 ThinkingEffort 保持一致）
 *
 * 在 model.types.ts 中重新定义以避免循环依赖（model.types → llm.class → model.types）
 */
type ThinkingEffortLevel = 'none' | 'low' | 'medium' | 'high';

/**
 * Model Spec — 携带运行时参数的 Model Key
 *
 * 格式：`provider:model` 或 `provider:model?param=value&...`
 * 使用 URL query string 语法，用 URLSearchParams 解析。
 *
 * 参数嵌入 model key 的好处：
 * - 在 env.ts 中配置模型时同时指定参数，无需改业务代码
 * - 换模型时参数跟着走（Grok 需要 reason，Gemini 不需要）
 * - 调用方仍可通过显式参数覆盖
 *
 * 支持的参数：
 * - reason: thinking effort（none/low/medium/high）
 *
 * @example
 * 'openrouter:grok-4.1-fast?reason=low'  // Grok + low reasoning
 * 'openrouter:gemini-3-flash-preview'     // Gemini, no params
 */
export type LLMModelSpec = LLMModelKey | `${LLMModelKey}?${string}`;

/**
 * parseModelSpec 的返回结果
 */
export interface ParsedModelSpec {
  key: LLMModelKey;
  thinking: ThinkingEffortLevel | undefined;
  /** 最大重试次数（覆盖 AI_LLM_MAX_RETRIES） */
  maxRetries: number | undefined;
  /** 超时毫秒（覆盖 AI_LLM_TIMEOUT_MS） */
  timeout: number | undefined;
  /** 降级模型链，主模型失败后依次尝试 */
  fallbackModels: LLMModelKey[];
  /** Vertex AI tier（仅 vertex / vertex-global provider 会发送 header） */
  tier: VertexTier | undefined;
  /** Vertex request type（仅 vertex / vertex-global + tier=flex/priority 时生效） */
  vertexRequestType: VertexRequestType | undefined;
}

const VALID_THINKING_EFFORTS = new Set<string>(['none', 'low', 'medium', 'high']);
const VALID_VERTEX_TIERS = new Set<string>(['standard', 'flex', 'priority']);
const VALID_VERTEX_REQUEST_TYPES = new Set<string>(['shared']);

/**
 * 解析 LLMModelSpec 为 base key + 参数
 *
 * @example
 * parseModelSpec('openrouter:grok-4.1-fast?reason=low')
 * // → { key: 'openrouter:grok-4.1-fast', thinking: 'low' }
 *
 * parseModelSpec('openrouter:gemini-3-flash-preview')
 * // → { key: 'openrouter:gemini-3-flash-preview', thinking: undefined }
 */
export function parseModelSpec(spec: LLMModelSpec): ParsedModelSpec {
  const qIdx = spec.indexOf('?');
  if (qIdx === -1) {
    return {
      key: spec as LLMModelKey,
      thinking: undefined,
      maxRetries: undefined,
      timeout: undefined,
      fallbackModels: [],
      tier: undefined,
      vertexRequestType: undefined,
    };
  }
  const key = spec.slice(0, qIdx) as LLMModelKey;
  const params = new URLSearchParams(spec.slice(qIdx + 1));

  // reason → thinking effort（无效值 warning + 忽略，不阻断）
  const reason = params.get('reason');
  let thinking: ThinkingEffortLevel | undefined;
  if (reason !== null) {
    if (VALID_THINKING_EFFORTS.has(reason)) {
      thinking = reason as ThinkingEffortLevel;
    } else {
      logger.warning`[parseModelSpec] Invalid reason "${reason}" in "${spec}", ignoring. Valid: ${[...VALID_THINKING_EFFORTS].join(', ')}`;
    }
  }

  // retry → maxRetries（无效值 warning + 忽略）
  const retryRaw = params.get('retry');
  let maxRetries: number | undefined;
  if (retryRaw !== null) {
    const n = Number(retryRaw);
    if (/^\d+$/.test(retryRaw) && n >= 0) {
      maxRetries = n;
    } else {
      logger.warning`[parseModelSpec] Invalid retry "${retryRaw}" in "${spec}", ignoring. Must be non-negative integer.`;
    }
  }

  // timeout → timeout ms（无效值 warning + 忽略）
  const timeoutRaw = params.get('timeout');
  let timeout: number | undefined;
  if (timeoutRaw !== null) {
    const n = Number(timeoutRaw);
    if (/^\d+$/.test(timeoutRaw) && n >= 1000) {
      timeout = n;
    } else {
      logger.warning`[parseModelSpec] Invalid timeout "${timeoutRaw}" in "${spec}", ignoring. Must be ≥ 1000ms.`;
    }
  }

  // fallback → fallback model chain（未注册的 warning + 跳过）
  const fallbackRaw = params.get('fallback');
  const fallbackModels: LLMModelKey[] = [];
  if (fallbackRaw) {
    for (const fb of fallbackRaw.split(',')) {
      const trimmed = fb.trim();
      if (!trimmed) continue;
      if (!modelRegistry.has(trimmed)) {
        logger.warning`[parseModelSpec] Fallback model "${trimmed}" in "${spec}" not registered, skipping.`;
        continue;
      }
      fallbackModels.push(trimmed as LLMModelKey);
    }
  }

  // tier → Vertex AI tier（无效值 warning + 忽略）
  const tierRaw = params.get('tier');
  let tier: VertexTier | undefined;
  if (tierRaw !== null) {
    if (VALID_VERTEX_TIERS.has(tierRaw)) {
      tier = tierRaw as VertexTier;
    } else {
      logger.warning`[parseModelSpec] Invalid tier "${tierRaw}" in "${spec}", ignoring. Valid: ${[...VALID_VERTEX_TIERS].join(', ')}`;
    }
  }

  // vertexRequestType → Vertex AI request type header（无效值 warning + 忽略）
  const vertexRequestTypeRaw = params.get('vertexRequestType');
  let vertexRequestType: VertexRequestType | undefined;
  if (vertexRequestTypeRaw !== null) {
    if (VALID_VERTEX_REQUEST_TYPES.has(vertexRequestTypeRaw)) {
      vertexRequestType = vertexRequestTypeRaw as VertexRequestType;
    } else {
      logger.warning`[parseModelSpec] Invalid vertexRequestType "${vertexRequestTypeRaw}" in "${spec}", ignoring. Valid: ${[...VALID_VERTEX_REQUEST_TYPES].join(', ')}`;
    }
  }

  return { key, thinking, maxRetries, timeout, fallbackModels, tier, vertexRequestType };
}

/**
 * 从 Registry 推导的 Provider 联合类型
 * 会自动包含所有注册的 Provider
 */
export type LLMProviderType = LLMModelRegistry[LLMModelKey]['provider'];

// ==================== 运行时 Registry ====================

const modelRegistry = new Map<string, ModelConfig>([
  // OpenRouter 模型（简称 + 全称成对，按模型分组）
  // Gemini 2.5 Flash
  ['openrouter:gemini-2.5-flash', { provider: 'openrouter', modelId: 'google/gemini-2.5-flash' }],
  ['openrouter:google/gemini-2.5-flash', { provider: 'openrouter', modelId: 'google/gemini-2.5-flash' }],
  // Gemini 2.5 Pro
  ['openrouter:gemini-2.5-pro', { provider: 'openrouter', modelId: 'google/gemini-2.5-pro' }],
  ['openrouter:google/gemini-2.5-pro', { provider: 'openrouter', modelId: 'google/gemini-2.5-pro' }],
  // Gemini 2.5 Flash Lite
  ['openrouter:gemini-2.5-flash-lite', { provider: 'openrouter', modelId: 'google/gemini-2.5-flash-lite' }],
  ['openrouter:google/gemini-2.5-flash-lite', { provider: 'openrouter', modelId: 'google/gemini-2.5-flash-lite' }],
  // Gemini 3 Flash Preview
  ['openrouter:gemini-3-flash-preview', { provider: 'openrouter', modelId: 'google/gemini-3-flash-preview' }],
  ['openrouter:google/gemini-3-flash-preview', { provider: 'openrouter', modelId: 'google/gemini-3-flash-preview' }],
  // Claude 3.5 Sonnet
  ['openrouter:claude-3.5-sonnet', { provider: 'openrouter', modelId: 'anthropic/claude-3.5-sonnet' }],
  ['openrouter:anthropic/claude-3.5-sonnet', { provider: 'openrouter', modelId: 'anthropic/claude-3.5-sonnet' }],
  // Claude 3.5 Haiku
  ['openrouter:claude-3.5-haiku', { provider: 'openrouter', modelId: 'anthropic/claude-3.5-haiku' }],
  ['openrouter:anthropic/claude-3.5-haiku', { provider: 'openrouter', modelId: 'anthropic/claude-3.5-haiku' }],
  // Claude 4 Sonnet
  ['openrouter:claude-4-sonnet', { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4' }],
  ['openrouter:anthropic/claude-sonnet-4', { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4' }],
  // Claude Sonnet 4.5
  ['openrouter:claude-sonnet-4.5', { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4.5' }],
  ['openrouter:anthropic/claude-sonnet-4.5', { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4.5' }],
  // Claude Sonnet 4.6 registered in the upstream Anthropic group below (deduped on libs union merge)
  // Claude Opus 4.1
  ['openrouter:claude-4.1-opus', { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.1' }],
  ['openrouter:anthropic/claude-opus-4.1', { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.1' }],
  // Claude Opus 4.5
  ['openrouter:claude-opus-4.5', { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.5' }],
  ['openrouter:anthropic/claude-opus-4.5', { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.5' }],
  // GPT-4o Mini
  ['openrouter:gpt-4o-mini', { provider: 'openrouter', modelId: 'openai/gpt-4o-mini' }],
  ['openrouter:openai/gpt-4o-mini', { provider: 'openrouter', modelId: 'openai/gpt-4o-mini' }],
  // GPT-5.5 registered in the upstream GPT-5 group below (deduped on libs union merge)
  // Grok 3 Mini
  ['openrouter:grok-3-mini', { provider: 'openrouter', modelId: 'x-ai/grok-3-mini' }],
  ['openrouter:x-ai/grok-3-mini', { provider: 'openrouter', modelId: 'x-ai/grok-3-mini' }],
  // Grok 4.1 Fast（reasoning 可通过 thinking 参数控制）
  ['openrouter:grok-4.1-fast', { provider: 'openrouter', modelId: 'x-ai/grok-4.1-fast' }],
  ['openrouter:x-ai/grok-4.1-fast', { provider: 'openrouter', modelId: 'x-ai/grok-4.1-fast' }],
  // Step 3.5 Flash (免费 MoE 196B/11B, reasoningRequired)
  [
    'openrouter:stepfun/step-3.5-flash:free',
    { provider: 'openrouter', modelId: 'stepfun/step-3.5-flash:free', reasoningRequired: true },
  ],
  // DeepSeek V3.2
  ['openrouter:deepseek-v3.2', { provider: 'openrouter', modelId: 'deepseek/deepseek-v3.2' }],
  ['openrouter:deepseek/deepseek-v3.2', { provider: 'openrouter', modelId: 'deepseek/deepseek-v3.2' }],
  // Kimi K2.5
  ['openrouter:kimi-k2.5', { provider: 'openrouter', modelId: 'moonshotai/kimi-k2.5' }],
  ['openrouter:moonshotai/kimi-k2.5', { provider: 'openrouter', modelId: 'moonshotai/kimi-k2.5' }],
  // GLM 5 - 不考虑使用
  // ['openrouter:glm-5', { provider: 'openrouter', modelId: 'z-ai/glm-5' }],
  // ['openrouter:z-ai/glm-5', { provider: 'openrouter', modelId: 'z-ai/glm-5' }],
  // MiniMax M2.5 (reasoningRequired: 400 "Reasoning is mandatory")
  ['openrouter:minimax-m2.5', { provider: 'openrouter', modelId: 'minimax/minimax-m2.5', reasoningRequired: true }],
  [
    'openrouter:minimax/minimax-m2.5',
    { provider: 'openrouter', modelId: 'minimax/minimax-m2.5', reasoningRequired: true },
  ],

  // Gemini 3.1 Flash Lite
  ['openrouter:gemini-3.1-flash-lite', { provider: 'openrouter', modelId: 'google/gemini-3.1-flash-lite' }],
  ['openrouter:google/gemini-3.1-flash-lite', { provider: 'openrouter', modelId: 'google/gemini-3.1-flash-lite' }],

  // Gemini 3.5 Flash (reasoningRequired: OpenRouter 400 "Reasoning is mandatory and cannot
  // be disabled" — 2026-06-04 stg 主聊天全挂事故根因: 没标此 flag → noThinking 路径主动发
  // disable-thinking 被拒. 标上后 noThinking 不发 disable; 用时建议 ?reason=low 控 effort.)
  [
    'openrouter:gemini-3.5-flash',
    { provider: 'openrouter', modelId: 'google/gemini-3.5-flash', reasoningRequired: true },
  ],
  [
    'openrouter:google/gemini-3.5-flash',
    { provider: 'openrouter', modelId: 'google/gemini-3.5-flash', reasoningRequired: true },
  ],

  // Gemini 3.1 Pro Preview
  ['openrouter:gemini-3.1-pro-preview', { provider: 'openrouter', modelId: 'google/gemini-3.1-pro-preview' }],
  ['openrouter:google/gemini-3.1-pro-preview', { provider: 'openrouter', modelId: 'google/gemini-3.1-pro-preview' }],

  // Claude Haiku 4.5
  ['openrouter:claude-haiku-4.5', { provider: 'openrouter', modelId: 'anthropic/claude-haiku-4.5' }],
  ['openrouter:anthropic/claude-haiku-4.5', { provider: 'openrouter', modelId: 'anthropic/claude-haiku-4.5' }],
  // Claude Sonnet 4.6
  ['openrouter:claude-sonnet-4.6', { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4.6' }],
  ['openrouter:anthropic/claude-sonnet-4.6', { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4.6' }],
  // Claude Opus 4.6
  ['openrouter:claude-opus-4.6', { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.6' }],
  ['openrouter:anthropic/claude-opus-4.6', { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.6' }],
  // Claude Opus 4.7
  ['openrouter:claude-opus-4.7', { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.7' }],
  ['openrouter:anthropic/claude-opus-4.7', { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.7' }],

  // GPT-5.1
  ['openrouter:gpt-5.1', { provider: 'openrouter', modelId: 'openai/gpt-5.1' }],
  ['openrouter:openai/gpt-5.1', { provider: 'openrouter', modelId: 'openai/gpt-5.1' }],
  // GPT-5.2
  ['openrouter:gpt-5.2', { provider: 'openrouter', modelId: 'openai/gpt-5.2' }],
  ['openrouter:openai/gpt-5.2', { provider: 'openrouter', modelId: 'openai/gpt-5.2' }],
  // GPT-5.4
  ['openrouter:gpt-5.4', { provider: 'openrouter', modelId: 'openai/gpt-5.4' }],
  ['openrouter:openai/gpt-5.4', { provider: 'openrouter', modelId: 'openai/gpt-5.4' }],
  // GPT-5.4 Mini
  ['openrouter:gpt-5.4-mini', { provider: 'openrouter', modelId: 'openai/gpt-5.4-mini' }],
  ['openrouter:openai/gpt-5.4-mini', { provider: 'openrouter', modelId: 'openai/gpt-5.4-mini' }],
  // GPT-5.4 Nano
  ['openrouter:gpt-5.4-nano', { provider: 'openrouter', modelId: 'openai/gpt-5.4-nano' }],
  ['openrouter:openai/gpt-5.4-nano', { provider: 'openrouter', modelId: 'openai/gpt-5.4-nano' }],
  // GPT-5.5
  ['openrouter:gpt-5.5', { provider: 'openrouter', modelId: 'openai/gpt-5.5' }],
  ['openrouter:openai/gpt-5.5', { provider: 'openrouter', modelId: 'openai/gpt-5.5' }],

  // Grok 4.20
  ['openrouter:grok-4.20', { provider: 'openrouter', modelId: 'x-ai/grok-4.20' }],
  ['openrouter:x-ai/grok-4.20', { provider: 'openrouter', modelId: 'x-ai/grok-4.20' }],
  // Grok 4.3
  ['openrouter:grok-4.3', { provider: 'openrouter', modelId: 'x-ai/grok-4.3' }],
  ['openrouter:x-ai/grok-4.3', { provider: 'openrouter', modelId: 'x-ai/grok-4.3' }],

  // DeepSeek V4 Flash
  ['openrouter:deepseek-v4-flash', { provider: 'openrouter', modelId: 'deepseek/deepseek-v4-flash' }],
  ['openrouter:deepseek/deepseek-v4-flash', { provider: 'openrouter', modelId: 'deepseek/deepseek-v4-flash' }],
  // DeepSeek V4 Pro
  ['openrouter:deepseek-v4-pro', { provider: 'openrouter', modelId: 'deepseek/deepseek-v4-pro' }],
  ['openrouter:deepseek/deepseek-v4-pro', { provider: 'openrouter', modelId: 'deepseek/deepseek-v4-pro' }],
  // Kimi K2.6
  ['openrouter:kimi-k2.6', { provider: 'openrouter', modelId: 'moonshotai/kimi-k2.6' }],
  ['openrouter:moonshotai/kimi-k2.6', { provider: 'openrouter', modelId: 'moonshotai/kimi-k2.6' }],
  // Kimi K2 Thinking (reasoningRequired: 推理特化模型)
  [
    'openrouter:kimi-k2-thinking',
    { provider: 'openrouter', modelId: 'moonshotai/kimi-k2-thinking', reasoningRequired: true },
  ],
  [
    'openrouter:moonshotai/kimi-k2-thinking',
    { provider: 'openrouter', modelId: 'moonshotai/kimi-k2-thinking', reasoningRequired: true },
  ],
  // Qwen3.6 Flash
  ['openrouter:qwen3.6-flash', { provider: 'openrouter', modelId: 'qwen/qwen3.6-flash' }],
  ['openrouter:qwen/qwen3.6-flash', { provider: 'openrouter', modelId: 'qwen/qwen3.6-flash' }],
  // Qwen3.7 Max
  ['openrouter:qwen3.7-max', { provider: 'openrouter', modelId: 'qwen/qwen3.7-max' }],
  ['openrouter:qwen/qwen3.7-max', { provider: 'openrouter', modelId: 'qwen/qwen3.7-max' }],

  // Google Direct 模型
  ['google:gemini-2.5-flash', { provider: 'google', modelId: 'gemini-2.5-flash' }],
  ['google:gemini-2.5-pro', { provider: 'google', modelId: 'gemini-2.5-pro' }],
  ['google:gemini-2.5-flash-lite', { provider: 'google', modelId: 'gemini-2.5-flash-lite' }],
  ['google:gemini-3-flash-preview', { provider: 'google', modelId: 'gemini-3-flash-preview' }],
  ['google:gemini-3.1-flash-lite', { provider: 'google', modelId: 'gemini-3.1-flash-lite' }],
  ['google:gemini-3.1-pro-preview', { provider: 'google', modelId: 'gemini-3.1-pro-preview' }],

  // Vertex AI 模型 (Express Mode)
  // 这些 key 保持既有 API-key Express Mode 语义；需要 Google 官方 project/global
  // Priority/Flex PayGo 路径时，使用下方 `vertex-global:*` key。
  // supportedTiers 以 Google 官方文档为准，更新时同步两个列表：
  // - Flex: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/flex-paygo
  // - Priority: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/priority-paygo
  [
    'vertex:gemini-2.5-flash',
    { provider: 'vertex', modelId: 'gemini-2.5-flash', supportedTiers: ['standard', 'priority'] },
  ],
  [
    'vertex:gemini-2.5-pro',
    { provider: 'vertex', modelId: 'gemini-2.5-pro', supportedTiers: ['standard', 'priority'] },
  ],
  [
    'vertex:gemini-2.5-flash-lite',
    { provider: 'vertex', modelId: 'gemini-2.5-flash-lite', supportedTiers: ['standard', 'priority'] },
  ],
  [
    'vertex:gemini-3-flash-preview',
    { provider: 'vertex', modelId: 'gemini-3-flash-preview', supportedTiers: ['standard', 'flex', 'priority'] },
  ],
  [
    'vertex:gemini-3.1-flash-lite',
    {
      provider: 'vertex',
      modelId: 'gemini-3.1-flash-lite',
      supportedTiers: ['standard', 'flex', 'priority'],
    },
  ],
  // Gemini 3.5 Flash 直连 (thinking 可关, 见 interface 注释; tiers 未查证 → 默认 standard)
  ['vertex:gemini-3.5-flash', { provider: 'vertex', modelId: 'gemini-3.5-flash' }],
  [
    'vertex:gemini-3.1-pro-preview',
    {
      provider: 'vertex',
      modelId: 'gemini-3.1-pro-preview',
      supportedTiers: ['standard', 'flex', 'priority'],
    },
  ],

  // Vertex AI 模型 (project/global mode)
  // Google Priority/Flex PayGo 文档要求使用 /projects/{project}/locations/global/... 路径。
  [
    'vertex-global:gemini-2.5-flash',
    { provider: 'vertex-global', modelId: 'gemini-2.5-flash', supportedTiers: ['standard', 'priority'] },
  ],
  [
    'vertex-global:gemini-2.5-pro',
    { provider: 'vertex-global', modelId: 'gemini-2.5-pro', supportedTiers: ['standard', 'priority'] },
  ],
  [
    'vertex-global:gemini-2.5-flash-lite',
    { provider: 'vertex-global', modelId: 'gemini-2.5-flash-lite', supportedTiers: ['standard', 'priority'] },
  ],
  [
    'vertex-global:gemini-3-flash-preview',
    { provider: 'vertex-global', modelId: 'gemini-3-flash-preview', supportedTiers: ['standard', 'flex', 'priority'] },
  ],
  [
    'vertex-global:gemini-3.1-flash-lite',
    {
      provider: 'vertex-global',
      modelId: 'gemini-3.1-flash-lite',
      supportedTiers: ['standard', 'flex', 'priority'],
    },
  ],
  ['vertex-global:gemini-3.5-flash', { provider: 'vertex-global', modelId: 'gemini-3.5-flash' }],
  [
    'vertex-global:gemini-3.1-pro-preview',
    {
      provider: 'vertex-global',
      modelId: 'gemini-3.1-pro-preview',
      supportedTiers: ['standard', 'flex', 'priority'],
    },
  ],
]);

// ==================== 注册函数 ====================

/**
 * 注册新的 Model（项目层扩展时调用）
 *
 * @example
 * registerModel('moonshot:kimi-k2', { provider: 'moonshot', modelId: 'kimi-k2-turbo-preview' });
 */
export function registerModel<K extends string, P extends string>(key: K, config: ModelConfig<P>): void {
  modelRegistry.set(key, config);
}

// ==================== 查询函数 ====================

const logger = getAppLogger('features', 'LLMModel');

/**
 * 获取 Model 配置
 *
 * Fallback 机制：
 * - 开发环境：model 不存在时直接报错（fail fast）
 * - 生产环境：model 不存在时 warning + fallback 到 DEFAULT_LLM_MODEL
 */
export function getModel(spec: LLMModelSpec): ModelConfig {
  const { key } = parseModelSpec(spec);
  const config = modelRegistry.get(key);
  if (config) {
    return config;
  }

  // Model 不存在，检查环境决定处理方式
  const fallbackKey = SysEnv.DEFAULT_LLM_MODEL;
  const isProd = SysEnv.environment.isProd;

  if (!isProd) {
    // 开发环境：直接报错，快速发现问题
    throw new Error(`Unknown model: "${key}". Registered models: ${getRegisteredModels().join(', ')}`);
  }

  // 生产环境：warning + fallback
  const fallbackConfig = modelRegistry.get(fallbackKey as string);
  if (!fallbackConfig) {
    // fallback 模型也不存在，必须报错
    throw new Error(
      `Unknown model: "${key}" and fallback model "${fallbackKey}" is also not registered. ` +
        `Check DEFAULT_LLM_MODEL configuration.`,
    );
  }

  logger.warning`#getModel Unknown model "${key}", falling back to "${fallbackKey}". This indicates a configuration issue that should be fixed.`;

  return fallbackConfig;
}

/**
 * 获取实际 API Model ID
 *
 * @example
 * getModelId('openrouter:claude-3.5-sonnet') // → 'anthropic/claude-3.5-sonnet'
 */
export function getModelId(spec: LLMModelSpec): string {
  return getModel(spec).modelId;
}

/**
 * 获取 Provider
 *
 * @example
 * getProvider('openrouter:gemini-2.5-flash') // → 'openrouter'
 */
export function getProvider(spec: LLMModelSpec): LLMProviderType {
  return getModel(spec).provider as LLMProviderType;
}

/**
 * 未标注 supportedTiers 的模型默认走 `['standard']`。
 * 调用方可预先判断；也可直接传 tier，运行时不支持会 warn + 降级。
 *
 * @example
 * getSupportedTiers('vertex-global:gemini-3.1-flash-lite') // → ['standard', 'flex', 'priority']
 * getSupportedTiers('vertex:gemini-2.5-flash-lite')                 // → ['standard', 'priority']
 * getSupportedTiers('openrouter:grok-4.1-fast')                     // → ['standard']
 */
export function getSupportedTiers(spec: LLMModelSpec): readonly VertexTier[] {
  return getModel(spec).supportedTiers ?? DEFAULT_SUPPORTED_TIERS;
}

/**
 * 检查 Model Key 是否已注册（严格匹配，不接受带参数的 spec）
 */
export function isModelRegistered(key: string): key is LLMModelKey {
  return modelRegistry.has(key);
}

/**
 * 检查 Model Spec 是否有效（支持 `provider:model?param=value` 格式）
 */
export function isModelSpecValid(spec: string): spec is LLMModelSpec {
  const qIdx = spec.indexOf('?');
  const baseKey = qIdx === -1 ? spec : spec.slice(0, qIdx);
  return modelRegistry.has(baseKey);
}

/**
 * 获取所有已注册的 Model Keys
 */
export function getRegisteredModels(): string[] {
  return Array.from(modelRegistry.keys());
}

/**
 * 获取指定 Provider 的所有 Model Keys
 */
export function getModelsByProvider(provider: LLMProviderType): string[] {
  return Array.from(modelRegistry.entries())
    .filter(([, config]) => config.provider === provider)
    .map(([key]) => key);
}

// ==================== Provider 配置验证 ====================

/**
 * Provider 到环境变量的映射
 */
interface ProviderConfigRequirement {
  envVar: string;
  configured: () => boolean;
}

/** Provider → 配置需求映射（兼容未迁移的项目） */
const providerConfigRequirements: Partial<Record<string, ProviderConfigRequirement>> = {
  openrouter: {
    envVar: 'AI_OPENROUTER_API_KEY',
    configured: () => !!(SysEnv.AI_OPENROUTER_API_KEY ?? SysEnv.OPENROUTER_API_KEY),
  },
  google: {
    envVar: 'AI_GOOGLE_API_KEY',
    configured: () => !!(SysEnv.AI_GOOGLE_API_KEY ?? SysEnv.GOOGLE_GENERATIVE_AI_API_KEY),
  },
  vertex: {
    envVar: 'AI_GOOGLE_VERTEX_API_KEY',
    configured: () => !!(SysEnv.AI_GOOGLE_VERTEX_API_KEY ?? SysEnv.GOOGLE_VERTEX_API_KEY),
  },
  'vertex-global': {
    envVar: 'GOOGLE_VERTEX_PROJECT',
    configured: () => !!(SysEnv.GOOGLE_VERTEX_PROJECT ?? SysEnv.GOOGLE_CLOUD_PROJECT),
  },
  openai: {
    envVar: 'AI_OPENAI_API_KEY',
    configured: () => !!(SysEnv.AI_OPENAI_API_KEY ?? SysEnv.OPENAI_API_KEY),
  },
};

/**
 * 检查 Provider 是否已配置 API Key（新旧名字都检查）
 */
export function isProviderConfigured(provider: string): boolean {
  return providerConfigRequirements[provider]?.configured() ?? false;
}

/**
 * 获取 Provider 配置状态
 */
export function getProviderStatus(): Record<string, { configured: boolean; envVar: string }> {
  return Object.entries(providerConfigRequirements).reduce<Record<string, { configured: boolean; envVar: string }>>(
    (acc, [provider, requirement]) => {
      if (!requirement) return acc;
      acc[provider] = {
        configured: requirement.configured(),
        envVar: requirement.envVar,
      };
      return acc;
    },
    {},
  );
}

export interface LLMConfigurationValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * 验证单个 Model Key
 */
export function validateModelKey(modelKey: string): { valid: boolean; error?: string } {
  // 检查 Model 是否已注册（支持 spec 格式）
  if (!isModelSpecValid(modelKey)) {
    return {
      valid: false,
      error: `Model "${modelKey}" is not registered. Available: ${getRegisteredModels().join(', ')}`,
    };
  }

  // 检查 Provider 是否配置了 API Key（strip query string）
  const qIdx = modelKey.indexOf('?');
  const baseKey = qIdx === -1 ? modelKey : modelKey.slice(0, qIdx);
  const config = modelRegistry.get(baseKey);
  if (config) {
    const provider = config.provider;
    if (!isProviderConfigured(provider)) {
      const requirement = providerConfigRequirements[provider];
      return {
        valid: false,
        error: `Provider "${provider}" for model "${modelKey}" is not configured. Set ${requirement?.envVar ?? provider}.`,
      };
    }
  }

  return { valid: true };
}

/**
 * 验证 LLM 配置
 *
 * 自动验证所有标记了 @LLMModelField() 装饰器的配置字段：
 * 1. Model 是否已注册
 * 2. 对应 Provider 的 API Key 是否已配置
 *
 * @example
 * // 在 bootstrap 中调用
 * const result = validateLLMConfiguration();
 * if (!result.valid) {
 *   throw new Error(`LLM configuration invalid: ${result.errors.join(', ')}`);
 * }
 * result.warnings.forEach(w => logger.warn(w));
 */
export function validateLLMConfiguration(): LLMConfigurationValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 获取所有标记了 @LLMModelField() 的字段
  const llmModelFields = getLLMModelFields();

  // 如果没有任何 LLM model 字段，跳过验证
  if (llmModelFields.length === 0) {
    return { valid: true, errors, warnings };
  }

  // 验证每个配置的 model
  for (const fieldName of llmModelFields) {
    const modelKey = SysEnv[fieldName as keyof typeof SysEnv] as string | undefined;

    // 跳过未配置的字段
    if (!modelKey) {
      continue;
    }

    const result = validateModelKey(modelKey);
    if (!result.valid && result.error) {
      errors.push(`[${fieldName}] ${result.error}`);
    }
  }

  // 可选：检查其他已注册模型的 Provider 状态（作为警告）
  const providerStatus = getProviderStatus();
  const unconfiguredProviders = Object.entries(providerStatus)
    .filter(([, status]) => !status.configured)
    .map(([provider, status]) => `${provider} (${status.envVar})`);

  if (unconfiguredProviders.length > 0) {
    warnings.push(`Unconfigured providers: ${unconfiguredProviders.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
