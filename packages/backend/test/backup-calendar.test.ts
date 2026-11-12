import { describe, expect, it } from 'vitest';
import { isTimeZone, lastSlot, localDay, nextSlot, parseCalendar, zonedTime, type BackupCalendar } from '../src/backups/calendar.js';

const day = (text: string): number => Math.round(Date.parse(`${text}T00:00:00Z`) / 86_400_000);
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

describe('backup calendar', () => {
  it('turns a wall-clock time into the right moment, also across daylight saving time', () => {
    expect(iso(zonedTime(day('2026-01-15'), '03:00', 'UTC'))).toBe('2026-01-15T03:00:00.000Z');
    // Berlin: UTC+1 in winter, UTC+2 in summer
    expect(iso(zonedTime(day('2026-01-15'), '03:00', 'Europe/Berlin'))).toBe('2026-01-15T02:00:00.000Z');
    expect(iso(zonedTime(day('2026-07-15'), '03:00', 'Europe/Berlin'))).toBe('2026-07-15T01:00:00.000Z');
    // the day after the switch keeps 03:00 local time
    expect(iso(zonedTime(day('2026-03-30'), '03:00', 'Europe/Berlin'))).toBe('2026-03-30T01:00:00.000Z');
    expect(iso(zonedTime(day('2026-10-26'), '03:00', 'Europe/Berlin'))).toBe('2026-10-26T02:00:00.000Z');
    expect(iso(zonedTime(day('2026-01-15'), '23:30', 'America/New_York'))).toBe('2026-01-16T04:30:00.000Z');
  });

  it('finds the last and the next planned time with several times a day', () => {
    const calendar: BackupCalendar = { times: ['06:00', '12:00', '18:00'], everyDays: 1, timeZone: 'UTC', anchorDay: '2026-05-01' };
    const now = Date.parse('2026-05-10T13:00:00Z');
    expect(iso(lastSlot(calendar, now))).toBe('2026-05-10T12:00:00.000Z');
    expect(iso(nextSlot(calendar, now))).toBe('2026-05-10T18:00:00.000Z');
    expect(iso(nextSlot(calendar, Date.parse('2026-05-10T18:00:00Z')))).toBe('2026-05-11T06:00:00.000Z');
    expect(iso(lastSlot(calendar, Date.parse('2026-05-10T05:59:00Z')))).toBe('2026-05-09T18:00:00.000Z');
  });

  it('runs every n days counted from the anchor day', () => {
    const calendar: BackupCalendar = { times: ['04:30'], everyDays: 3, timeZone: 'UTC', anchorDay: '2026-05-01' };
    expect(iso(nextSlot(calendar, Date.parse('2026-05-01T00:00:00Z')))).toBe('2026-05-01T04:30:00.000Z');
    expect(iso(nextSlot(calendar, Date.parse('2026-05-01T05:00:00Z')))).toBe('2026-05-04T04:30:00.000Z');
    expect(iso(lastSlot(calendar, Date.parse('2026-05-06T12:00:00Z')))).toBe('2026-05-04T04:30:00.000Z');
    expect(iso(nextSlot(calendar, Date.parse('2026-05-06T12:00:00Z')))).toBe('2026-05-07T04:30:00.000Z');
    // days before the anchor follow the same rhythm
    expect(iso(lastSlot(calendar, Date.parse('2026-04-30T12:00:00Z')))).toBe('2026-04-28T04:30:00.000Z');
  });

  it('gives the local day in the time zone', () => {
    expect(localDay(Date.parse('2026-05-01T23:30:00Z'), 'UTC')).toBe('2026-05-01');
    expect(localDay(Date.parse('2026-05-01T23:30:00Z'), 'Europe/Berlin')).toBe('2026-05-02');
  });

  it('validates time zones and stored calendars', () => {
    expect(isTimeZone('Europe/Berlin')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(parseCalendar(null)).toBeNull();
    expect(parseCalendar('not json')).toBeNull();
    expect(parseCalendar(JSON.stringify({ times: ['25:00'], everyDays: 1, timeZone: 'UTC', anchorDay: '2026-05-01' }))).toBeNull();
    expect(parseCalendar(JSON.stringify({ times: ['18:00', '06:00', '06:00'], everyDays: 2, timeZone: 'UTC', anchorDay: '2026-05-01' }))?.times).toEqual(['06:00', '18:00']);
  });
});
