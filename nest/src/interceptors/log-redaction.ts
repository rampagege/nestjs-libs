import { createHmac, randomBytes } from 'node:crypto';

export type FingerprintScope = 'hmac-v1' | 'ephemeral-v1' | 'unavailable';

export type LogSafeSecret =
  | {
      present: false;
      reason: 'missing';
    }
  | {
      present: true;
      kind: 'jwt' | 'api_key' | 'cookie_value' | 'opaque' | 'unknown';
      length: number;
      fingerprint?: string;
      fingerprintScope: FingerprintScope;
      formatStatus: 'ok' | 'malformed' | 'unsupported' | 'empty';
      formatError?: string;
    };

export type LogSafeAuthorization = {
  present: boolean;
  scheme?: string;
  credential?: LogSafeSecret;
};

export type LogSafeCookieHeader = {
  present: boolean;
  names: string[];
  values: Record<string, LogSafeSecret>;
  malformedPairs: number;
};

export type LogSafePayloadValue =
  | string
  | number
  | boolean
  | null
  | {
      redacted: true;
      kind:
        | 'secret'
        | 'long_string'
        | 'object_depth'
        | 'large_array'
        | 'circular_reference'
        | 'unsupported_value'
        | 'binary';
      length?: number;
      byteLength?: number;
      valueType?: string;
      fingerprint?: string;
      fingerprintScope?: FingerprintScope;
      reason: string;
    }
  | LogSafePayloadValue[]
  | { [key: string]: LogSafePayloadValue };

type SecretKind = 'jwt' | 'api_key' | 'cookie_value' | 'opaque' | 'unknown';

const DEFAULT_MAX_STRING_LENGTH = 200;
const DEFAULT_MAX_ARRAY_LENGTH = 5;
const DEFAULT_MAX_DEPTH = 4;
const FINGERPRINT_HEX_LENGTH = 12;
const EPHEMERAL_REDACTION_KEY = randomBytes(32).toString('hex');

const SENSITIVE_PAYLOAD_KEY_PATTERN =
  /^(authorization|cookie|set-cookie|password|passcode|token|secret|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|fromAddress|subject|snippet|bodyText)$/i;
const SENSITIVE_HEADER_KEY_PATTERN =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-service-token|x-access-token|x-refresh-token|x-csrf-token)$/i;

function redactionKey(): { key: string; scope: Exclude<FingerprintScope, 'unavailable'> } {
  const configured = process.env.LOG_REDACTION_KEY;
  if (configured?.trim()) {
    return { key: configured, scope: 'hmac-v1' };
  }
  return { key: EPHEMERAL_REDACTION_KEY, scope: 'ephemeral-v1' };
}

function fingerprint(value: string): {
  fingerprint: string;
  fingerprintScope: Exclude<FingerprintScope, 'unavailable'>;
} {
  const { key, scope } = redactionKey();
  const digest = createHmac('sha256', key).update(value).digest('hex').slice(0, FINGERPRINT_HEX_LENGTH);
  return {
    fingerprint: `${scope === 'hmac-v1' ? 'hmac:v1' : 'ephemeral:v1'}:${digest}`,
    fingerprintScope: scope,
  };
}

function emptySecret(kind: SecretKind): LogSafeSecret {
  return { present: true, kind, length: 0, fingerprintScope: 'unavailable', formatStatus: 'empty' };
}

function unsupportedSecret(kind: SecretKind, formatError: string, length = 0): LogSafeSecret {
  return { present: true, kind, length, fingerprintScope: 'unavailable', formatStatus: 'unsupported', formatError };
}

function unsupportedSecretValue(value: string, kind: SecretKind, formatError: string): LogSafeSecret {
  return {
    present: true,
    kind,
    length: value.length,
    ...fingerprint(value),
    formatStatus: 'unsupported',
    formatError,
  };
}

function malformedSecret(value: string, kind: SecretKind, formatError: string): LogSafeSecret {
  return {
    present: true,
    kind,
    length: value.length,
    ...fingerprint(value),
    formatStatus: 'malformed',
    formatError,
  };
}

function safeSecret(value: string, kind: SecretKind): LogSafeSecret {
  if (value.length === 0) {
    return emptySecret(kind);
  }
  return {
    present: true,
    kind,
    length: value.length,
    ...fingerprint(value),
    formatStatus: 'ok',
  };
}

function firstHeaderString(value: unknown, kind: SecretKind): string | LogSafeSecret {
  if (value === undefined || value === null) {
    return { present: false, reason: 'missing' };
  }
  if (Array.isArray(value)) {
    return unsupportedSecret(kind, 'multi_value_header', value.length);
  }
  if (typeof value !== 'string') {
    return unsupportedSecret(kind, 'non_string_header');
  }
  return value;
}

function parseBase64UrlJson(segment: string): unknown {
  const padded = segment.padEnd(segment.length + ((4 - (segment.length % 4)) % 4), '=');
  const text = Buffer.from(padded, 'base64url').toString('utf8');
  return JSON.parse(text);
}

function classifyBearerCredential(credential: string): LogSafeSecret {
  if (!credential) {
    return emptySecret('unknown');
  }

  if (credential.includes('.')) {
    const segments = credential.split('.');
    if (segments.length !== 3) {
      return malformedSecret(credential, 'jwt', 'jwt_wrong_segment_count');
    }
    try {
      parseBase64UrlJson(segments[0] ?? '');
    } catch {
      return malformedSecret(credential, 'jwt', 'jwt_header_not_json');
    }
    try {
      parseBase64UrlJson(segments[1] ?? '');
    } catch {
      return malformedSecret(credential, 'jwt', 'jwt_payload_not_json');
    }
    return safeSecret(credential, 'jwt');
  }

  return safeSecret(credential, credential.startsWith('sk-') ? 'api_key' : 'opaque');
}

export function normalizeAuthorizationHeader(value: unknown): LogSafeAuthorization {
  const raw = firstHeaderString(value, 'unknown');
  if (typeof raw !== 'string') {
    return { present: raw.present, credential: raw.present ? raw : undefined };
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return { present: true, credential: emptySecret('unknown') };
  }

  const match = /^(\S+)\s+(.+)$/.exec(trimmed);
  if (!match) {
    return {
      present: true,
      credential: malformedSecret(trimmed, 'unknown', 'missing_authorization_scheme'),
    };
  }

  const scheme = match[1] ?? '';
  const credential = (match[2] ?? '').trim();
  if (!credential) {
    return {
      present: true,
      scheme,
      credential: malformedSecret(trimmed, 'unknown', 'empty_authorization_credential'),
    };
  }

  if (scheme.toLowerCase() !== 'bearer') {
    return {
      present: true,
      scheme,
      credential: unsupportedSecretValue(credential, 'opaque', 'unsupported_authorization_scheme'),
    };
  }

  return { present: true, scheme, credential: classifyBearerCredential(credential) };
}

export function normalizeCookieHeader(value: unknown): LogSafeCookieHeader {
  const raw = firstHeaderString(value, 'cookie_value');
  if (typeof raw !== 'string') {
    return { present: raw.present, names: [], values: {}, malformedPairs: raw.present ? 1 : 0 };
  }

  if (!raw.trim()) {
    return { present: true, names: [], values: {}, malformedPairs: 0 };
  }

  const values: Record<string, LogSafeSecret> = {};
  const names: string[] = [];
  let malformedPairs = 0;

  for (const pair of raw.split(';')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) {
      malformedPairs += 1;
      continue;
    }
    const name = trimmed.slice(0, idx).trim();
    const cookieValue = trimmed.slice(idx + 1);
    if (!name) {
      malformedPairs += 1;
      continue;
    }
    names.push(name);
    values[name] = safeSecret(cookieValue, 'cookie_value');
  }

  return { present: true, names, values, malformedPairs };
}

function normalizeHeaderSecret(value: unknown, kind: 'api_key' | 'cookie_value' | 'opaque' | 'unknown'): LogSafeSecret {
  const raw = firstHeaderString(value, kind);
  if (typeof raw !== 'string') return raw;
  return safeSecret(raw.trim(), kind);
}

function secretKindForHeader(key: string): 'api_key' | 'cookie_value' | 'opaque' | 'unknown' {
  const lower = key.toLowerCase();
  if (lower.includes('api-key') || lower.includes('apikey')) return 'api_key';
  if (lower.includes('cookie')) return 'cookie_value';
  if (lower.includes('token') || lower.includes('secret')) return 'opaque';
  return 'unknown';
}

export function normalizeHeadersForLog(headers: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!headers) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'authorization' || lower === 'proxy-authorization') {
      out[key] = normalizeAuthorizationHeader(value);
    } else if (lower === 'cookie') {
      out[key] = normalizeCookieHeader(value);
    } else if (SENSITIVE_HEADER_KEY_PATTERN.test(lower)) {
      out[key] = normalizeHeaderSecret(value, secretKindForHeader(lower));
    } else {
      out[key] = value;
    }
  }
  return out;
}

function redactedPayload(
  kind: Extract<LogSafePayloadValue, { redacted: true }>['kind'],
  reason: string,
  value?: string,
  length?: number,
): Extract<LogSafePayloadValue, { redacted: true }> {
  return {
    redacted: true,
    kind,
    reason,
    ...(length !== undefined ? { length } : {}),
    ...(value !== undefined ? fingerprint(value) : {}),
  };
}

function binaryPayload(input: ArrayBuffer | ArrayBufferView): Extract<LogSafePayloadValue, { redacted: true }> {
  return {
    redacted: true,
    kind: 'binary',
    reason: 'binary_payload',
    byteLength: input.byteLength,
    valueType: input.constructor.name || 'Binary',
  };
}

function isSensitivePayloadKey(key: string): boolean {
  return SENSITIVE_PAYLOAD_KEY_PATTERN.test(key);
}

export function normalizePayloadForLog(
  value: unknown,
  options: { maxStringLength?: number; maxArrayLength?: number; maxDepth?: number } = {},
): LogSafePayloadValue {
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
  const maxArrayLength = options.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const seen = new WeakSet<object>();

  function visit(input: unknown, depth: number, key?: string): LogSafePayloadValue {
    if (input === null || typeof input === 'number' || typeof input === 'boolean') return input;
    if (typeof input === 'string') {
      if (key && isSensitivePayloadKey(key)) {
        return redactedPayload('secret', 'sensitive_field', input, input.length);
      }
      if (input.length > maxStringLength) {
        return redactedPayload('long_string', 'log_budget_exceeded', input, input.length);
      }
      return input;
    }
    if (input === undefined) {
      return redactedPayload('unsupported_value', 'undefined_value');
    }
    if (typeof input === 'bigint' || typeof input === 'symbol' || typeof input === 'function') {
      return redactedPayload('unsupported_value', typeof input);
    }
    if (typeof input !== 'object') {
      return redactedPayload('unsupported_value', typeof input);
    }
    if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
      return binaryPayload(input);
    }
    if (seen.has(input)) {
      return redactedPayload('circular_reference', 'circular_reference');
    }
    if (depth >= maxDepth) {
      return redactedPayload('object_depth', 'max_depth_exceeded');
    }
    seen.add(input);
    if (Array.isArray(input)) {
      if (input.length > maxArrayLength) {
        return redactedPayload('large_array', 'large_array', undefined, input.length);
      }
      return input.map((item) => visit(item, depth + 1));
    }
    const result: Record<string, LogSafePayloadValue> = {};
    for (const [childKey, childValue] of Object.entries(input as Record<string, unknown>)) {
      result[childKey] = visit(childValue, depth + 1, childKey);
    }
    return result;
  }

  return visit(value, 0);
}
