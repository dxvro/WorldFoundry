import { createHash } from 'node:crypto';

// 32 hex digits -> 8-4-4-4-12
export function dashUuid(hex: string): string {
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Same as java.util.UUID.nameUUIDFromBytes("OfflinePlayer:<name>"), which servers with online-mode=false use
export function offlineUuid(name: string): string {
  const bytes = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x30;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return dashUuid(bytes.toString('hex'));
}

// "yyyy-MM-dd HH:mm:ss Z" in local time, the format of the ban lists
export function formatBanDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}
