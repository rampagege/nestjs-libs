/** Diagnostic URLs omit query/fragment values and opaque path credentials. */
export function redactHttpUrl(value: string): string {
  return (value.split(/[?#]/, 1)[0] ?? '').replace(/(^|\/)[A-Za-z0-9_-]{32,}(?=\/|$)/g, '$1[redacted]');
}

let privatePaths: readonly string[] = [];
export function configurePrivateHttpPaths(paths: readonly string[]): void {
  privatePaths = [...paths];
}

/** Bootstrap declares paths whose authorization payload must never enter error telemetry. */
export function redactHttpRequestForTelemetry<T extends { url?: string; method?: string; query_string?: unknown }>(
  request: T,
): T | { url?: string; method?: string } {
  let path = '';
  try {
    path = new URL(request.url ?? '', 'https://local.invalid').pathname;
  } catch {
    /* omit malformed URL values below */
  }
  if (privatePaths.some((prefix) => path === prefix || path.startsWith(prefix + '/'))) {
    return { url: redactHttpUrl(request.url ?? ''), method: request.method };
  }
  const result = { ...request };
  if (result.url) result.url = redactHttpUrl(result.url);
  delete result.query_string;
  return result;
}
