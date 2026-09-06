/** Diagnostic URLs omit query/fragment values and opaque path credentials. */
export function redactHttpUrl(value: string): string {
  return (value.split(/[?#]/, 1)[0] ?? '').replace(/(^|\/)[A-Za-z0-9_-]{32,}(?=\/|$)/g, '$1[redacted]');
}
