/**
 * 时区处理工具函数
 *
 * 设计意图：
 * - 统一处理 IANA 和偏移两种时区格式
 * - Temporal 直接支持 IANA 和完整偏移格式
 * - 保持向后兼容性，不破坏现有业务逻辑
 */

import { Oops } from '@app/nest/exceptions/oops';

import '@app/nest/exceptions/oops-factories';

import { Temporal } from '@js-temporal/polyfill';

/**
 * 标准化偏移格式为 Temporal 兼容格式
 *
 * Temporal 只接受完整偏移格式 "+08:00"，不接受 "+8"
 * 此函数将短格式标准化为完整格式
 *
 * @returns 标准化的偏移格式，或 null（无效格式）
 */
function normalizeOffsetFormat(tz: string): string | null {
  const offsetRegex = /^([+-])?(\d{1,2})(?::(\d{2}))?$/;
  const match = tz.match(offsetRegex);
  if (!match) return null;

  const [, signStr, hoursStr, minutesStr] = match as (string | undefined)[];
  if (!hoursStr) return null;

  const sign = signStr ?? '+';
  const hours = parseInt(hoursStr, 10);
  const minutes = minutesStr ? parseInt(minutesStr, 10) : 0;

  // 有效范围：-14:00 到 +14:00
  if (hours > 14 || minutes >= 60) return null;

  // 标准化为 +HH:MM 格式
  return `${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

/**
 * 标准化时区字符串
 *
 * 将多种时区格式标准化为 Temporal 兼容格式：
 * - IANA 格式: "Asia/Tokyo" → "Asia/Tokyo" (原样返回)
 * - 完整偏移: "+08:00" → "+08:00" (原样返回)
 * - 短偏移: "+8" → "+08:00" (标准化)
 * - 特殊名称: "UTC", "GMT" → 原样返回
 */
export function normalizeTimezone(timezone: string | null | undefined): string | null {
  if (!timezone) return null;
  const tz = timezone.trim();
  if (!tz) return null;

  // IANA 格式：包含 "/" 或特殊名称
  if (tz.includes('/')) return tz;
  if (tz === 'UTC' || tz === 'GMT') return tz;

  // 偏移格式：标准化为 +HH:MM
  return normalizeOffsetFormat(tz);
}

export function normalizeTimezoneWithLog(
  timezone: string | null | undefined,
  logger?: { debug: (message: string) => void },
  context?: string,
): string | null {
  const result = normalizeTimezone(timezone);
  if (logger && timezone && result !== timezone) {
    const ctx = context ? `[${context}] ` : '';
    logger.debug(`${ctx}时区格式转换: "${timezone}" -> "${result ?? 'UTC'}"`);
  }
  return result;
}

export function parseTimezoneOffset(timezone: string | null | undefined): number {
  if (!timezone) return 8;
  const tz = timezone.trim();
  const match = tz.match(/^([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return 8;

  const [, signStr, hoursStr, minutesStr] = match;
  if (!signStr || !hoursStr) return 8;

  const sign = signStr === '+' ? 1 : -1;
  const hours = parseInt(hoursStr, 10);
  const minutes = minutesStr ? parseInt(minutesStr, 10) : 0;
  return sign * (hours + minutes / 60);
}

// YMD 相关的逻辑从原 utils.ts 移动过来

const YMD_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

export function formatDateToYmd(date: Temporal.PlainDate | null | undefined): string | null {
  if (!date) return null;
  return date.toString();
}

export function parseYmdToUtcDate(value: string): Temporal.PlainDate {
  const match = YMD_REGEX.exec(value);
  if (!match) throw Oops.Validation('Invalid YMD format', `value="${value}"`);

  const [, yearStr, monthStr, dayStr] = match;
  if (!yearStr || !monthStr || !dayStr)
    throw Oops.Validation('Invalid YMD format', `parsed: y=${yearStr} m=${monthStr} d=${dayStr}`);

  const year = Number.parseInt(yearStr, 10);
  const month = Number.parseInt(monthStr, 10);
  const day = Number.parseInt(dayStr, 10);
  try {
    return Temporal.PlainDate.from({ year, month, day }, { overflow: 'reject' });
  } catch {
    throw Oops.Validation('Invalid YMD calendar date', `value="${value}" resolved=${year}-${month}-${day}`);
  }
}

export function isValidYmdDate(value: string): boolean {
  try {
    parseYmdToUtcDate(value);
    return true;
  } catch {
    return false;
  }
}
