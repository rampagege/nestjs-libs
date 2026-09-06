import 'reflect-metadata';

import { normalizePayloadForLog } from './log-redaction';
import { LoggerInterceptor } from './logger.interceptor';
import { PRIVATE_PAYLOAD } from './private-payload.decorator';

import { expect, it } from 'bun:test';
import { of } from 'rxjs';

it('private endpoints never inspect URLs, payloads or errors through the generic logger', () => {
  const handler = () => undefined;
  Reflect.defineMetadata(PRIVATE_PAYLOAD, true, handler);
  const result = of('private result');
  const context = {
    getHandler: () => handler,
    getClass: () => Object,
    switchToHttp: () => {
      throw new Error('must not read sensitive request');
    },
  };
  expect(new LoggerInterceptor().intercept(context as never, { handle: () => result } as never)).toBe(result);
});

it('short email fields are private regardless of string length', () => {
  const safe = JSON.stringify(
    normalizePayloadForLog({
      fromAddress: 'PRIVATE_EMAIL',
      subject: 'PRIVATE_SUBJECT',
      snippet: 'PRIVATE_SNIPPET',
      bodyText: 'PRIVATE_BODY',
    }),
  );
  expect(safe).not.toContain('PRIVATE_');
  expect(safe).toContain('sensitive_field');
});

it('diagnostic URLs exclude OAuth codes, state, fragments and opaque path tokens', async () => {
  const { redactHttpUrl } = await import('./http-url-redaction');
  expect(
    redactHttpUrl('https://calo.example/api/email-connections/google/callback?code=SECRET&state=SECRET#SECRET'),
  ).toBe('https://calo.example/api/email-connections/google/callback');
  expect(redactHttpUrl('/api/email-connections/link/' + 's'.repeat(43))).toBe('/api/email-connections/link/[redacted]');
});
