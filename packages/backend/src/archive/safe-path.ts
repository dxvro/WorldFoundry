import path from 'node:path';
import { AppError } from '../http/errors.js';

const WINDOWS_FORBIDDEN = /[<>:"|?*\u0000-\u001f]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const MAX_ENTRY_PATH = 1024;

// params.reason is a stable key for translations, params.detail the English wording used in the message
const REASON_KEYS: Record<string, string> = {
  'invalid length': 'invalid-length',
  'contains a null character': 'null-character',
  'absolute path': 'absolute-path',
  'refers to a parent directory': 'parent-directory',
  'cannot be saved on Windows': 'windows-unsafe',
  'empty path': 'empty-path',
  'lies outside the target folder': 'outside-target',
  'lies behind a symlink': 'behind-symlink',
  'symlinks are not allowed': 'symlink-not-allowed',
  'symlink points out of the target folder': 'symlink-outside',
  'hardlink does not refer to a known file': 'hardlink-unknown',
};

export const unsafeEntry = (entry: string, reason: string): AppError =>
  new AppError(
    422,
    'ARCHIVE_UNSAFE',
    `The archive contains an invalid entry "${entry.slice(0, 120)}" (${reason}). The operation was cancelled.`,
    undefined,
    { entry: entry.slice(0, 120), reason: REASON_KEYS[reason] ?? 'entry-type', detail: reason },
  );

// Splits an archive entry name into plain path segments. Anything that could leave the target folder
// (absolute paths, drive letters, "..", NUL bytes, characters Windows cannot store) is rejected.
export function entrySegments(name: string, platform: NodeJS.Platform = process.platform): string[] {
  if (name.length === 0 || name.length > MAX_ENTRY_PATH) throw unsafeEntry(name, 'invalid length');
  if (name.includes('\u0000')) throw unsafeEntry(name, 'contains a null character');
  const normalized = name.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw unsafeEntry(name, 'absolute path');
  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') throw unsafeEntry(name, 'refers to a parent directory');
    if (platform === 'win32') {
      if (WINDOWS_FORBIDDEN.test(segment) || WINDOWS_RESERVED.test(segment) || /[ .]$/.test(segment)) {
        throw unsafeEntry(name, 'cannot be saved on Windows');
      }
    }
    segments.push(segment);
  }
  if (segments.length === 0) throw unsafeEntry(name, 'empty path');
  return segments;
}

// "./" and similar spellings of the archive root itself, which tar emits as the first entry
export const isRootEntry = (name: string): boolean => name.replaceAll('\\', '/').split('/').every((part) => part === '' || part === '.');

export interface EntryTarget {
  segments: string[];
  target: string;
}

export function resolveEntry(root: string, name: string, platform: NodeJS.Platform = process.platform): EntryTarget {
  const segments = entrySegments(name, platform);
  const base = path.resolve(root);
  const target = path.resolve(base, ...segments);
  if (target !== base && !target.startsWith(base + path.sep)) throw unsafeEntry(name, 'lies outside the target folder');
  return { segments, target };
}

// A symlink may only point at a path below the extraction root. ".." is only accepted as a prefix
// ("../x"), never after a normal segment, because "a/../x" would resolve differently if "a" is a link.
export function symlinkTargetInside(entrySegmentsOfLink: readonly string[], linkname: string): boolean {
  if (linkname === '' || linkname.includes('\u0000')) return false;
  const normalized = linkname.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return false;
  const parts = normalized.split('/').filter((part) => part !== '' && part !== '.');
  let depth = entrySegmentsOfLink.length - 1;
  let seenName = false;
  for (const part of parts) {
    if (part === '..') {
      if (seenName) return false;
      depth--;
      if (depth < 0) return false;
    } else {
      seenName = true;
      depth++;
    }
  }
  return true;
}
