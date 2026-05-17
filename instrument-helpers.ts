/**
 * Pure helpers shared by `instrument.ts` and `instrument.spec.ts`.
 *
 * Kept in a side-effect-free module so the spec can import directly — the main
 * `instrument.ts` runs Sentry/NodeSDK bootstrap on import and is not safe to
 * load from tests.
 */

/**
 * Span scope matchers that are NOT scope='ai' but still useful for cross-service
 * trace correlation in Langfuse. Opt-in via LANGFUSE_EXPORT_FULL_STACK=true.
 *
 * Coverage:
 * - `@opentelemetry/instrumentation-grpc` — auto-registered by instrument.ts
 *   when the package is installed.
 * - `@opentelemetry/instrumentation-http` — auto-registered by instrument.ts
 *   when `APP_OTEL_HTTP_INSTRUMENTATION_ENABLED=true` and the package is installed.
 * - `prisma` / `@prisma/*` — **NOT auto-registered.** The host app creates these
 *   spans, either via manual `trace.getTracer('prisma')` or by registering
 *   `@opentelemetry/instrumentation-prisma`. The scope string differs between
 *   mechanisms — accept both via prefix match.
 */
export function isFullStackExtraScope(scope: string): boolean {
  return (
    scope === '@opentelemetry/instrumentation-grpc' ||
    scope === '@opentelemetry/instrumentation-http' ||
    scope === 'prisma' ||
    scope.startsWith('@prisma/')
  );
}
