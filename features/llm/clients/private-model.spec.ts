import { privateModel } from './private-model';

import { expect, it } from 'bun:test';

import type { LanguageModelV4 } from '@ai-sdk/provider';

const error = () => new Error('PRIVATE_BODY', { cause: { request: 'PRIVATE_BODY' } });
const model = {
  specificationVersion: 'v4',
  provider: 'fixture',
  modelId: 'fixture',
  supportedUrls: {},
  doGenerate: async () => {
    throw error();
  },
  doStream: async () => ({
    stream: new ReadableStream({
      start(c) {
        c.enqueue({ type: 'error', error: error() });
        c.close();
      },
    }),
  }),
} as LanguageModelV4;
it('private provider errors carry no input/output/cause before SDK telemetry', async () => {
  const wrapped = privateModel(model, true) as LanguageModelV4;
  try {
    await wrapped.doGenerate({ prompt: [] });
    throw new Error('expected failure');
  } catch (e) {
    expect(String(e)).not.toContain('PRIVATE_BODY');
    expect((e as Error).cause).toBeUndefined();
  }
  const result = await wrapped.doStream({ prompt: [] });
  const read = await result.stream.getReader().read();
  expect(JSON.stringify(read)).not.toContain('PRIVATE_BODY');
});
it('ordinary model requests preserve provider behavior', () => {
  expect(privateModel(model, false)).toBe(model);
});

it('private API errors preserve status and retry semantics without provider details', async () => {
  const { APICallError } = await import('ai');
  const { privateModelError } = await import('./private-model');
  const err = privateModelError(
    new APICallError({
      message: 'PRIVATE_BODY',
      url: 'PRIVATE_URL',
      requestBodyValues: { prompt: 'PRIVATE_BODY' },
      responseBody: 'PRIVATE_BODY',
      statusCode: 429,
      isRetryable: true,
    }),
  );
  expect(APICallError.isInstance(err)).toBe(true);
  expect(err).toMatchObject({ statusCode: 429, isRetryable: true });
  expect(JSON.stringify(err)).not.toContain('PRIVATE_');
});
