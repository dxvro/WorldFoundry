// "1.21.1" -> [1, 21, 1]; "26.4-snapshot-7" -> [26, 4]; non-numeric -> null
export function parseMcVersion(version: string): number[] | null {
  const match = /^(\d+(?:\.\d+)*)/.exec(version);
  return match === null || match[1] === undefined ? null : match[1].split('.').map(Number);
}

export function compareNumeric(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function compareMcDesc(a: string, b: string): number {
  const left = parseMcVersion(a);
  const right = parseMcVersion(b);
  if (left === null || right === null) return b.localeCompare(a);
  return compareNumeric(right, left) || b.localeCompare(a);
}

// Minecraft switched to year-based versions (26.1, 26.1.2, ...) after 1.21.x
export function isYearBased(version: string): boolean {
  const parts = parseMcVersion(version);
  return parts !== null && (parts[0] ?? 0) >= 26;
}

export function mcAtMost(version: string, ...limit: number[]): boolean {
  const parts = parseMcVersion(version);
  if (parts === null || isYearBased(version)) return false;
  return compareNumeric(parts, limit) <= 0;
}

export const isSnapshotLike = (version: string): boolean => /snapshot|-pre|-rc|^\d+w\d+/i.test(version);
