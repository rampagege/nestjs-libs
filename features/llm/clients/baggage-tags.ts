/**
 * OTel Baggage → AI SDK telemetry.metadata.tags 合并 (MIS-423 Phase 3)
 *
 * 跨进程 sandbox-origin trace 标识传播:
 *
 *   [calo-server HTTP middleware]
 *      ↓  detectSandboxTags(req) → string[]
 *      ↓  propagation.setBaggage(ctx, { 'sandbox.tags': JSON.stringify(tags) })
 *      ↓  context.with(ctx, () => next())
 *   [W3C Baggage propagator on outbound gRPC client]
 *      ↓  serialize 'baggage: sandbox.tags=...' header
 *   [calo-agents gRPC server extracts baggage → active context]
 *      ↓  LLM.generateText(...) 等入口
 *      ↓  mergeBaggageTags({ isEnabled: true, ... }) 读 active baggage
 *      ↓  experimental_telemetry: { metadata: { tags: [...base, ...sandbox] } }
 *   [Vercel AI SDK ai.* span 写 attribute 'ai.telemetry.metadata.tags']
 *      ↓
 *   [Langfuse @langfuse/otel processor 接到 scope='ai' span]
 *      ↓
 *   [Langfuse trace.tags 出现 'sandbox-origin' ...]
 *
 * 为什么不在 HTTP root span 直接 setAttribute:
 *   calo-server libs/instrument.ts 的 shouldExportSpan 只放 scope='ai' span 给
 *   Langfuse processor, HTTP root span (scope='http-server') 被过滤掉, tag 永远
 *   到不了 Langfuse。Baggage 是 OTel 标准跨进程载体, 让 tag 走到 ai 层落地。
 */

import { context, propagation } from '@opentelemetry/api';

import type { Context } from '@opentelemetry/api';
import type { TelemetrySettings } from 'ai';

export const SANDBOX_TAGS_BAGGAGE_KEY = 'sandbox.tags';

/**
 * 从 OTel Baggage 读 sandbox tags, merge 进 telemetry.metadata.tags。
 *
 * `ctx` 默认 `context.active()` — production 路径用当前 active context。
 * 测试场景可显式传入 `propagation.setBaggage(ROOT_CONTEXT, ...)` 构造的 context,
 * 避免依赖 AsyncHooksContextManager 注册。
 *
 * 失败回退 (无 baggage / 非 JSON / 非数组) 都返 base 原样 — telemetry 不该因为
 * 旁路诊断功能失败而崩。非 string 元素被过滤, 不进 tags。
 */
export function mergeBaggageTags(base: TelemetrySettings, ctx: Context = context.active()): TelemetrySettings {
  const baggage = propagation.getBaggage(ctx);
  const entry = baggage?.getEntry(SANDBOX_TAGS_BAGGAGE_KEY);
  if (!entry) return base;

  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.value);
  } catch {
    return base;
  }
  if (!Array.isArray(parsed)) return base;

  const baggageTags = parsed.filter((t): t is string => typeof t === 'string');
  if (baggageTags.length === 0) return base;

  const baseTags = base.metadata?.tags;
  const existing = Array.isArray(baseTags) ? baseTags.filter((t): t is string => typeof t === 'string') : [];

  return {
    ...base,
    metadata: {
      ...(base.metadata ?? {}),
      tags: [...existing, ...baggageTags],
    },
  };
}
