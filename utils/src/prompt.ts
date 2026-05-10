import { normalizeTimezone } from './datetime';

import { Temporal } from '@js-temporal/polyfill';
import dedent from 'dedent';
import { z } from 'zod';

export function generateJsonFormat(schema: z.ZodType, indent = 0): string {
  const definition = Reflect.get(schema, '_def');
  const serialized = JSON.stringify(definition, (_key, value) => (typeof value === 'function' ? undefined : value), 2);
  const indentPrefix = ' '.repeat(indent);
  return serialized
    .split('\n')
    .map((line) => `${indentPrefix}${line}`)
    .join('\n');
}

/**
 * Temporal formatting patterns（不含 dayPeriod 和时区，由 formatLocalDateTime 拼接）。
 *
 * dayPeriod 通过 Intl toLocaleString({ dayPeriod: 'long' }) 获取（"in the morning" 等）。
 */
export enum TimeSensitivity {
  Day = 'yyyy-MM-dd EEEE',
  Hour = 'yyyy-MM-dd EEEE hh a',
  Minute = 'yyyy-MM-dd EEEE HH:mm',
}

type PromptDateTime = string | Temporal.Instant | Temporal.ZonedDateTime;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/**
 * 将 ISO datetime 字符串或 Temporal 时间格式化为带时区和 dayPeriod 的可读时间。
 *
 * 输出示例：`2026-03-21 Saturday 04:20 in the morning (Asia/Tokyo)`
 *
 * 默认使用 process.env.TZ 作为时区。
 * 用于 prompt 中展示时间给 LLM，避免 UTC 导致的时间误判。
 */
function toTemporalZdt(dateOrIso?: PromptDateTime | null, timezone?: string | null): Temporal.ZonedDateTime {
  const raw = timezone ?? process.env.TZ;
  const tz = normalizeTimezone(raw) ?? Temporal.Now.timeZoneId();

  if (!dateOrIso) return Temporal.Now.instant().toZonedDateTimeISO(tz);
  if (dateOrIso instanceof Temporal.ZonedDateTime) return dateOrIso.withTimeZone(tz);

  const instant = typeof dateOrIso === 'string' ? Temporal.Instant.from(dateOrIso) : dateOrIso;
  return instant.toZonedDateTimeISO(tz);
}

function formatZoneName(zdt: Temporal.ZonedDateTime): string {
  const tz = zdt.timeZoneId;
  const offset = /^([+-])(\d{2}):(\d{2})$/.exec(tz);
  if (!offset) return tz;

  const [, sign, hour, minute] = offset;
  const hourText = String(Number(hour));
  const minuteText = minute === '00' ? '' : `:${minute}`;
  return `UTC${sign}${hourText}${minuteText}`;
}

function formatTemporal(zdt: Temporal.ZonedDateTime, sensitivity: TimeSensitivity): string {
  const date = `${zdt.year.toString().padStart(4, '0')}-${zdt.month.toString().padStart(2, '0')}-${zdt.day.toString().padStart(2, '0')}`;
  const weekday = WEEKDAYS[zdt.dayOfWeek - 1];
  const hour24 = zdt.hour.toString().padStart(2, '0');
  const minute = zdt.minute.toString().padStart(2, '0');

  if (sensitivity === TimeSensitivity.Day) return `${date} ${weekday}`;
  if (sensitivity === TimeSensitivity.Hour) {
    const hour12 = (zdt.hour % 12 || 12).toString().padStart(2, '0');
    const period = zdt.hour < 12 ? 'AM' : 'PM';
    return `${date} ${weekday} ${hour12} ${period}`;
  }
  return `${date} ${weekday} ${hour24}:${minute}`;
}

function formatDayPeriod(zdt: Temporal.ZonedDateTime): string {
  if (zdt.hour < 12) return 'in the morning';
  if (zdt.hour === 12 && zdt.minute === 0 && zdt.second === 0 && zdt.millisecond === 0) return 'noon';
  if (zdt.hour < 18) return 'in the afternoon';
  if (zdt.hour < 21) return 'in the evening';
  return 'at night';
}

/**
 * 完整时间：`2026-03-21 Saturday 04:20 in the morning (Asia/Tokyo)`
 *
 * 用于 prompt 的 `Now:` 行、时间提取基准等需要完整时间+时区的场景。
 */
export function formatLocalDateTime(
  dateOrIso?: PromptDateTime | null,
  sensitivity: TimeSensitivity = TimeSensitivity.Minute,
  timezone?: string | null,
): string {
  const dt = toTemporalZdt(dateOrIso, timezone);
  const main = formatTemporal(dt, sensitivity);
  const dayPeriod = formatDayPeriod(dt);
  const zone = formatZoneName(dt);
  return `${main} ${dayPeriod} (${zone})`;
}

/**
 * 本地日期：`2026-03-21`
 *
 * 替代 `toISOString().slice(0, 10)` — 避免 UTC 日期边界错位。
 * 用于只需日期精度的场景（任务截止、存储条目、curriculum 执行时间等）。
 */
export function formatLocalDate(dateOrIso: PromptDateTime, timezone?: string | null): string {
  return toTemporalZdt(dateOrIso, timezone).toPlainDate().toString();
}

/**
 * 本地短时间：`03-21 07:30`
 *
 * 替代 `isoString.slice(5, 16)` — 避免 UTC 时间错位。
 * 用于行为时间线等需要月日时分但不需年份的场景。
 */
export function formatLocalShortTime(dateOrIso: PromptDateTime, timezone?: string | null): string {
  const dt = toTemporalZdt(dateOrIso, timezone);
  return `${dt.month.toString().padStart(2, '0')}-${dt.day.toString().padStart(2, '0')} ${dt.hour.toString().padStart(2, '0')}:${dt.minute.toString().padStart(2, '0')}`;
}

// 生成要求 (Requirements/Instructions)
const RequirementsSchema = z.union([z.string(), z.array(z.string())]);

// 注意事项 (Special Considerations)
const SpecialConsiderationsSchema = z.union([z.string(), z.array(z.string())]).optional();

// 完整的通用 prompt schema
const PromptSchema = z.object({
  purpose: z.string(),
  background: z.string().optional(),
  context: z
    .array(
      z.object({
        title: z.string(),
        content: z.union([z.string(), z.number()]).optional(),
      }),
    )
    .optional(),
  requirements: RequirementsSchema.optional(),
  instructions: z.string().optional(),
  specialConsiderations: SpecialConsiderationsSchema.optional(),
  examples: z.union([z.string(), z.array(z.string())]).optional(),
  output: z.string().optional(),
});
type PromptSchema = z.infer<typeof PromptSchema>;

/** 将 string | string[] 渲染为列表或纯文本 */
function renderList(items: string | string[]): string {
  return Array.isArray(items) ? items.map((item) => `- ${item}`).join('\n') : items;
}

export function createBasePrompt(
  id: string,
  timezone: string | undefined | null,
  sensitivity: TimeSensitivity = TimeSensitivity.Minute,
  content: string,
  output?: string,
) {
  const now = formatLocalDateTime(undefined, sensitivity, timezone);
  return [`[${id}]`, '------', content, '------', `Now:${now}`, 'Output:', output].filter(Boolean).join('\n');
}

export function createPrompt(
  id: string,
  timezone: string | undefined | null,
  sensitivity: TimeSensitivity = TimeSensitivity.Minute,
  data: PromptSchema,
) {
  const content = [
    dedent`
      ## Objective / Purpose
      ${data.purpose}
    `,

    data.background &&
      dedent`
        ## Background Information
        ${data.background}
      `,

    (data.instructions || data.requirements) &&
      ['## Requirements / Instructions', data.instructions, data.requirements && renderList(data.requirements)]
        .filter(Boolean)
        .join('\n'),

    data.specialConsiderations &&
      dedent`
        ## Special Considerations
        ${renderList(data.specialConsiderations)}
      `,

    data.examples &&
      dedent`
        ## Examples
        ${renderList(data.examples)}
      `,

    data.context?.length &&
      [
        '## Context',
        ...data.context.map(
          (ctx) => dedent`
            <${ctx.title}>
            ${ctx.content ?? '<empty />'}
            </${ctx.title}>
          `,
        ),
      ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');

  return createBasePrompt(id, timezone, sensitivity, content, data.output);
}

export function createEnhancedPrompt<Response>({
  id,
  version,
  timezone,
  sensitivity,
  data,
  logicErrorContext,
}: {
  id: string;
  version: string;
  timezone?: string;
  sensitivity: TimeSensitivity;
  data: PromptSchema;
  logicErrorContext?: {
    condition?: (response: Response) => boolean;
    background?: string;
    output?: string;
    additionals?: { title: string; content: string }[];
  };
}) {
  const prompt = createPrompt(`${id}-${version}`, timezone ?? process.env.TZ, sensitivity, data);
  const logicErrorPromptCreator = logicErrorContext
    ? (response: Response) => {
        if (logicErrorContext.condition && !logicErrorContext.condition(response)) return null;

        return createPrompt(`LogicFixer-${id}`, timezone, sensitivity, {
          purpose: '你是逻辑问题修复专家。请基于提供的背景信息，修复输入内容中的逻辑错误。',
          background: logicErrorContext.background,
          context: [...(logicErrorContext.additionals ?? []), { title: 'Input', content: JSON.stringify(response) }],
          requirements: [
            dedent`
              - 识别并修复输入内容中的逻辑错误
              - 确保修复后的输入内容逻辑正确且高效
              - 提供详细的修复说明，解释修复的原因和方法
            `,
          ],
          specialConsiderations: ['请确保修复后的输入内容逻辑清晰易懂。', '尽量少修改，只修改有问题的部分。'],
          output: logicErrorContext.output,
        });
      }
    : undefined;

  return { prompt, logicErrorPromptCreator, id, version };
}

export const customJsonFormatSupportOutput = (
  schema: z.ZodType,
  {
    injectJsonFormat,
    output,
  }: {
    injectJsonFormat?: boolean;
    output?: string;
  },
) =>
  [
    '严格输出符合 Schema 定义的 JSON 格式。枚举原样使用定义中的类型，不要翻译，不要输出任何其他内容，包括注释、解释、提示等。直接从 { 开始，到 } 结束, 不要输出任何其他内容。',
    injectJsonFormat
      ? `--- RESPONSE TypeScript Schema JSON FORMAT---\n${generateJsonFormat(schema)}\n--- END OF RESPONSE TYPE-SCRIPT SCHEMA JSON FORMAT ---`
      : '',
    output,
  ]
    .filter(Boolean)
    .join('\n');
