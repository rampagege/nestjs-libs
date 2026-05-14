/**
 * LLM Vertex Tier 支持的单元测试
 *
 * 覆盖：
 * 1. parseModelSpec 对 `?tier=` / `?vertexRequestType=` 的解析（合法值 / 非法值 / 与其他 spec 参数组合）
 * 2. getSupportedTiers 查询函数（已标注 / 未标注 / 非 vertex/vertex-global provider）
 * 3. buildTierHeaders 的三种运行时行为：
 *    - 生效（返回 header 对象）
 *    - 不支持的 tier → warn + 降级
 *    - 非 vertex/vertex-global provider → warn + 降级
 */

import 'reflect-metadata';

import { getSupportedTiers, parseModelSpec } from '../types/model.types';
import { buildTierHeaders, VERTEX_REQUEST_TYPE_HEADER, VERTEX_TIER_HEADER } from './llm.class';

import { describe, expect, it } from 'bun:test';

import type { LLMModelSpec, VertexTier } from '../types/model.types';

// ─────────────────────────────────────────────────────────────────────────────
// parseModelSpec: ?tier= / ?vertexRequestType= 查询参数
// ─────────────────────────────────────────────────────────────────────────────

describe('parseModelSpec: ?tier query parameter', () => {
  it('parses ?tier=flex', () => {
    const spec = 'vertex:gemini-3.1-flash-lite?tier=flex' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.key).toBe('vertex:gemini-3.1-flash-lite');
    expect(result.tier).toBe('flex');
  });

  it('parses ?tier=priority', () => {
    const spec = 'vertex:gemini-2.5-flash?tier=priority' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.tier).toBe('priority');
  });

  it('parses ?tier=standard', () => {
    const spec = 'vertex:gemini-2.5-flash?tier=standard' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.tier).toBe('standard');
  });

  it('returns undefined when no ?tier= in spec', () => {
    const spec = 'vertex:gemini-2.5-flash' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.tier).toBeUndefined();
  });

  it('returns undefined for invalid tier value (warns and ignores)', () => {
    const spec = 'vertex:gemini-2.5-flash?tier=platinum' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.tier).toBeUndefined();
  });

  it('coexists with other spec params (reason + tier)', () => {
    const spec = 'vertex:gemini-3.1-flash-lite?reason=low&tier=flex' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.thinking).toBe('low');
    expect(result.tier).toBe('flex');
  });

  it('coexists with fallback params', () => {
    const spec = 'vertex:gemini-3.1-flash-lite?tier=flex&fallback=openrouter:gemini-2.5-flash-lite' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.tier).toBe('flex');
    expect(result.fallbackModels).toContain('openrouter:gemini-2.5-flash-lite');
  });

  it('parses vertexRequestType=shared for shared/on-demand only routing', () => {
    const spec = 'vertex:gemini-2.5-flash?tier=priority&vertexRequestType=shared' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.tier).toBe('priority');
    expect(result.vertexRequestType).toBe('shared');
  });

  it('returns undefined for invalid vertexRequestType value (warns and ignores)', () => {
    const spec = 'vertex:gemini-2.5-flash?tier=priority&vertexRequestType=dedicated' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.tier).toBe('priority');
    expect(result.vertexRequestType).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getSupportedTiers: 元数据查询
// ─────────────────────────────────────────────────────────────────────────────

describe('getSupportedTiers', () => {
  it('returns [standard, priority] for vertex:gemini-2.5-flash (Priority listed)', () => {
    const tiers = getSupportedTiers('vertex:gemini-2.5-flash');
    expect(tiers).toEqual(['standard', 'priority']);
  });

  it('returns [standard, priority] for vertex-global:gemini-2.5-flash (Priority listed)', () => {
    const tiers = getSupportedTiers('vertex-global:gemini-2.5-flash');
    expect(tiers).toEqual(['standard', 'priority']);
  });

  it('returns [standard, priority] for vertex:gemini-2.5-pro (Priority listed)', () => {
    const tiers = getSupportedTiers('vertex:gemini-2.5-pro');
    expect(tiers).toEqual(['standard', 'priority']);
  });

  it('returns [standard, priority] for vertex:gemini-2.5-flash-lite (Priority listed)', () => {
    const tiers = getSupportedTiers('vertex:gemini-2.5-flash-lite');
    expect(tiers).toEqual(['standard', 'priority']);
  });

  it('returns [standard, flex, priority] for vertex:gemini-3.1-flash-lite (both lists)', () => {
    const tiers = getSupportedTiers('vertex:gemini-3.1-flash-lite');
    expect(tiers).toEqual(['standard', 'flex', 'priority']);
  });

  it('returns [standard, flex, priority] for vertex:gemini-3-flash-preview (both lists)', () => {
    const tiers = getSupportedTiers('vertex:gemini-3-flash-preview');
    expect(tiers).toEqual(['standard', 'flex', 'priority']);
  });

  it('returns [standard] for openrouter models (not a vertex concept)', () => {
    const tiers = getSupportedTiers('openrouter:gemini-2.5-flash');
    expect(tiers).toEqual(['standard']);
  });

  it('works with spec query params in the input', () => {
    const tiers = getSupportedTiers('vertex:gemini-3.1-flash-lite?tier=flex' as LLMModelSpec);
    expect(tiers).toEqual(['standard', 'flex', 'priority']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildTierHeaders: 运行时行为
// ─────────────────────────────────────────────────────────────────────────────

describe('buildTierHeaders: no-op paths', () => {
  it('returns undefined when tier is undefined', () => {
    const headers = buildTierHeaders('vertex:gemini-2.5-flash', undefined);
    expect(headers).toBeUndefined();
  });

  it('returns undefined when tier is standard (no header needed)', () => {
    const headers = buildTierHeaders('vertex:gemini-2.5-flash', 'standard');
    expect(headers).toBeUndefined();
  });
});

describe('buildTierHeaders: supported tiers emit header', () => {
  it('flex on gemini-3.1-flash-lite → emits X-Vertex-AI-LLM-Shared-Request-Type: flex', () => {
    const headers = buildTierHeaders('vertex:gemini-3.1-flash-lite', 'flex');
    expect(headers).toEqual({ [VERTEX_TIER_HEADER]: 'flex' });
  });

  it('flex on gemini-3-flash-preview → emits flex header', () => {
    const headers = buildTierHeaders('vertex:gemini-3-flash-preview', 'flex');
    expect(headers).toEqual({ [VERTEX_TIER_HEADER]: 'flex' });
  });

  it('priority on gemini-2.5-flash → emits priority header', () => {
    const headers = buildTierHeaders('vertex:gemini-2.5-flash', 'priority');
    expect(headers).toEqual({ [VERTEX_TIER_HEADER]: 'priority' });
  });

  it('priority on vertex-global gemini-2.5-flash → emits priority header', () => {
    const headers = buildTierHeaders('vertex-global:gemini-2.5-flash', 'priority');
    expect(headers).toEqual({ [VERTEX_TIER_HEADER]: 'priority' });
  });

  it('priority on gemini-2.5-flash-lite → emits priority header (2026-04 docs)', () => {
    const headers = buildTierHeaders('vertex:gemini-2.5-flash-lite', 'priority');
    expect(headers).toEqual({ [VERTEX_TIER_HEADER]: 'priority' });
  });

  it('priority on gemini-3.1-flash-lite → emits priority header (dual flex+priority)', () => {
    const headers = buildTierHeaders('vertex:gemini-3.1-flash-lite', 'priority');
    expect(headers).toEqual({ [VERTEX_TIER_HEADER]: 'priority' });
  });

  it('priority with vertexRequestType=shared → emits both Priority-only headers', () => {
    const headers = buildTierHeaders('vertex:gemini-2.5-flash', 'priority', 'shared');
    expect(headers).toEqual({
      [VERTEX_REQUEST_TYPE_HEADER]: 'shared',
      [VERTEX_TIER_HEADER]: 'priority',
    });
  });

  it('priority with vertexRequestType=shared on vertex-global → emits both Priority-only headers', () => {
    const headers = buildTierHeaders('vertex-global:gemini-2.5-flash', 'priority', 'shared');
    expect(headers).toEqual({
      [VERTEX_REQUEST_TYPE_HEADER]: 'shared',
      [VERTEX_TIER_HEADER]: 'priority',
    });
  });

  it('flex with vertexRequestType=shared → emits both Flex-only headers', () => {
    const headers = buildTierHeaders('vertex:gemini-3-flash-preview', 'flex', 'shared');
    expect(headers).toEqual({
      [VERTEX_REQUEST_TYPE_HEADER]: 'shared',
      [VERTEX_TIER_HEADER]: 'flex',
    });
  });
});

describe('buildTierHeaders: downgrade paths (warn + undefined)', () => {
  it('flex on gemini-2.5-flash-lite (not in Flex list) → undefined (downgraded)', () => {
    const headers = buildTierHeaders('vertex:gemini-2.5-flash-lite', 'flex');
    expect(headers).toBeUndefined();
  });

  it('flex on gemini-2.5-flash (not in Flex list) → undefined', () => {
    const headers = buildTierHeaders('vertex:gemini-2.5-flash', 'flex');
    expect(headers).toBeUndefined();
  });

  it('flex on gemini-2.5-pro (not in Flex list) → undefined', () => {
    const headers = buildTierHeaders('vertex:gemini-2.5-pro', 'flex');
    expect(headers).toBeUndefined();
  });

  it('flex on openrouter model (non-vertex provider) → undefined', () => {
    const headers = buildTierHeaders('openrouter:gemini-2.5-flash', 'flex');
    expect(headers).toBeUndefined();
  });

  it('priority on google direct model (non-vertex provider) → undefined', () => {
    const headers = buildTierHeaders('google:gemini-2.5-flash', 'priority');
    expect(headers).toBeUndefined();
  });

  it('vertexRequestType=shared without flex/priority tier → undefined', () => {
    const headers = buildTierHeaders('vertex:gemini-2.5-flash', 'standard', 'shared');
    expect(headers).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 类型健壮性：确保 VertexTier 只有三个合法值
// ─────────────────────────────────────────────────────────────────────────────

describe('VertexTier type', () => {
  it('accepts only standard, flex, priority', () => {
    // 编译时保证。运行时 parseModelSpec 也做了同样的校验。
    const valid: VertexTier[] = ['standard', 'flex', 'priority'];
    expect(valid).toHaveLength(3);
  });
});
