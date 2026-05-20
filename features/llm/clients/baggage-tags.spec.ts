/**
 * baggage-tags 单测
 *
 * 验证 mergeBaggageTags 从 OTel Baggage 提取 tags 合并进 AI SDK telemetry.metadata.tags。
 * 显式传 ctx 参数, 不依赖 ContextManager 注册。
 */

import { mergeBaggageTags, SANDBOX_TAGS_BAGGAGE_KEY } from './baggage-tags';

import { context as _ctx, propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import { describe, expect, it } from 'bun:test';

function ctxWithTags(rawValue: string): ReturnType<typeof propagation.setBaggage> {
  const baggage = propagation.createBaggage({
    [SANDBOX_TAGS_BAGGAGE_KEY]: { value: rawValue },
  });
  return propagation.setBaggage(ROOT_CONTEXT, baggage);
}

function ctxWithTagsArray(tags: string[]): ReturnType<typeof propagation.setBaggage> {
  return ctxWithTags(JSON.stringify(tags));
}

describe('mergeBaggageTags', () => {
  it('无 baggage → 返 base 原样', () => {
    const base = { isEnabled: true, metadata: { userId: 'u1' } };
    expect(mergeBaggageTags(base, ROOT_CONTEXT)).toEqual(base);
  });

  it('baggage 有 tags + base 无 metadata → metadata.tags 来自 baggage', () => {
    const ctx = ctxWithTagsArray(['sandbox-origin', 'source:eval']);
    const result = mergeBaggageTags({ isEnabled: true }, ctx);
    expect(result.metadata?.tags).toEqual(['sandbox-origin', 'source:eval']);
  });

  it('baggage tags 与 base.metadata.tags 合并 (顺序: base 先, baggage 后)', () => {
    const ctx = ctxWithTagsArray(['sandbox-origin']);
    const result = mergeBaggageTags({ isEnabled: true, metadata: { tags: ['caller-supplied'] } }, ctx);
    expect(result.metadata?.tags).toEqual(['caller-supplied', 'sandbox-origin']);
  });

  it('保留 base.metadata 其他字段', () => {
    const ctx = ctxWithTagsArray(['sandbox-origin']);
    const result = mergeBaggageTags({ isEnabled: true, metadata: { userId: 'u1', sessionId: 's1' } }, ctx);
    expect(result.metadata?.userId).toBe('u1');
    expect(result.metadata?.sessionId).toBe('s1');
    expect(result.metadata?.tags).toEqual(['sandbox-origin']);
  });

  it('baggage value 不是合法 JSON → 静默回退 base, 不抛', () => {
    const base = { isEnabled: true };
    const ctx = ctxWithTags('not-json');
    expect(mergeBaggageTags(base, ctx)).toEqual(base);
  });

  it('baggage value 是 JSON 但非数组 → 静默回退', () => {
    const base = { isEnabled: true };
    const ctx = ctxWithTags('{"oops":1}');
    expect(mergeBaggageTags(base, ctx)).toEqual(base);
  });

  it('baggage value 数组含非 string 元素 → 过滤掉非 string', () => {
    const ctx = ctxWithTags('["ok",1,true,"also-ok"]');
    const result = mergeBaggageTags({ isEnabled: true }, ctx);
    expect(result.metadata?.tags).toEqual(['ok', 'also-ok']);
  });

  it('default ctx 参数 (context.active) — 无 ContextManager 时默认 ROOT_CONTEXT, 无 baggage → 返 base', () => {
    void _ctx; // 文档化: 默认参数 context.active() 在 test 无 ContextManager 时返 ROOT
    const base = { isEnabled: true };
    expect(mergeBaggageTags(base)).toEqual(base);
  });
});
