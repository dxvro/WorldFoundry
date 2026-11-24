// Memory typed by hand: the backend stores whole megabytes; KB and GB are converted (1 GB = 1024 MB = 1048576 KB).
export const MEMORY_UNITS = ['KB', 'MB', 'GB'] as const;
export type MemoryUnit = (typeof MEMORY_UNITS)[number];

const PER_MB: Record<MemoryUnit, number> = { KB: 1 / 1024, MB: 1, GB: 1024 };

// the unit a value reads best in: whole gigabytes as GB, everything else as MB
export const unitFor = (mb: number): MemoryUnit => (mb >= 1024 && mb % 1024 === 0 ? 'GB' : 'MB');

// the number shown in the field, without grouping so it can be edited (up to three decimals for GB)
export function memoryText(mb: number, unit: MemoryUnit): string {
  const value = mb / PER_MB[unit];
  return String(Math.round(value * 1000) / 1000);
}

// The typed text as megabytes, or null when it is not a positive number. A comma is read as a decimal point.
export function parseMemory(text: string, unit: MemoryUnit): number | null {
  const normalized = text.trim().replace(/\s+/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const mb = Math.round(Number(normalized) * PER_MB[unit]);
  return Number.isFinite(mb) && mb > 0 ? mb : null;
}
