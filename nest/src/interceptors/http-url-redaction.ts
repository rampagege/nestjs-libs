/**
 * Two tiers of URL redaction.
 *
 * The default tier keeps diagnostics readable. The path is preserved and only
 * credential-shaped query values are replaced, which mirrors how payload
 * redaction here already works: by key, not by discarding the whole value.
 *
 * The private tier applies to paths an app declares through
 * `bootstrap({ privateHttpPaths })`, where the URL itself is the credential —
 * one-time authorization links, magic links, presigned object keys. There the
 * query and fragment are dropped and opaque path segments are removed.
 */

/** Query keys whose values are credentials across the common OAuth/session flows. */
const SENSITIVE_QUERY_KEY_PATTERN =
  /^(code|state|token|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|secret|password|passcode|sig|signature|api[-_]?key|apikey|auth|authorization|session)$/i;

/** High-entropy path segments: one-time links, presigned keys, raw tokens. */
const OPAQUE_PATH_SEGMENT = /(^|\/)[A-Za-z0-9_-]{32,}(?=\/|$)/g;

function decodeKey(key: string): string {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

/** Replace credential query values, keep everything else legible. */
export function redactQueryString(query: string): string {
  if (!query) return query;
  return query
    .split('&')
    .map((pair) => {
      const separator = pair.indexOf('=');
      if (separator < 0) return pair;
      const key = pair.slice(0, separator);
      return SENSITIVE_QUERY_KEY_PATTERN.test(decodeKey(key)) ? `${key}=[redacted]` : pair;
    })
    .join('&');
}

/** Default tier. */
export function redactHttpUrl(value: string): string {
  const raw = value.split('#', 1)[0] ?? '';
  const separator = raw.indexOf('?');
  if (separator < 0) return raw;
  const query = redactQueryString(raw.slice(separator + 1));
  return query ? `${raw.slice(0, separator)}?${query}` : raw.slice(0, separator);
}

/** Private tier: the URL itself is authorization material. */
export function redactPrivateHttpUrl(value: string): string {
  return (value.split(/[?#]/, 1)[0] ?? '').replace(OPAQUE_PATH_SEGMENT, '$1[redacted]');
}

let privatePaths: readonly string[] = [];
export function configurePrivateHttpPaths(paths: readonly string[]): void {
  privatePaths = [...paths];
}

export function isPrivateHttpPath(value: string): boolean {
  if (privatePaths.length === 0) return false;
  let path: string;
  try {
    path = new URL(value, 'https://local.invalid').pathname;
  } catch {
    return false;
  }
  return privatePaths.some((prefix) => path === prefix || path.startsWith(prefix + '/'));
}

/** Choose the tier from the URL's own path, so a referrer is judged by where it points. */
export function redactHttpUrlForPath(value: string): string {
  return isPrivateHttpPath(value) ? redactPrivateHttpUrl(value) : redactHttpUrl(value);
}

const REFERRER_HEADER_PATTERN = /^referr?er$/i;

/** Declared private paths keep only a redacted URL and method in error telemetry. */
export function redactHttpRequestForTelemetry<T extends { url?: string; method?: string; query_string?: unknown }>(
  request: T,
): T | { url?: string; method?: string } {
  if (isPrivateHttpPath(request.url ?? '')) {
    return { url: redactPrivateHttpUrl(request.url ?? ''), method: request.method };
  }
  const result = { ...request };
  if (result.url) result.url = redactHttpUrl(result.url);
  if (typeof result.query_string === 'string') result.query_string = redactQueryString(result.query_string);
  else if (result.query_string !== undefined) delete result.query_string;
  // An ordinary request can still carry a private authorization link in its referrer.
  const headers = (result as { headers?: unknown }).headers;
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    const copy: Record<string, unknown> = { ...(headers as Record<string, unknown>) };
    for (const key of Object.keys(copy)) {
      if (!REFERRER_HEADER_PATTERN.test(key)) continue;
      const value = copy[key];
      if (typeof value === 'string') copy[key] = redactHttpUrlForPath(value);
    }
    (result as { headers?: unknown }).headers = copy;
  }
  return result;
}

/** URL-bearing span attributes across OTel semconv versions. */
const URL_ATTRIBUTE_KEYS = ['http.url', 'http.target', 'url.full', 'url.path', 'http.request.header.referer'] as const;
const REFERER_ATTRIBUTE = 'http.request.header.referer';

/** Redact a span's URL attributes in place. */
export function redactSpanAttributes(attributes: Record<string, unknown> | undefined): void {
  if (!attributes) return;
  let privatePath = false;
  for (const key of URL_ATTRIBUTE_KEYS) {
    const value = attributes[key];
    // A referrer names some other page, so it is redacted but never decides this span's tier.
    if (typeof value === 'string') {
      if (key !== REFERER_ATTRIBUTE && isPrivateHttpPath(value)) privatePath = true;
      attributes[key] = redactHttpUrlForPath(value);
    } else if (Array.isArray(value)) {
      // Header attributes are arrays under the HTTP semantic conventions.
      attributes[key] = value.map((entry) => (typeof entry === 'string' ? redactHttpUrlForPath(entry) : entry));
    }
  }
  const query = attributes['url.query'];
  if (typeof query === 'string') attributes['url.query'] = privatePath ? '[redacted]' : redactQueryString(query);
}

/**
 * Redact on the way out, not through `applyCustomAttributesOnSpan`.
 *
 * `@opentelemetry/instrumentation-http` runs that hook only when a request
 * completes normally; `_onOutgoingRequestError` and `_onServerResponseError`
 * call `setSpanWithError` and close the span directly. A span that ends on an
 * error would otherwise be exported with its raw URL and query. Wrapping the
 * processor covers every span and every instrumentation uniformly.
 */
export function withSpanRedaction<T extends object>(processor: T): T {
  return new Proxy(processor, {
    get(target, property, receiver) {
      if (property === 'onEnd') {
        return (span: { attributes?: Record<string, unknown> }) => {
          redactSpanAttributes(span.attributes);
          (target as { onEnd?: (span: unknown) => void }).onEnd?.(span);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
