import 'reflect-metadata';

import { stripVertexFunctionCallIds } from './llm.clients';

import { describe, expect, it } from 'bun:test';

describe('stripVertexFunctionCallIds', () => {
  it('strips functionCall.id and functionResponse.id from contents parts', () => {
    const body = JSON.stringify({
      generationConfig: { temperature: 0 },
      contents: [
        { role: 'user', parts: [{ text: 'hi' }] },
        { role: 'model', parts: [{ functionCall: { id: 'abc123', name: 'get_secret', args: { key: 'x' } } }] },
        { role: 'user', parts: [{ functionResponse: { id: 'abc123', name: 'get_secret', response: { ok: true } } }] },
      ],
    });
    const out = JSON.parse(stripVertexFunctionCallIds(body)) as {
      contents: Array<{ parts: Array<Record<string, Record<string, unknown>>> }>;
    };
    expect(out.contents[1]!.parts[0]!.functionCall).toEqual({ name: 'get_secret', args: { key: 'x' } });
    expect(out.contents[2]!.parts[0]!.functionResponse).toEqual({ name: 'get_secret', response: { ok: true } });
  });

  it('returns body unchanged when no function call parts present (fast path, no parse)', () => {
    const body = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] });
    expect(stripVertexFunctionCallIds(body)).toBe(body);
  });

  it('returns non-JSON body verbatim', () => {
    expect(stripVertexFunctionCallIds('functionCall not-json')).toBe('functionCall not-json');
  });

  it('preserves thoughtSignature and sibling part fields', () => {
    const body = JSON.stringify({
      contents: [
        {
          role: 'model',
          parts: [{ functionCall: { id: 'z', name: 'f', args: {} }, thoughtSignature: 'sig' }],
        },
      ],
    });
    const out = JSON.parse(stripVertexFunctionCallIds(body)) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(out.contents[0]!.parts[0]!.thoughtSignature).toBe('sig');
    expect(out.contents[0]!.parts[0]!.functionCall).toEqual({ name: 'f', args: {} });
  });
});
