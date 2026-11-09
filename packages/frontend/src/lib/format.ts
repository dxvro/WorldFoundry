import { getCurrentDictionary, getCurrentLocale } from '../i18n/current';

// Locale handling: I18nProvider mirrors the active language into i18n/current.ts, and every helper reads it per call,
// so call sites stay `formatInt(n)`. A component that formats should also call useI18n() to re-render on a language change.
const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(maximumFractionDigits: number): Intl.NumberFormat {
  const locale = getCurrentLocale();
  const key = `${locale}:${maximumFractionDigits}`;
  let format = numberFormats.get(key);
  if (format === undefined) {
    format = new Intl.NumberFormat(locale, { maximumFractionDigits });
    numberFormats.set(key, format);
  }
  return format;
}

const decimal = (value: number): string => numberFormat(1).format(value);

export const formatInt = (value: number): string => numberFormat(0).format(value);

export function formatMb(mb: number): string {
  return mb >= 1024 ? `${decimal(mb / 1024)} GB` : `${formatInt(mb)} MB`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${decimal(bytes / 1024 ** 3)} GB`;
  if (bytes >= 1024 ** 2) return `${decimal(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${decimal(bytes / 1024)} KB`;
  return `${formatInt(bytes)} B`;
}

export function formatCompact(value: number): string {
  const { units } = getCurrentDictionary().common;
  if (value >= 1_000_000) return `${decimal(value / 1_000_000)} ${units.million}`;
  if (value >= 1_000) return `${decimal(value / 1_000)} ${units.thousand}`;
  return formatInt(value);
}

export function formatPercent(value: number | null): string {
  return value === null ? '–' : `${decimal(value)} %`;
}

export function formatDuration(ms: number): string {
  const { units } = getCurrentDictionary().common;
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return units.underOneMinute;
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} ${units.day} ${hours} ${units.hour}`;
  if (hours > 0) return `${hours} ${units.hour} ${minutes} ${units.minute}`;
  return `${minutes} ${units.minute}`;
}

export function formatDateTime(value: string | number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '–';
  return date.toLocaleString(getCurrentLocale(), { dateStyle: 'short', timeStyle: 'medium' });
}

export function formatClock(value: number): string {
  return new Date(value).toLocaleTimeString(getCurrentLocale(), { hour12: false });
}

// `one` / `many` are already-translated words supplied by the caller
export const plural = (count: number, one: string, many: string): string => `${formatInt(count)} ${count === 1 ? one : many}`;
