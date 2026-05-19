import { devFormatter, prodFormatter } from './log-formatter';

import { context, trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import type { LogRecord } from './log-formatter';

const VALID_TRACE_ID = 'a'.repeat(32);

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\[\d+m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, '');
}

function makeRecord(properties: Record<string, unknown> = {}): LogRecord {
  return {
    timestamp: 1_700_000_000_000,
    level: 'info',
    category: ['app', 'Foo'],
    message: ['hello'],
    rawMessage: 'hello',
    properties,
  };
}

describe('log-formatter traceId injection', () => {
  let provider: NodeTracerProvider;

  beforeAll(() => {
    // NodeTracerProvider 自动注册 AsyncHooks context manager, context.with 才能传递 active span
    provider = new NodeTracerProvider();
    provider.register();
  });

  afterAll(() => {
    void provider.shutdown();
    trace.disable();
  });

  describe('no active span', () => {
    it('devFormatter omits traceId tag', () => {
      const out = stripAnsi(devFormatter(makeRecord()));
      // 没 active span + properties 没传 traceId 时, dev formatter 不该输出 context tag 方括号
      expect(out).not.toContain('[');
    });

    it('prodFormatter omits traceId field', () => {
      const out = JSON.parse(prodFormatter(makeRecord())) as Record<string, unknown>;
      expect(out.traceId).toBeUndefined();
    });
  });

  describe('explicit properties.traceId wins', () => {
    it('devFormatter uses properties.traceId', () => {
      const out = devFormatter(makeRecord({ traceId: 'explicit-trace-id' }));
      expect(out).toContain('explicit-trace-id');
    });

    it('prodFormatter uses properties.traceId', () => {
      const out = JSON.parse(prodFormatter(makeRecord({ traceId: 'explicit-trace-id' }))) as Record<string, unknown>;
      expect(out.traceId).toBe('explicit-trace-id');
    });
  });

  describe('active span fallback', () => {
    it('devFormatter pulls traceId from active OTel span when properties.traceId missing', () => {
      const tracer = provider.getTracer('test');
      const span = tracer.startSpan('test-span');
      const ctx = trace.setSpan(context.active(), span);
      context.with(ctx, () => {
        const expectedTraceId = span.spanContext().traceId;
        const out = devFormatter(makeRecord());
        expect(out).toContain(expectedTraceId);
      });
      span.end();
    });

    it('prodFormatter adds traceId field from active OTel span', () => {
      const tracer = provider.getTracer('test');
      const span = tracer.startSpan('test-span');
      const ctx = trace.setSpan(context.active(), span);
      context.with(ctx, () => {
        const expectedTraceId = span.spanContext().traceId;
        const out = JSON.parse(prodFormatter(makeRecord())) as Record<string, unknown>;
        expect(out.traceId).toBe(expectedTraceId);
      });
      span.end();
    });
  });

  describe('invalid (all-zero) traceId guarded', () => {
    it('does not inject 000...000 when no real trace', () => {
      // No active span context = getActiveSpan() returns undefined or invalid
      const out = JSON.parse(prodFormatter(makeRecord())) as Record<string, unknown>;
      expect(out.traceId).not.toBe('0'.repeat(32));
    });

    it('valid-looking traceId passes through properties path', () => {
      const out = JSON.parse(prodFormatter(makeRecord({ traceId: VALID_TRACE_ID }))) as Record<string, unknown>;
      expect(out.traceId).toBe(VALID_TRACE_ID);
    });
  });
});
