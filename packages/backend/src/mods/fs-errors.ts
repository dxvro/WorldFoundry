import path from 'node:path';
import { AppError } from '../http/errors.js';

const LOCK_CODES: readonly string[] = ['EBUSY', 'EPERM', 'EACCES'];

export interface ModLogger {
  error(object: Record<string, unknown>, message: string): void;
}

export function lockedFileError(error: unknown, fallbackName?: string): AppError | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code, path: errorPath } = error as { code?: unknown; path?: unknown };
  if (typeof code !== 'string' || !LOCK_CODES.includes(code)) return null;
  const name = typeof errorPath === 'string' ? path.basename(errorPath) : (fallbackName ?? 'unknown');
  return new AppError(
    409,
    'FILE_LOCKED',
    `The file "${name}" is in use by another program or is read-only. Please close the program (e.g. the Minecraft server) and try again.`,
    { fileName: name, errno: code },
    { fileName: name },
  );
}

// fs failures that are not lock-related stay untouched
export function rethrowFsError(error: unknown, fallbackName?: string): never {
  throw lockedFileError(error, fallbackName) ?? error;
}
