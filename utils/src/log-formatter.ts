/**
 * Shared LogTape Formatters
 *
 * Dev:  `2026-03-16 15:00:00.022+09:00 INFO    [spanName|traceId|userId] app·Module: message`
 * Prod: JSON lines for log aggregation (Loki/CloudWatch)
 *
 * Used by NestJS logging (nest/logging/configure.ts).
 */

import { r } from './logging';

import { Temporal } from '@js-temporal/polyfill';

// OTel API 是 peer dep. 用 require + try/catch 避免某些子 monorepo (e.g. nest 工具脚本)
// 不装 @opentelemetry/api 时 import 直接炸. 拿不到就 fallback 到 undefined.
let otelTrace: { getActiveSpan?: () => { spanContext: () => { traceId: string; spanId: string } } | undefined } | null =
  null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  otelTrace = require('@opentelemetry/api').trace ?? null;
} catch {
  otelTrace = null;
}

/**
 * 拿当前 active OTel span 的 traceId. Inject 到 log 行让 trace ↔ log 对账 (Grafana
 * Tempo → Loki 跳转, ssh grep 等). 没有 active span 返回 undefined.
 */
function activeTraceId(): string | undefined {
  if (!otelTrace?.getActiveSpan) return undefined;
  const ctx = otelTrace.getActiveSpan()?.spanContext();
  // OTel "invalid" traceId 是全 0, 跳过避免污染 log
  if (!ctx?.traceId || ctx.traceId === '00000000000000000000000000000000') return undefined;
  return ctx.traceId;
}

// ==================== ANSI Colors ====================

const ansi = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  // Level colors
  trace: '\x1b[2m', // dim
  debug: '\x1b[34m', // blue
  info: '\x1b[32m', // green
  warning: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
  fatal: '\x1b[35m', // magenta
} as const;

// ==================== Helpers ====================

/** `2026-03-16 15:00:00.022+09:00` */
export function formatTimestamp(ts: number): string {
  const d = Temporal.Instant.fromEpochMilliseconds(ts).toZonedDateTimeISO(Temporal.Now.timeZoneId());
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');

  const date = `${d.year.toString().padStart(4, '0')}-${pad2(d.month)}-${pad2(d.day)}`;
  const time = `${pad2(d.hour)}:${pad2(d.minute)}:${pad2(d.second)}.${pad3(d.millisecond)}`;

  return `${date} ${time}${d.offset}`;
}

/** Level label → ANSI colored full uppercase, padded to 7 chars (WARNING is longest) */
function colorLevel(level: string): string {
  const upper = level.toUpperCase().padEnd(7);
  const color = (ansi as Record<string, string>)[level] ?? ansi.info;
  return `${ansi.bold}${color}${upper}${ansi.reset}`;
}

// ==================== LogTape Record Type ====================

export interface LogRecord {
  readonly timestamp: number;
  readonly level: string;
  readonly category: readonly string[];
  readonly message: readonly unknown[];
  readonly rawMessage: string | TemplateStringsArray;
  readonly properties: Record<string, unknown>;
}

// ==================== Dev Formatter ====================

/**
 * Dev formatter — 直接控制布局，无 regex hack
 *
 * `2026-03-16 15:00:00.022+09:00 INFO    [spanName|traceId|userId] unee-mcp·Prisma: message`
 */
export function devFormatter(record: LogRecord): string {
  const timestamp = `${ansi.dim}${formatTimestamp(record.timestamp)}${ansi.reset}`;
  const level = colorLevel(record.level);
  const category = `${ansi.dim}${record.category.join('·')}:${ansi.reset}`;

  // Context tag: [spanName|traceId|userId|...contextTags]
  const contextParts: string[] = [];
  const { traceId, userId, spanName, contextTags } = record.properties;
  if (spanName && typeof spanName === 'string') contextParts.push(spanName);
  const effectiveTraceId = typeof traceId === 'string' && traceId ? traceId : activeTraceId();
  if (effectiveTraceId) contextParts.push(effectiveTraceId);
  if (userId && typeof userId === 'string' && userId.trim().length > 0) contextParts.push(userId);
  // Extra context tags (from NestJS RequestContext non-standard fields)
  if (Array.isArray(contextTags)) {
    for (const tag of contextTags) {
      if (typeof tag === 'string') contextParts.push(tag);
    }
  }
  const contextTag = contextParts.length > 0 ? `${ansi.cyan}[${contextParts.join('|')}]${ansi.reset} ` : '';

  // Message rendering:
  // Tagged template `logger.info\`port ${3700}\`` → rawMessage = ["port ", ""], message = ["port ", 3700, ""]
  // Interpolated values (odd indices) go through r() for type-aware coloring (number=yellow, string=cyan)
  // Static parts (even indices) are plain text — no coloring
  //
  // Special case: `logger.info\`${msg}\`` (NestJS wrapper pattern)
  // → rawMessage = ["", ""], message = ["", msg, ""]
  // Single string interpolation = pre-rendered message, skip value coloring
  const isErrorLevel = record.level === 'error' || record.level === 'fatal';
  const isTaggedTemplate = Array.isArray(record.rawMessage);
  // Detect NestJS wrapper: `logger.info\`${msg}\`` → rawMessage = ['', ''], both parts empty
  // Normal single-interpolation like `logger.info\`│ Bind: ${addr}\`` → rawMessage = ['│ Bind: ', ''], has non-empty static part
  const isSingleStringWrap =
    isTaggedTemplate &&
    Array.isArray(record.rawMessage) &&
    record.rawMessage.length === 2 &&
    (record.rawMessage as readonly string[]).every((s) => s.trim() === '') &&
    typeof record.message[1] === 'string';
  const colorInterpolations = isTaggedTemplate && !isSingleStringWrap;
  const renderPart = (p: unknown, index: number): string => {
    // Static template parts (even indices in tagged template) — no coloring
    if (isTaggedTemplate && index % 2 === 0) {
      return typeof p === 'string' ? p : String(p);
    }
    // Interpolated values with multiple params — type-aware coloring via r()
    if (colorInterpolations) {
      if (p instanceof Error) {
        return isErrorLevel ? r(p) : p.message;
      }
      return r(p);
    }
    // Single-wrap or plain call — no coloring for strings, r() for objects/errors
    if (typeof p === 'string') return p;
    if (p instanceof Error) {
      return isErrorLevel ? r(p) : p.message;
    }
    return r(p);
  };
  const raw = Array.isArray(record.message) ? record.message.map(renderPart).join('') : String(record.message);
  const levelColor = (ansi as Record<string, string>)[record.level] ?? '';
  const message =
    levelColor.length > 0 ? `${levelColor}${raw.replaceAll(ansi.reset, ansi.reset + levelColor)}${ansi.reset}` : raw;

  return `${timestamp} ${level} ${contextTag}${category} ${message}`;
}

// ==================== Prod Formatter ====================

/**
 * Prod formatter — JSON lines for log aggregation (Loki/CloudWatch)
 *
 * 自定义而非 getJsonLinesFormatter，因为 LogTape 的 rendered message 会双重引号。
 */
export function prodFormatter(record: LogRecord): string {
  const message = Array.isArray(record.message)
    ? record.message.map((p) => (typeof p === 'string' ? p : String(p))).join('')
    : String(record.message);

  const entry: Record<string, unknown> = {
    '@timestamp': Temporal.Instant.fromEpochMilliseconds(record.timestamp).toString({ smallestUnit: 'millisecond' }),
    level: record.level.toUpperCase(),
    message,
    logger: record.category.join('.'),
  };

  // Flatten properties (module, traceId, userId, spanName)
  for (const [k, v] of Object.entries(record.properties)) {
    if (v !== undefined && v !== null) entry[k] = v;
  }

  // 若 properties 里没 traceId, 从 OTel active span 自动补. Loki 按 traceId 索引
  // 就能跟 Tempo 联动 (Grafana data source tracesToLogsV2).
  if (!entry.traceId) {
    const tid = activeTraceId();
    if (tid) entry.traceId = tid;
  }

  return JSON.stringify(entry);
}
