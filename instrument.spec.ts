/**
 * Unit tests for helpers in `instrument-helpers.ts`.
 *
 * `instrument.ts` runs side effects on import (NodeSDK + Sentry bootstrap), so
 * pure logic worth testing lives in `instrument-helpers.ts` and is imported
 * here directly — single source of truth, no drift risk.
 */

import { isFullStackExtraScope } from './instrument-helpers';

import { describe, expect, it } from 'bun:test';

describe('isFullStackExtraScope', () => {
  it('matches the gRPC instrumentation scope', () => {
    expect(isFullStackExtraScope('@opentelemetry/instrumentation-grpc')).toBe(true);
  });

  it('matches the HTTP instrumentation scope', () => {
    expect(isFullStackExtraScope('@opentelemetry/instrumentation-http')).toBe(true);
  });

  it('matches the manual prisma tracer scope', () => {
    expect(isFullStackExtraScope('prisma')).toBe(true);
  });

  it('matches @prisma/* scope prefix (instrumentation package variants)', () => {
    expect(isFullStackExtraScope('@prisma/instrumentation')).toBe(true);
    expect(isFullStackExtraScope('@prisma/client')).toBe(true);
  });

  it('rejects unknown / AI / arbitrary scopes', () => {
    expect(isFullStackExtraScope('')).toBe(false);
    expect(isFullStackExtraScope('ai')).toBe(false);
    expect(isFullStackExtraScope('@nestjs/common')).toBe(false);
    expect(isFullStackExtraScope('app')).toBe(false);
    expect(isFullStackExtraScope('@opentelemetry/sdk-node')).toBe(false);
  });
});
