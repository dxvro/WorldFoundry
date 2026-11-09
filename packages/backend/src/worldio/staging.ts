import { open, stat } from 'node:fs/promises';
import { readDirectory } from '../archive/zip.js';
import { extractTarGz, type ExtractReport } from '../archive/tar.js';
import { extractZip } from '../archive/zip.js';
import { AppError } from '../http/errors.js';
import { assertFreeSpace, sizeText, type FreeSpaceReader } from '../lib/disk.js';

export type ArchiveFormat = 'zip' | 'tar.gz';

export interface StageLimits {
  // total bytes after unpacking
  maxBytes: number;
  maxEntries: number;
  // unpacked size divided by archive size; checked once the output is large enough to matter
  maxRatio: number;
}

const MIB = 1024 * 1024;
const RATIO_FLOOR_BYTES = 1024 * MIB;

export async function sniffFormat(file: string): Promise<ArchiveFormat> {
  const handle = await open(file, 'r');
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, 4, 0);
    if (bytesRead >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'tar.gz';
    if (bytesRead >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5)) return 'zip';
  } finally {
    await handle.close();
  }
  throw new AppError(
    422,
    'IMPORT_FORMAT_UNSUPPORTED',
    'The archive has an unsupported format. Supported are .zip and .tar.gz (.tgz). For .rar or .7z, please repack as .zip first.',
  );
}

// ISIZE, the last four bytes of a gzip file: the unpacked size modulo 2^32 (a lower bound for bigger files)
async function gzipTrailerSize(file: string): Promise<number> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 4) return 0;
    const tail = Buffer.alloc(4);
    await handle.read(tail, 0, 4, size - 4);
    return tail.readUInt32LE(0);
  } finally {
    await handle.close();
  }
}

const bombError = (): AppError =>
  new AppError(
    422,
    'ARCHIVE_BOMB',
    'The archive is disproportionately large once extracted compared to its file size and is rejected for security reasons.',
  );

export interface StageReport extends ExtractReport {
  format: ArchiveFormat;
  archiveBytes: number;
}

// Unpacks an uploaded archive into `dest` with the safety checks of the archive readers (no paths outside the
// folder, no symlinks, entry and size limits) plus a free-space check and a ratio check against zip bombs.
export async function stageArchive(
  archive: string,
  dest: string,
  limits: StageLimits,
  freeSpace: FreeSpaceReader,
  checkpoint: () => void,
): Promise<StageReport> {
  const format = await sniffFormat(archive);
  const archiveBytes = (await stat(archive)).size;
  const tooLarge = (): AppError =>
    new AppError(422, 'ARCHIVE_TOO_LARGE', `The archive is larger than allowed once extracted (at most ${sizeText(limits.maxBytes)}).`, undefined, { maxMb: Math.floor(limits.maxBytes / MIB) });
  const ratioCheck = (bytes: number): void => {
    if (bytes > RATIO_FLOOR_BYTES && bytes / Math.max(1, archiveBytes) > limits.maxRatio) throw bombError();
  };
  const options = {
    maxBytes: limits.maxBytes,
    maxEntries: limits.maxEntries,
    checkpoint,
    onProgress: ratioCheck,
  };
  try {
    if (format === 'zip') {
      // the central directory states every size up front, so a bomb is rejected before anything is written
      let declared = 0;
      const entries = await readDirectory(archive);
      if (entries.length > limits.maxEntries) throw new AppError(422, 'ARCHIVE_TOO_LARGE', 'The archive contains too many entries.');
      for (const entry of entries) declared += entry.size;
      if (declared > limits.maxBytes) throw tooLarge();
      ratioCheck(declared);
      await assertFreeSpace(freeSpace, dest, declared + 128 * MIB, 'archive-extract');
      const report = await extractZip(archive, dest, options);
      return { ...report, format, archiveBytes };
    }
    // The sizes inside a tar.gz are unknown before reading it all. World archives hold hardly compressible region
    // files, so about the archive size again is expected; twice that (or the size the gzip trailer admits, which is
    // exact below 4 GiB) is checked up front. If it is more, the write still ends in DISK_FULL instead of a crash.
    await assertFreeSpace(freeSpace, dest, Math.max(archiveBytes * 2, await gzipTrailerSize(archive)) + 128 * MIB, 'archive-extract');
    const report = await extractTarGz(archive, dest, options);
    return { ...report, format, archiveBytes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOSPC') {
      throw new AppError(507, 'DISK_FULL', 'There is not enough free disk space.');
    }
    throw error;
  }
}
