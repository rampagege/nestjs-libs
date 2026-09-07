import 'reflect-metadata';

import { RequestContext } from '../trace/request-context';
import {
  configurePrivateHttpPaths,
  redactHttpRequestForTelemetry,
  redactHttpUrl,
  redactHttpUrlForPath,
  redactSpanAttributes,
  withSpanRedaction,
} from './http-url-redaction';
import { configureSensitivePayloadKeys, normalizePayloadForLog } from './log-redaction';
import { LoggerInterceptor } from './logger.interceptor';
import { PRIVATE_PAYLOAD } from './private-payload.decorator';

import { afterEach, expect, it } from 'bun:test';
import { of } from 'rxjs';

afterEach(() => {
  configurePrivateHttpPaths([]);
  configureSensitivePayloadKeys([]);
});

function httpContext(handler: () => void, request: Record<string, unknown>) {
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => Object,
    switchToHttp: () => ({ getRequest: () => request }),
  };
}

const privateRequest = () => ({
  url: '/api/email-connections/link/PRIVATE_TOKEN',
  path: '/api/email-connections/link/PRIVATE_TOKEN',
  method: 'POST',
  body: { code: 'PRIVATE_CODE' },
  query: { state: 'PRIVATE_STATE' },
  params: {},
  headers: { 'user-agent': 'probe', referer: 'https://calo.example/PRIVATE_REFERER' },
  ips: [],
  ip: '127.0.0.1',
  hostname: 'calo.example',
  user: { userId: 'user-1', uid: 'uid-1' },
});

it('a private handler keeps its request context; only the logged detail is withheld', async () => {
  const handler = () => undefined;
  Reflect.defineMetadata(PRIVATE_PAYLOAD, true, handler);

  let seen: { traceId?: string; userId?: string | null } = {};
  const observable = await new LoggerInterceptor().intercept(
    httpContext(handler, privateRequest()) as never,
    {
      handle: () => {
        seen = { traceId: RequestContext.get('traceId'), userId: RequestContext.get('userId') };
        return of('private result');
      },
    } as never,
  );
  await new Promise((resolve) => (observable as ReturnType<typeof of>).subscribe(resolve));

  expect(seen.traceId).toBeTruthy();
  expect(seen.userId).toBe('user-1');
});

it('a non-private handler is unaffected', async () => {
  const handler = () => undefined;
  let seen: string | undefined;
  const observable = await new LoggerInterceptor().intercept(
    httpContext(handler, privateRequest()) as never,
    {
      handle: () => {
        seen = RequestContext.get('traceId');
        return of('result');
      },
    } as never,
  );
  await new Promise((resolve) => (observable as ReturnType<typeof of>).subscribe(resolve));
  expect(seen).toBeTruthy();
});

it('an app declares its own private field names; the library ships none', () => {
  const payload = { fromAddress: 'PRIVATE_EMAIL', subject: 'PRIVATE_SUBJECT' };
  expect(JSON.stringify(normalizePayloadForLog(payload))).toContain('PRIVATE_EMAIL');

  configureSensitivePayloadKeys(['fromAddress', 'subject']);
  const safe = JSON.stringify(normalizePayloadForLog(payload));
  expect(safe).not.toContain('PRIVATE_');
  expect(safe).toContain('sensitive_field');
});

it('ordinary URLs stay legible; only credential query values are replaced', () => {
  expect(redactHttpUrl('/api/events?limit=20&cursor=abc&sort=desc')).toBe('/api/events?limit=20&cursor=abc&sort=desc');
  expect(redactHttpUrl('https://app.example/oauth/callback?code=SECRET&state=SECRET&provider=google')).toBe(
    'https://app.example/oauth/callback?code=[redacted]&state=[redacted]&provider=google',
  );
  // A long path segment is not a credential unless the app says the path is private.
  expect(redactHttpUrl('/api/objects/' + 'a'.repeat(43))).toBe('/api/objects/' + 'a'.repeat(43));
});

it('declared private paths drop the query and opaque path segments entirely', () => {
  configurePrivateHttpPaths(['/api/email-connections']);
  expect(redactHttpUrlForPath('/api/email-connections/link/' + 's'.repeat(43))).toBe(
    '/api/email-connections/link/[redacted]',
  );
  expect(redactHttpUrlForPath('/api/email-connections/google/callback?code=SECRET#SECRET')).toBe(
    '/api/email-connections/google/callback',
  );
  // A referrer pointing at a private page is judged by where it points.
  expect(redactHttpUrlForPath('https://calo.example/api/email-connections/link/' + 's'.repeat(43))).toBe(
    'https://calo.example/api/email-connections/link/[redacted]',
  );
});

it('private HTTP error telemetry drops browser cookies, JWTs and login bodies', () => {
  configurePrivateHttpPaths(['/api/email-connections']);
  const result = redactHttpRequestForTelemetry({
    url: '/api/email-connections/google/callback?code=PRIVATE_CODE',
    method: 'GET',
    headers: { cookie: 'PRIVATE_COOKIE', authorization: 'PRIVATE_JWT' },
    data: 'PRIVATE_BODY',
    cookies: 'PRIVATE_COOKIE',
    query_string: 'code=PRIVATE_CODE',
  });
  expect(result).toEqual({ url: '/api/email-connections/google/callback', method: 'GET' });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_');
});

it('other paths keep their error telemetry, with credential query values replaced', () => {
  const result = redactHttpRequestForTelemetry({
    url: '/api/events?limit=20&token=PRIVATE_TOKEN',
    method: 'POST',
    query_string: 'limit=20&token=PRIVATE_TOKEN',
  });
  expect(result).toMatchObject({
    url: '/api/events?limit=20&token=[redacted]',
    method: 'POST',
    query_string: 'limit=20&token=[redacted]',
  });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_');
});

it('a private path clears the whole query, not only the known credential keys', () => {
  configurePrivateHttpPaths(['/private']);
  const attributes: Record<string, unknown> = {
    'url.full': 'https://app.example/private/callback?ticket=PRIVATE_TICKET',
    'url.path': '/private/callback',
    'url.query': 'ticket=PRIVATE_TICKET',
  };
  redactSpanAttributes(attributes);
  expect(attributes['url.query']).toBe('[redacted]');
  expect(JSON.stringify(attributes)).not.toContain('PRIVATE_');
});

it('an ordinary span keeps its query, minus credential values, and redacts array referrers', () => {
  configurePrivateHttpPaths(['/private']);
  const attributes: Record<string, unknown> = {
    'url.path': '/api/events',
    'url.query': 'limit=20&token=PRIVATE_TOKEN',
    'http.request.header.referer': ['https://app.example/private/link/' + 's'.repeat(43)],
  };
  redactSpanAttributes(attributes);
  expect(attributes['url.query']).toBe('limit=20&token=[redacted]');
  expect(attributes['http.request.header.referer']).toEqual(['https://app.example/private/link/[redacted]']);
});

it('a span that ends on an error is still redacted before export', async () => {
  const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } =
    await import('@opentelemetry/sdk-trace-node');
  configurePrivateHttpPaths(['/private']);
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [withSpanRedaction(new SimpleSpanProcessor(exporter))],
  });
  const span = provider.getTracer('redaction-test').startSpan('GET');
  // The HTTP instrumentation skips applyCustomAttributesOnSpan on its error paths,
  // so nothing rewrites these attributes before the span is closed.
  span.setAttribute('url.full', 'https://app.example/private/callback?ticket=PRIVATE_TICKET');
  span.setAttribute('url.path', '/private/callback');
  span.setAttribute('url.query', 'ticket=PRIVATE_TICKET');
  span.recordException(new Error('connection reset'));
  span.end();
  await provider.forceFlush();

  const exported = exporter.getFinishedSpans();
  expect(exported).toHaveLength(1);
  expect(exported[0]!.attributes['url.query']).toBe('[redacted]');
  expect(JSON.stringify(exported[0]!.attributes)).not.toContain('PRIVATE_');
  await provider.shutdown();
});

it('a referrer pointing at a private link is redacted on an ordinary request', () => {
  configurePrivateHttpPaths(['/api/email-connections']);
  const result = redactHttpRequestForTelemetry({
    url: '/api/events',
    method: 'GET',
    headers: {
      Referer: 'https://calo.example/api/email-connections/link/' + 'P'.repeat(43),
      referrer: 'https://calo.example/api/email-connections/google/callback?code=PRIVATE_CODE',
      'user-agent': 'probe',
    },
  });
  const headers = (result as { headers: Record<string, string> }).headers;
  expect(headers.Referer).toBe('https://calo.example/api/email-connections/link/[redacted]');
  expect(headers.referrer).toBe('https://calo.example/api/email-connections/google/callback');
  expect(headers['user-agent']).toBe('probe');
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
