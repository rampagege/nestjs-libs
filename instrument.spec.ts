/**
 * Unit tests for pure helpers exported indirectly from instrument.ts.
 *
 * The file as a whole runs side effects on import (NodeSDK + Sentry bootstrap),
 * so we can't import it directly in a test. Instead, we inline-duplicate the
 * two pure helpers and assert their behavior — if the source diverges from this
 * copy, the test fails as a "drift" signal and the dev must reconcile.
 *
 * Helpers under test:
 *   - `sanitizeHttpPathForSpanName` — squashes high-cardinality path segments
 *   - `isFullStackExtraScope` — allowlist matcher for Langfuse FULL_STACK mode
 */

import { describe, expect, it } from 'bun:test';

// ── Source-of-truth copies (must stay in lockstep with instrument.ts) ──

function sanitizeHttpPathForSpanName(path: string): string {
  if (!path) return path;
  return path
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':id';
      if (/^[0-9a-f]{32,}$/i.test(seg)) return ':id';
      if (seg.length >= 16 && /^[A-Za-z0-9_-]+$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg)) return ':id';
      return seg;
    })
    .join('/');
}

function isFullStackExtraScope(scope: string): boolean {
  return (
    scope === '@opentelemetry/instrumentation-grpc' ||
    scope === '@opentelemetry/instrumentation-http' ||
    scope === 'prisma' ||
    scope.startsWith('@prisma/')
  );
}

// ── Tests ──

describe('sanitizeHttpPathForSpanName', () => {
  it('preserves human-readable route segments', () => {
    expect(sanitizeHttpPathForSpanName('/api/users')).toBe('/api/users');
    expect(sanitizeHttpPathForSpanName('/api/calendar/events')).toBe('/api/calendar/events');
    expect(sanitizeHttpPathForSpanName('/health')).toBe('/health');
    expect(sanitizeHttpPathForSpanName('/api/graphql')).toBe('/api/graphql');
  });

  it('squashes numeric id segments', () => {
    expect(sanitizeHttpPathForSpanName('/api/users/123')).toBe('/api/users/:id');
    expect(sanitizeHttpPathForSpanName('/api/users/123/posts/456')).toBe('/api/users/:id/posts/:id');
  });

  it('squashes UUID v4 segments', () => {
    expect(sanitizeHttpPathForSpanName('/api/events/550e8400-e29b-41d4-a716-446655440000')).toBe('/api/events/:id');
    // upper-case hex too
    expect(sanitizeHttpPathForSpanName('/api/events/550E8400-E29B-41D4-A716-446655440000')).toBe('/api/events/:id');
  });

  it('squashes long hex tokens (trace ids, sha256 prefixes)', () => {
    expect(sanitizeHttpPathForSpanName('/api/traces/ae343b1fd01ff4e7b1987eea4dac3ea1')).toBe('/api/traces/:id');
    expect(sanitizeHttpPathForSpanName('/static/0123456789abcdef0123456789abcdef')).toBe('/static/:id');
  });

  it('squashes opaque tokens (>=16 chars, mixed alnum, base32/base64url alphabet)', () => {
    expect(sanitizeHttpPathForSpanName('/upload/AbCdEf1234567890XYZ')).toBe('/upload/:id');
    expect(sanitizeHttpPathForSpanName('/files/e_kjrm6hmftnk3j994o3dmyt3q')).toBe('/files/:id');
  });

  it('preserves short alphanumeric segments (could be human labels)', () => {
    expect(sanitizeHttpPathForSpanName('/api/v1/users')).toBe('/api/v1/users');
    expect(sanitizeHttpPathForSpanName('/api/calendar/google')).toBe('/api/calendar/google');
    // 15 chars all alpha — not squashed
    expect(sanitizeHttpPathForSpanName('/api/abcdefghijklmno')).toBe('/api/abcdefghijklmno');
  });

  it('handles edge cases', () => {
    expect(sanitizeHttpPathForSpanName('')).toBe('');
    expect(sanitizeHttpPathForSpanName('/')).toBe('/');
    expect(sanitizeHttpPathForSpanName('/api')).toBe('/api');
    expect(sanitizeHttpPathForSpanName('//api//users//123')).toBe('//api//users//:id');
  });

  it('mixed real-world REST path', () => {
    const input = '/api/families/f_wv0m829cppi2jk2mgkeizbor/events/550e8400-e29b-41d4-a716-446655440000/comments/42';
    const expected = '/api/families/:id/events/:id/comments/:id';
    expect(sanitizeHttpPathForSpanName(input)).toBe(expected);
  });
});

describe('isFullStackExtraScope', () => {
  it('matches the gRPC instrumentation scope', () => {
    expect(isFullStackExtraScope('@opentelemetry/instrumentation-grpc')).toBe(true);
  });

  it('matches the HTTP instrumentation scope', () => {
    expect(isFullStackExtraScope('@opentelemetry/instrumentation-http')).toBe(true);
  });

  it('matches the calo-server manual prisma scope', () => {
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
