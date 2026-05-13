import {
  dateToPlainDate,
  formatDateToYmd,
  isValidYmdDate,
  normalizeTimezone,
  normalizeTimezoneWithLog,
  parseTimezoneOffset,
  parseYmdToUtcDate,
  plainDateToUtcDate,
} from './datetime';

import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, mock } from 'bun:test';

/**
 * 时区规范化工具测试
 *
 * 设计意图：
 * - 验证有效时区格式被保留（IANA 和偏移格式）
 * - 验证无效格式返回 null
 * - Temporal 直接支持 IANA 和完整偏移格式
 */
describe('timezone.helper', () => {
  describe('normalizeTimezone', () => {
    describe('偏移格式：标准化为 +HH:MM（formatInTimeZone 要求）', () => {
      it('应该标准化 "+8" 为 "+08:00"', () => {
        expect(normalizeTimezone('+8')).toBe('+08:00');
      });

      it('应该标准化 "-5" 为 "-05:00"', () => {
        expect(normalizeTimezone('-5')).toBe('-05:00');
      });

      it('应该标准化 "+0" 为 "+00:00"', () => {
        expect(normalizeTimezone('+0')).toBe('+00:00');
      });

      it('应该保留 "+08:00"', () => {
        expect(normalizeTimezone('+08:00')).toBe('+08:00');
      });

      it('应该保留 "-05:00"', () => {
        expect(normalizeTimezone('-05:00')).toBe('-05:00');
      });

      it('应该保留 "+05:30" (印度)', () => {
        expect(normalizeTimezone('+05:30')).toBe('+05:30');
      });

      it('应该保留 "-06:00" (美中)', () => {
        expect(normalizeTimezone('-06:00')).toBe('-06:00');
      });

      it('应该标准化无符号格式 "8" 为 "+08:00"', () => {
        expect(normalizeTimezone('8')).toBe('+08:00');
      });
    });

    describe('IANA 格式：直接返回', () => {
      it('应该保持 "Asia/Shanghai" 不变', () => {
        expect(normalizeTimezone('Asia/Shanghai')).toBe('Asia/Shanghai');
      });

      it('应该保持 "America/New_York" 不变', () => {
        expect(normalizeTimezone('America/New_York')).toBe('America/New_York');
      });

      it('应该保持 "Europe/London" 不变', () => {
        expect(normalizeTimezone('Europe/London')).toBe('Europe/London');
      });

      it('应该保持 "UTC" 不变', () => {
        expect(normalizeTimezone('UTC')).toBe('UTC');
      });

      it('应该保持 "GMT" 不变', () => {
        expect(normalizeTimezone('GMT')).toBe('GMT');
      });
    });

    describe('边界情况', () => {
      it('应该将 null 转换为 null', () => {
        expect(normalizeTimezone(null)).toBe(null);
      });

      it('应该将 undefined 转换为 null', () => {
        expect(normalizeTimezone(undefined)).toBe(null);
      });

      it('应该将空字符串转换为 null', () => {
        expect(normalizeTimezone('')).toBe(null);
      });

      it('应该将空白字符串转换为 null', () => {
        expect(normalizeTimezone('   ')).toBe(null);
      });
    });

    describe('无效格式', () => {
      it('应该将无效格式 "+99:99" 转换为 null', () => {
        expect(normalizeTimezone('+99:99')).toBe(null);
      });

      it('应该将无效格式 "invalid" 转换为 null', () => {
        expect(normalizeTimezone('invalid')).toBe(null);
      });

      it('应该将三位数偏移 "+999" 转换为 null', () => {
        expect(normalizeTimezone('+999')).toBe(null);
      });
    });

    describe('去除前后空格', () => {
      it('应该正确处理带空格的 " +8 "', () => {
        expect(normalizeTimezone(' +8 ')).toBe('+08:00');
      });

      it('应该正确处理带空格的 " Asia/Shanghai "', () => {
        expect(normalizeTimezone(' Asia/Shanghai ')).toBe('Asia/Shanghai');
      });
    });

    describe('normalizeTimezoneWithLog', () => {
      it('偏移格式标准化时触发日志', () => {
        const logger = { debug: mock() };
        const result = normalizeTimezoneWithLog('+8', logger, 'TestCtx');
        expect(result).toBe('+08:00');
        expect(logger.debug).toHaveBeenCalledWith('[TestCtx] 时区格式转换: "+8" -> "+08:00"');
      });

      it('IANA 格式不触发日志（无转换）', () => {
        const logger = { debug: mock() };
        normalizeTimezoneWithLog('Asia/Shanghai', logger);
        expect(logger.debug).not.toHaveBeenCalled();
      });

      it('已标准化偏移格式不触发日志', () => {
        const logger = { debug: mock() };
        const result = normalizeTimezoneWithLog('+08:00', logger);
        expect(result).toBe('+08:00');
        expect(logger.debug).not.toHaveBeenCalled();
      });
    });
  });

  describe('parseTimezoneOffset', () => {
    describe('旧格式解析', () => {
      it('应该正确解析 "+8" 为 8', () => {
        expect(parseTimezoneOffset('+8')).toBe(8);
      });

      it('应该正确解析 "-5" 为 -5', () => {
        expect(parseTimezoneOffset('-5')).toBe(-5);
      });

      it('应该正确解析 "+0" 为 0', () => {
        expect(parseTimezoneOffset('+0')).toBe(0);
      });
    });

    describe('新格式解析', () => {
      it('应该正确解析 "+08:00" 为 8', () => {
        expect(parseTimezoneOffset('+08:00')).toBe(8);
      });

      it('应该正确解析 "-05:00" 为 -5', () => {
        expect(parseTimezoneOffset('-05:00')).toBe(-5);
      });

      it('应该正确解析 "+05:30" 为 5.5', () => {
        expect(parseTimezoneOffset('+05:30')).toBe(5.5);
      });

      it('应该正确解析 "-05:30" 为 -5.5', () => {
        expect(parseTimezoneOffset('-05:30')).toBe(-5.5);
      });
    });

    describe('默认值', () => {
      it('应该将 null 返回默认值 8', () => {
        expect(parseTimezoneOffset(null)).toBe(8);
      });

      it('应该将 undefined 返回默认值 8', () => {
        expect(parseTimezoneOffset(undefined)).toBe(8);
      });

      it('应该将无效格式返回默认值 8', () => {
        expect(parseTimezoneOffset('invalid')).toBe(8);
      });
    });
  });

  describe('YMD Utilities', () => {
    describe('formatDateToYmd', () => {
      it('应该正确格式化 Temporal.PlainDate', () => {
        const date = Temporal.PlainDate.from('2023-12-25');
        expect(formatDateToYmd(date)).toBe('2023-12-25');
      });

      it('null 输入应返回 null', () => {
        expect(formatDateToYmd(null)).toBeNull();
      });
    });

    describe('parseYmdToUtcDate', () => {
      it('应该正确解析有效的 YMD 为 Temporal.PlainDate', () => {
        const date = parseYmdToUtcDate('2023-12-25');
        expect(Temporal.PlainDate.compare(date, Temporal.PlainDate.from('2023-12-25'))).toBe(0);
      });

      it('无效格式应抛出错误', () => {
        expect(() => parseYmdToUtcDate('invalid')).toThrow();
        try {
          parseYmdToUtcDate('invalid');
        } catch (e: unknown) {
          expect((e as { userMessage: string }).userMessage).toBe('Invalid YMD format');
        }
      });

      it('无效日期应抛出错误', () => {
        expect(() => parseYmdToUtcDate('2023-02-30')).toThrow();
        try {
          parseYmdToUtcDate('2023-02-30');
        } catch (e: unknown) {
          expect((e as { userMessage: string }).userMessage).toBe('Invalid YMD calendar date');
        }
      });
    });

    describe('isValidYmdDate', () => {
      it('有效日期返回 true', () => {
        expect(isValidYmdDate('2023-12-25')).toBe(true);
      });

      it('无效日期返回 false', () => {
        expect(isValidYmdDate('2023-02-30')).toBe(false);
        expect(isValidYmdDate('invalid')).toBe(false);
      });
    });

    describe('dateToPlainDate (Date → PlainDate codec)', () => {
      it('UTC midnight Date → 同日 PlainDate', () => {
        const d = new Date(Date.UTC(2024, 3, 18)); // April 18 2024 UTC
        const pd = dateToPlainDate(d);
        expect(pd).not.toBeNull();
        expect(Temporal.PlainDate.compare(pd!, Temporal.PlainDate.from('2024-04-18'))).toBe(0);
      });

      it('用 UTC accessors，本地 tz 不会偏移读出的日期', () => {
        // 2024-04-18T00:00:00Z 在东八区是 2024-04-18T08:00（仍是 4-18 本地）
        // 但故意挑跨日的：2024-04-18T23:30:00Z（UTC 仍是 4-18）→ 应当读成 4-18，不是 4-19
        const d = new Date(Date.UTC(2024, 3, 18, 23, 30));
        const pd = dateToPlainDate(d);
        expect(pd!.toString()).toBe('2024-04-18');
      });

      it('null/undefined → null', () => {
        expect(dateToPlainDate(null)).toBeNull();
        expect(dateToPlainDate(undefined)).toBeNull();
      });
    });

    describe('plainDateToUtcDate (PlainDate → Date codec)', () => {
      it('PlainDate → UTC midnight Date', () => {
        const pd = Temporal.PlainDate.from('2024-04-18');
        const d = plainDateToUtcDate(pd);
        expect(d).not.toBeNull();
        expect(d!.toISOString()).toBe('2024-04-18T00:00:00.000Z');
      });

      it('null/undefined → null', () => {
        expect(plainDateToUtcDate(null)).toBeNull();
        expect(plainDateToUtcDate(undefined)).toBeNull();
      });

      it('roundtrip Date → PlainDate → Date 稳定', () => {
        const original = new Date(Date.UTC(2024, 3, 18));
        const pd = dateToPlainDate(original);
        const back = plainDateToUtcDate(pd);
        expect(back!.getTime()).toBe(original.getTime());
      });
    });
  });
});
