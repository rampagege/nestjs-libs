/**
 * LLM 成本计算工具
 *
 * 根据模型和 token 使用量计算成本
 *
 * 优先使用 API 返回的 cost（OpenRouter 现在支持），否则手动计算
 *
 * 价格数据来源：llm.clients.ts（2026-01）
 */

import type { LLMModelKey } from '../types/model.types';

// ═══════════════════════════════════════════════════════════════════════════
// 价格表（每百万 tokens）
// ═══════════════════════════════════════════════════════════════════════════

interface ModelPricing {
  input: number; // 每百万 input tokens 的成本（美元）
  output: number; // 每百万 output tokens 的成本（美元）
}

/**
 * 模型价格表（2026-01）
 *
 * 来源：
 * - OpenRouter: https://openrouter.ai/models
 * - Google: https://ai.google.dev/pricing
 *
 * OpenRouter Provider 定价差异：
 * 同一模型不同 provider 定价不同，本表取最低价（如 DeepInfra）。
 * 实际成本随 OpenRouter 路由结果波动，Vertex 等 provider 可能贵 2-4x。
 * 选型时可通过 providerSort: 'price' 优先低价 provider。
 *
 * 更新频率：每月检查一次
 */
const MODEL_PRICING: Record<string, ModelPricing> = {
  // Gemini 系列
  // Gemini 定价来源: https://ai.google.dev/gemini-api/docs/pricing
  // OpenRouter 和 Vertex/Google AI 直连价格相同
  'google/gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'google/gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'google/gemini-2.5-pro': { input: 1.25, output: 10.0 }, // ≤200K tokens；>200K: $2.50/$15.00
  'google/gemini-3-flash-preview': { input: 0.5, output: 3.0 },
  'google/gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-2.5-pro': { input: 1.25, output: 10.0 }, // ≤200K tokens；>200K: $2.50/$15.00
  'gemini-3-flash-preview': { input: 0.5, output: 3.0 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },

  // Anthropic Claude 系列
  'anthropic/claude-3.5-sonnet': { input: 6.0, output: 30.0 },
  'anthropic/claude-3.5-haiku': { input: 0.8, output: 4.0 },
  'anthropic/claude-sonnet-4': { input: 3.0, output: 15.0 },
  'anthropic/claude-4-sonnet': { input: 3.0, output: 15.0 }, // alias
  'anthropic/claude-opus-4.1': { input: 15.0, output: 75.0 },
  'anthropic/claude-4-opus': { input: 5.0, output: 25.0 },

  // xAI Grok
  'x-ai/grok-3-mini': { input: 0.3, output: 0.5 },
  'x-ai/grok-4.1-fast': { input: 0.2, output: 0.5 },

  // StepFun
  'stepfun/step-3.5-flash:free': { input: 0, output: 0 },

  // DeepSeek（OpenRouter 最低价 provider：DeepInfra/AtlasCloud；Vertex 约 $0.56/$1.68）
  'deepseek/deepseek-v3.2': { input: 0.26, output: 0.38 },

  // MoonshotAI Kimi（OpenRouter 最低价 provider：SiliconFlow；Venice 约 $0.75/$3.75）
  'moonshotai/kimi-k2.5': { input: 0.23, output: 3.0 },

  // Z.ai GLM - 不考虑使用
  // 'z-ai/glm-5': { input: 0.3, output: 2.55 },

  // MiniMax（Inceptron $1.10，其他 provider $1.20）
  'minimax/minimax-m2.5': { input: 0.3, output: 1.1 },

  // OpenAI
  'openai/gpt-4o-mini': { input: 0.15, output: 0.6 },
  'openai/gpt-5.2': { input: 1.75, output: 14.0 },
  'openai/gpt-5.2-pro': { input: 21.0, output: 168.0 },
};

/**
 * 根据 modelId 获取价格
 *
 * @param modelId - 模型 ID（OpenRouter 格式或 Google 直连格式）
 * @returns 价格信息，如果未找到返回 null
 */
function getPricing(modelId: string): ModelPricing | null {
  return MODEL_PRICING[modelId] ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 成本计算
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 计算 LLM 调用成本（内部使用）
 */
function calculateCost(modelId: string, promptTokens: number, completionTokens: number): number | null {
  const pricing = getPricing(modelId);
  if (!pricing) return null;

  const inputCost = (promptTokens / 1_000_000) * pricing.input;
  const outputCost = (completionTokens / 1_000_000) * pricing.output;

  return inputCost + outputCost;
}

/**
 * 从 LLMModelKey 计算成本（内部使用）
 */
function calculateCostFromKey(
  modelKey: LLMModelKey | string,
  promptTokens: number,
  completionTokens: number,
): number | null {
  // 如果包含 ':'，说明是 LLMModelKey 格式
  if (modelKey.includes(':')) {
    // 从 LLMModelKey 提取 modelId
    // 'openrouter:gemini-2.5-flash' → 'google/gemini-2.5-flash'
    const [provider, ...modelParts] = modelKey.split(':');
    const modelName = modelParts.join(':');

    let modelId: string;
    if (provider === 'openrouter') {
      // 全称格式（含 '/'）：'z-ai/glm-5' 已是完整 modelId，直接使用
      if (modelName.includes('/')) {
        modelId = modelName;
      } else if (modelName.startsWith('gemini')) {
        modelId = `google/${modelName}`;
      } else if (modelName.startsWith('claude')) {
        modelId = `anthropic/${modelName}`;
      } else if (modelName.startsWith('grok')) {
        modelId = `x-ai/${modelName}`;
      } else if (modelName.startsWith('kimi')) {
        modelId = `moonshotai/${modelName}`;
      } else if (modelName.startsWith('deepseek')) {
        modelId = `deepseek/${modelName}`;
        // GLM - 不考虑使用
        // } else if (modelName.startsWith('glm')) {
        //   modelId = `z-ai/${modelName}`;
      } else if (modelName.startsWith('minimax')) {
        modelId = `minimax/${modelName}`;
      } else {
        modelId = modelName; // 假设已经包含 provider 前缀
      }
    } else if (provider === 'google') {
      // Google 直连格式是 'gemini-xxx'
      modelId = modelName;
    } else {
      return null;
    }

    return calculateCost(modelId, promptTokens, completionTokens);
  }

  // 否则当作 modelId 直接使用
  return calculateCost(modelKey, promptTokens, completionTokens);
}

/**
 * 从 usage 对象中获取成本
 *
 * 优先使用 API 返回的 cost，否则手动计算
 *
 * @param usage - AI SDK 返回的 usage 对象
 * @param modelKey - LLMModelKey（fallback 计算用）
 * @returns 成本（美元），如果无法计算返回 null
 */
export function getCostFromUsage(usage: unknown, modelKey?: LLMModelKey | string): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const usageObj = usage as Record<string, unknown>;

  // 优先使用 API 返回的 cost
  if (typeof usageObj.cost === 'number') {
    return usageObj.cost;
  }

  // Fallback: 手动计算
  if (modelKey) {
    const inputTokens =
      typeof usageObj.inputTokens === 'number'
        ? usageObj.inputTokens
        : typeof usageObj.promptTokens === 'number'
          ? usageObj.promptTokens
          : 0;
    const outputTokens =
      typeof usageObj.outputTokens === 'number'
        ? usageObj.outputTokens
        : typeof usageObj.completionTokens === 'number'
          ? usageObj.completionTokens
          : 0;
    return calculateCostFromKey(modelKey, inputTokens, outputTokens);
  }

  return null;
}
