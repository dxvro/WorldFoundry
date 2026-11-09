import { stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../http/errors.js';

export type FreeSpaceReader = (dir: string) => Promise<number | null>;

// Free bytes for the volume holding `dir` (or its nearest existing parent); null when the platform cannot tell
export const freeBytes: FreeSpaceReader = async (dir) => {
  let current = path.resolve(dir);
  for (;;) {
    try {
      const info = await statfs(current);
      return Number(info.bavail) * Number(info.bsize);
    } catch (error) {
      const parent = path.dirname(current);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === current) return null;
      current = parent;
    }
  }
};

// Whether two paths (or their nearest existing parents) are on the same volume; null when the platform cannot tell.
// A move inside one volume is a rename, across volumes it is a full copy that needs the free space.
export async function sameVolume(a: string, b: string): Promise<boolean | null> {
  const device = async (target: string): Promise<number | null> => {
    let current = path.resolve(target);
    for (;;) {
      try {
        const { dev } = await stat(current);
        return dev === 0 ? null : dev;
      } catch (error) {
        const parent = path.dirname(current);
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === current) return null;
        current = parent;
      }
    }
  };
  const [first, second] = [await device(a), await device(b)];
  return first === null || second === null ? null : first === second;
}

// How much of its raw size a gzip/deflate archive of a Minecraft world takes. The region files hold zlib-compressed
// chunks already, so archiving saves only 5 to 15 percent; a lower guess made the checks pass for 50 GB worlds that
// then ran out of space half way. Used to size backups, exports and the safety backup of an import.
export const WORLD_COMPRESSION_ESTIMATE = 0.9;

// Sizes from 1 GB on are shown in GB: worlds are tens of GB, and 'about 51,200 MB' is hard to read
export const sizeText = (bytes: number): string =>
  bytes >= 1024 ** 3 ? `${(Math.ceil((bytes / 1024 ** 3) * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 })} GB` : `${Math.ceil(bytes / (1024 * 1024)).toLocaleString('en-US')} MB`;

// What the space is needed for: a stable key for translations (params.purpose of DISK_FULL) and the English phrase
export type DiskPurpose = 'backup' | 'restore' | 'export' | 'upload' | 'world-replace' | 'archive-extract' | 'java';

const PURPOSE_TEXT: Record<DiskPurpose, string> = {
  backup: 'the backup',
  restore: 'the restore',
  export: 'the export',
  upload: 'the upload and unpacking',
  'world-replace': 'replacing the world (including the safety backup)',
  'archive-extract': 'extracting the archive',
  java: 'the Java installation',
};

export async function assertFreeSpace(read: FreeSpaceReader, dir: string, neededBytes: number, purpose: DiskPurpose, java?: number): Promise<void> {
  const free = await read(dir);
  if (free === null || free >= neededBytes) return;
  const needed = Math.ceil(neededBytes / (1024 * 1024));
  const available = Math.ceil(free / (1024 * 1024));
  throw new AppError(
    507,
    'DISK_FULL',
    `Not enough free disk space for ${java === undefined ? PURPOSE_TEXT[purpose] : `Java ${java}`}: about ${sizeText(neededBytes)} needed, ${sizeText(free)} free.`,
    { neededBytes, freeBytes: free },
    { purpose, neededMb: needed, freeMb: available, ...(java === undefined ? {} : { major: java }) },
  );
}
