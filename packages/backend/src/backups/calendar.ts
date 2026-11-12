// Backup schedule at set times of day: "every day at 03:00", "at 06:00, 12:00 and 18:00", "every 3 days at 04:30".
// Times are wall-clock times in an IANA time zone, so a schedule stays at 03:00 across daylight saving changes.
import { z } from 'zod';

export const TIME_OF_DAY = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export const MAX_TIMES_PER_DAY = 24;
export const MAX_EVERY_DAYS = 30;
const DAY_MS = 86_400_000;

export interface BackupCalendar {
  // "HH:MM", sorted, without duplicates
  times: string[];
  // 1 = every day, 2 = every other day, …
  everyDays: number;
  timeZone: string;
  // the first day of the cycle (YYYY-MM-DD in timeZone); with everyDays > 1 backups run on this day and every n-th day after it
  anchorDay: string;
}

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function systemTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof zone === 'string' && isTimeZone(zone) ? zone : 'UTC';
}

export function normalizeTimes(times: readonly string[]): string[] {
  return [...new Set(times)].sort();
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (found === undefined) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    formatters.set(timeZone, found);
  }
  return found;
}

function localParts(ms: number, timeZone: string): Parts {
  const parts: Partial<Record<string, number>> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return { year: parts.year ?? 1970, month: parts.month ?? 1, day: parts.day ?? 1, hour: (parts.hour ?? 0) % 24, minute: parts.minute ?? 0 };
}

// offset of the zone from UTC at that moment, in ms (positive east of Greenwich)
function offsetAt(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(ms / 60_000) * 60_000;
}

// the moment a wall-clock time happens in the zone; a time skipped by a DST change lands just after the gap
export function zonedTime(dayNumber: number, time: string, timeZone: string): number {
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const guess = dayNumber * DAY_MS + hour * 3_600_000 + minute * 60_000;
  const first = guess - offsetAt(guess, timeZone);
  const second = guess - offsetAt(first, timeZone);
  return second;
}

// days since 1970-01-01 of a calendar date
function dayNumberOf(year: number, month: number, day: number): number {
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

export function localDay(ms: number, timeZone: string): string {
  const p = localParts(ms, timeZone);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function parseDay(day: string): number {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return dayNumberOf(year, month, date);
}

// all planned moments on the days around `around`, ascending
function slotsAround(calendar: BackupCalendar, around: number): number[] {
  const today = parseDay(localDay(around, calendar.timeZone));
  const anchor = parseDay(calendar.anchorDay);
  const span = calendar.everyDays + 1;
  const slots: number[] = [];
  for (let day = today - span; day <= today + span; day++) {
    if ((((day - anchor) % calendar.everyDays) + calendar.everyDays) % calendar.everyDays !== 0) continue;
    for (const time of calendar.times) slots.push(zonedTime(day, time, calendar.timeZone));
  }
  return slots.sort((a, b) => a - b);
}

// the newest planned moment at or before `now`, or null when there is none in the window (empty calendar)
export function lastSlot(calendar: BackupCalendar, now: number): number | null {
  let found: number | null = null;
  for (const slot of slotsAround(calendar, now)) if (slot <= now) found = slot;
  return found;
}

// the next planned moment after `now`
export function nextSlot(calendar: BackupCalendar, now: number): number | null {
  for (const slot of slotsAround(calendar, now)) if (slot > now) return slot;
  return null;
}

const CalendarSchema = z.object({
  times: z.array(z.string().regex(TIME_OF_DAY)).min(1).max(MAX_TIMES_PER_DAY),
  everyDays: z.number().int().min(1).max(MAX_EVERY_DAYS),
  timeZone: z.string().refine(isTimeZone),
  anchorDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export function parseCalendar(text: string | null): BackupCalendar | null {
  if (text === null) return null;
  try {
    const parsed = CalendarSchema.safeParse(JSON.parse(text));
    return parsed.success ? { ...parsed.data, times: normalizeTimes(parsed.data.times) } : null;
  } catch {
    return null;
  }
}
