// Minimal SemVer 2.0 (without build metadata ordering): enough to decide whether a release is newer.
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
}

const PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSemver(text: string): SemVer | null {
  const match = PATTERN.exec(text.trim());
  if (match === null) return null;
  const numbers = [match[1], match[2], match[3]].map(Number);
  if (numbers.some((value) => !Number.isSafeInteger(value))) return null;
  const prerelease = match[4] === undefined ? [] : match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  if (prerelease.some((part) => typeof part === 'number' && !Number.isSafeInteger(part))) return null;
  return { major: numbers[0] as number, minor: numbers[1] as number, patch: numbers[2] as number, prerelease };
}

export function isPrerelease(version: SemVer): boolean {
  return version.prerelease.length > 0;
}

// -1, 0 or 1. A version without prerelease part is greater than the same version with one.
export function compareSemver(a: SemVer, b: SemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : 1;
    if (typeof left === 'number') return -1;
    if (typeof right === 'number') return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  return a !== null && b !== null && compareSemver(a, b) > 0;
}

// "v1.2.3" -> "1.2.3"; null when the text is no version
export function normalizeVersion(text: string): string | null {
  const parsed = parseSemver(text);
  if (parsed === null) return null;
  const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return parsed.prerelease.length === 0 ? core : `${core}-${parsed.prerelease.join('.')}`;
}
