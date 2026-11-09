import { createReadStream } from 'node:fs';
import { crc32, createInflateRaw } from 'node:zlib';
import { AppError } from '../http/errors.js';
import { dataStart, readDirectory, type ZipEntry } from './zip.js';

const corrupt = (): AppError => new AppError(422, 'ARCHIVE_CORRUPT', 'The archive is corrupt or incomplete.');

export type ZipDirectory = Map<string, ZipEntry>;

// Entry table of a zip file by (normalised) name; later duplicates win like in most unzip tools.
export async function zipDirectory(archive: string): Promise<ZipDirectory> {
  const table: ZipDirectory = new Map();
  for (const entry of await readDirectory(archive)) table.set(entry.name.replaceAll('\\', '/'), entry);
  return table;
}

// Reads one entry fully into memory; refuses entries larger than `maxBytes` (used for small metadata files only).
export async function readZipEntry(archive: string, entry: ZipEntry, maxBytes: number): Promise<Buffer> {
  if (entry.directory) throw corrupt();
  if (entry.size > maxBytes) throw new AppError(422, 'ARCHIVE_TOO_LARGE', `The entry "${entry.name.slice(0, 80)}" is larger than allowed.`, undefined, { entry: entry.name.slice(0, 80) });
  if (entry.method !== 0 && entry.method !== 8) throw new AppError(422, 'ARCHIVE_UNSUPPORTED', 'The archive uses an unsupported compression method.');
  if (entry.compressedSize === 0) return Buffer.alloc(0);
  const start = await dataStart(archive, entry);
  const raw = createReadStream(archive, { start, end: start + entry.compressedSize - 1 });
  const stream = entry.method === 8 ? raw.pipe(createInflateRaw()) : raw;
  raw.on('error', (error) => stream.destroy(error));
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const data = chunk as Buffer;
      total += data.length;
      if (total > entry.size || total > maxBytes) throw corrupt();
      chunks.push(data);
    }
  } catch (error) {
    raw.destroy();
    if (error instanceof AppError) throw error;
    if ((error as NodeJS.ErrnoException).code?.startsWith('Z_') === true) throw corrupt();
    throw error;
  }
  const data = Buffer.concat(chunks);
  if (data.length !== entry.size || crc32(data) !== entry.crc) throw corrupt();
  return data;
}

// Convenience for metadata lookups inside jars: the entry's bytes or null when it does not exist.
export async function readZipFile(archive: string, directory: ZipDirectory, name: string, maxBytes: number): Promise<Buffer | null> {
  const entry = directory.get(name);
  return entry === undefined || entry.directory ? null : readZipEntry(archive, entry, maxBytes);
}
