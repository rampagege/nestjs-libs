import { assertRequiredEnvs } from './bootstrap';

import { afterEach, describe, expect, it } from 'bun:test';

describe('assertRequiredEnvs', () => {
  const ORIGINAL_VERTEX = process.env.AI_GOOGLE_VERTEX_API_KEY;
  const ORIGINAL_OPENROUTER = process.env.AI_OPENROUTER_API_KEY;

  afterEach(() => {
    if (ORIGINAL_VERTEX === undefined) delete process.env.AI_GOOGLE_VERTEX_API_KEY;
    else process.env.AI_GOOGLE_VERTEX_API_KEY = ORIGINAL_VERTEX;
    if (ORIGINAL_OPENROUTER === undefined) delete process.env.AI_OPENROUTER_API_KEY;
    else process.env.AI_OPENROUTER_API_KEY = ORIGINAL_OPENROUTER;
  });

  it('no-ops when keys are omitted or empty', () => {
    expect(() => assertRequiredEnvs()).not.toThrow();
    expect(() => assertRequiredEnvs([])).not.toThrow();
  });

  it('passes when all required SysEnvConfigKey values are non-blank', () => {
    process.env.AI_GOOGLE_VERTEX_API_KEY = 'vertex-key';
    process.env.AI_OPENROUTER_API_KEY = 'or-key';

    expect(() => assertRequiredEnvs(['AI_GOOGLE_VERTEX_API_KEY', 'AI_OPENROUTER_API_KEY'])).not.toThrow();
  });

  it('throws listing every missing or blank required env', () => {
    delete process.env.AI_GOOGLE_VERTEX_API_KEY;
    process.env.AI_OPENROUTER_API_KEY = '   ';

    expect(() => assertRequiredEnvs(['AI_GOOGLE_VERTEX_API_KEY', 'AI_OPENROUTER_API_KEY'])).toThrow(
      'required env(s) not set: AI_GOOGLE_VERTEX_API_KEY, AI_OPENROUTER_API_KEY',
    );
  });

  it('does not embed secret values in the error message', () => {
    process.env.AI_GOOGLE_VERTEX_API_KEY = 'super-secret-vertex-key';
    delete process.env.AI_OPENROUTER_API_KEY;

    try {
      assertRequiredEnvs(['AI_GOOGLE_VERTEX_API_KEY', 'AI_OPENROUTER_API_KEY']);
      expect.unreachable('expected assertRequiredEnvs to throw');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      expect(message).toContain('AI_OPENROUTER_API_KEY');
      expect(message).not.toContain('super-secret-vertex-key');
    }
  });
});
