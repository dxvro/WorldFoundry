import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, open, symlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { AppError } from '../http/errors.js';
import { entrySegments, isRootEntry, resolveEntry, symlinkTargetInside, unsafeEntry } from './safe-path.js';

const BLOCK = 512;
const CHUNK = 256 * 1024;
// zlib hands out 16 KiB pieces by default; with 50 GB of data that is millions of tiny writes and reads
const ZLIB_CHUNK = 256 * 1024;
const READ_BUFFER = 1024 * 1024;
const MAX_META_BYTES = 1024 * 1024;
const OCTAL_SIZE_LIMIT = 8 ** 11;

export type TarSource =
  | { kind: 'dir'; name: string; mtimeMs: number; mode: number }
  | { kind: 'file'; name: string; file: string; size: number; mtimeMs: number; mode: number }
  | { kind: 'bytes'; name: string; data: Buffer; mtimeMs: number; mode: number };

const corrupt = (): AppError => new AppError(422, 'ARCHIVE_CORRUPT', 'The archive is corrupt or incomplete.');

// ---- writing --------------------------------------------------------------------------------

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0').slice(-(length - 1)) + '\0';
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(String(length) + body) !== length) length = Buffer.byteLength(String(length) + body);
  return Buffer.from(String(length) + body);
}

function header(name: string, type: string, size: number, mode: number, mtimeMs: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'utf8');
  block.write(octal(mode & 0o7777, 8), 100, 'ascii');
  block.write(octal(0, 8), 108, 'ascii');
  block.write(octal(0, 8), 116, 'ascii');
  block.write(octal(Math.min(size, OCTAL_SIZE_LIMIT - 1), 12), 124, 'ascii');
  block.write(octal(Math.max(0, Math.floor(mtimeMs / 1000)), 12), 136, 'ascii');
  block.fill(0x20, 148, 156);
  block.write(type, 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}

function padded(data: Buffer): Buffer[] {
  const rest = data.length % BLOCK;
  return rest === 0 ? [data] : [data, Buffer.alloc(BLOCK - rest)];
}

function metaBlocks(name: string, size: number, mtimeMs: number): Buffer[] {
  const records: Buffer[] = [];
  if (name.length > 99 || Buffer.byteLength(name) > 99 || /[^\x20-\x7e]/.test(name)) records.push(paxRecord('path', name));
  if (size >= OCTAL_SIZE_LIMIT) records.push(paxRecord('size', String(size)));
  if (records.length === 0) return [];
  const body = Buffer.concat(records);
  return [header('PaxHeader', 'x', body.length, 0o644, mtimeMs), ...padded(body)];
}

function shortName(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  return ascii.length > 99 ? ascii.slice(-99) : ascii;
}

async function* tarChunks(sources: AsyncIterable<TarSource> | Iterable<TarSource>, shouldAbort: () => void): AsyncGenerator<Buffer> {
  for await (const source of sources) {
    shouldAbort();
    if (source.kind === 'dir') {
      const name = source.name.endsWith('/') ? source.name : `${source.name}/`;
      for (const block of metaBlocks(name, 0, source.mtimeMs)) yield block;
      yield header(shortName(name), '5', 0, source.mode, source.mtimeMs);
      continue;
    }
    if (source.kind === 'bytes') {
      for (const block of metaBlocks(source.name, source.data.length, source.mtimeMs)) yield block;
      yield header(shortName(source.name), '0', source.data.length, source.mode, source.mtimeMs);
      for (const block of padded(source.data)) yield block;
      continue;
    }
    const handle = await open(source.file, 'r');
    try {
      for (const block of metaBlocks(source.name, source.size, source.mtimeMs)) yield block;
      yield header(shortName(source.name), '0', source.size, source.mode, source.mtimeMs);
      let remaining = source.size;
      while (remaining > 0) {
        shouldAbort();
        const buffer = Buffer.allocUnsafe(Math.min(CHUNK, remaining));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) {
          throw new AppError(409, 'ARCHIVE_SOURCE_CHANGED', `The file "${path.basename(source.file)}" changed during the backup.`, undefined, { file: path.basename(source.file) });
        }
        remaining -= bytesRead;
        yield bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
      }
      const rest = source.size % BLOCK;
      if (rest !== 0) yield Buffer.alloc(BLOCK - rest);
    } finally {
      await handle.close();
    }
  }
  yield Buffer.alloc(BLOCK * 2);
}

export interface TarWriteOptions {
  level?: number;
  // called between files and chunks; throw to stop
  checkpoint?: () => void;
}

export async function writeTarGz(target: string, sources: AsyncIterable<TarSource> | Iterable<TarSource>, options: TarWriteOptions = {}): Promise<void> {
  await pipeline(
    Readable.from(tarChunks(sources, options.checkpoint ?? (() => undefined)), { objectMode: false }),
    createGzip({ level: options.level ?? 6, chunkSize: ZLIB_CHUNK }),
    createWriteStream(target, { flags: 'wx' }),
  );
}

// ---- reading --------------------------------------------------------------------------------

class ByteReader {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly source: AsyncIterator<Buffer>) {}

  private async fill(minimum: number): Promise<boolean> {
    while (this.buffer.length < minimum) {
      const next = await this.source.next();
      if (next.done === true) return false;
      this.buffer = this.buffer.length === 0 ? next.value : Buffer.concat([this.buffer, next.value]);
    }
    return true;
  }

  // null only when the stream ends exactly before the first byte
  async read(length: number): Promise<Buffer | null> {
    if (!(await this.fill(length))) {
      if (this.buffer.length === 0) return null;
      throw corrupt();
    }
    const out = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return Buffer.from(out);
  }

  async copy(length: number, sink: (chunk: Buffer) => Promise<void>): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      if (this.buffer.length === 0 && !(await this.fill(1))) throw corrupt();
      const part = this.buffer.subarray(0, Math.min(remaining, this.buffer.length));
      this.buffer = this.buffer.subarray(part.length);
      remaining -= part.length;
      await sink(part);
    }
  }

  async skip(length: number): Promise<void> {
    await this.copy(length, async () => undefined);
  }
}

function readString(block: Buffer, start: number, length: number): string {
  const end = block.indexOf(0, start);
  return block.toString('utf8', start, end === -1 || end > start + length ? start + length : end);
}

function readOctal(block: Buffer, start: number, length: number): number {
  if ((block[start] ?? 0) & 0x80) {
    // base-256 encoding for very large values
    let value = (block[start] ?? 0) & 0x7f;
    for (let index = 1; index < length; index++) value = value * 256 + (block[start + index] ?? 0);
    return value;
  }
  const text = readString(block, start, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw corrupt();
  return parseInt(text, 8);
}

function checksumOk(block: Buffer): boolean {
  const stored = readOctal(block, 148, 8);
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) sum += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
  return sum === stored;
}

function parsePax(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw corrupt();
    const length = Number(data.toString('ascii', offset, space));
    if (!Number.isInteger(length) || length <= space - offset || offset + length > data.length) throw corrupt();
    const record = data.toString('utf8', space + 1, offset + length - 1);
    const eq = record.indexOf('=');
    if (eq > 0) records[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return records;
}

export interface ExtractLimits {
  maxBytes: number;
  maxEntries: number;
}

export interface ExtractOptions extends ExtractLimits {
  allowSymlinks?: boolean;
  platform?: NodeJS.Platform;
  checkpoint?: () => void;
  onProgress?: (bytesWritten: number) => void;
}

export interface ExtractReport {
  entries: number;
  bytes: number;
}

export class ExtractionGuard {
  private readonly links = new Set<string>();
  entries = 0;
  bytes = 0;

  constructor(
    readonly root: string,
    readonly options: ExtractOptions,
  ) {}

  count(declaredSize: number): void {
    this.options.checkpoint?.();
    if (++this.entries > this.options.maxEntries) throw new AppError(422, 'ARCHIVE_TOO_LARGE', 'The archive contains too many entries.');
    if (this.bytes + declaredSize > this.options.maxBytes) {
      throw new AppError(422, 'ARCHIVE_TOO_LARGE', 'The archive is larger than allowed once extracted.');
    }
  }

  // no entry may be written through a symlink that an earlier entry created
  resolve(name: string): { segments: string[]; target: string } {
    const entry = resolveEntry(this.root, name, this.options.platform);
    for (let length = 1; length <= entry.segments.length; length++) {
      if (this.links.has(entry.segments.slice(0, length).join('/'))) throw unsafeEntry(name, 'lies behind a symlink');
    }
    return entry;
  }

  addLink(segments: readonly string[]): void {
    this.links.add(segments.join('/'));
  }

  written(size: number): void {
    this.bytes += size;
    this.options.onProgress?.(this.bytes);
  }
}

const dirMode = 0o755;

export async function writeExtractedFile(guard: ExtractionGuard, target: string, size: number, mode: number, feed: (sink: (chunk: Buffer) => Promise<void>) => Promise<void>): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: dirMode });
  const handle: FileHandle = await open(target, 'w', 0o644);
  let written = 0;
  try {
    await feed(async (chunk) => {
      written += chunk.length;
      if (written > size) throw corrupt();
      await handle.write(chunk);
      guard.written(chunk.length);
    });
    if (written !== size) throw corrupt();
  } finally {
    await handle.close();
  }
  if ((guard.options.platform ?? process.platform) !== 'win32') await chmod(target, mode === 0 ? 0o644 : (mode & 0o777) | 0o600);
}

export async function extractTarGz(archive: string, root: string, options: ExtractOptions): Promise<ExtractReport> {
  const guard = new ExtractionGuard(root, options);
  const platform = options.platform ?? process.platform;
  await mkdir(root, { recursive: true });
  const source = createReadStream(archive, { highWaterMark: READ_BUFFER });
  const gunzip = createGunzip({ chunkSize: ZLIB_CHUNK });
  source.on('error', (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  const reader = new ByteReader(gunzip[Symbol.asyncIterator]());
  const hardlinkSources = new Map<string, string>();
  let pax: Record<string, string> = {};
  let longName: string | null = null;
  let longLink: string | null = null;

  try {
    for (;;) {
      const block = await reader.read(BLOCK);
      if (block === null || block.every((byte) => byte === 0)) break;
      if (!checksumOk(block)) throw corrupt();
      const type = String.fromCharCode(block[156] ?? 0x30);
      let size = readOctal(block, 124, 12);

      if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
        if (size > MAX_META_BYTES) throw corrupt();
        const data = (await reader.read(size)) ?? Buffer.alloc(0);
        await reader.skip((BLOCK - (size % BLOCK)) % BLOCK);
        if (type === 'x') pax = { ...pax, ...parsePax(data) };
        else if (type === 'L') longName = readString(data, 0, data.length);
        else if (type === 'K') longLink = readString(data, 0, data.length);
        continue;
      }

      const prefix = readString(block, 345, 155);
      const baseName = readString(block, 0, 100);
      const name = pax['path'] ?? longName ?? (prefix === '' ? baseName : `${prefix}/${baseName}`);
      const linkname = pax['linkpath'] ?? longLink ?? readString(block, 157, 100);
      if (pax['size'] !== undefined) size = Number(pax['size']);
      pax = {};
      longName = null;
      longLink = null;
      if (!Number.isSafeInteger(size) || size < 0) throw corrupt();
      const mode = readOctal(block, 100, 8);
      const padding = (BLOCK - (size % BLOCK)) % BLOCK;

      if (type === '5' && isRootEntry(name)) {
        // tar -C dir . starts with an entry for the folder itself
        await reader.skip(size + padding);
        continue;
      } else if (type === '5') {
        guard.count(0);
        const { target } = guard.resolve(name);
        await mkdir(target, { recursive: true, mode: dirMode });
      } else if (type === '0' || type === '\0' || type === '7') {
        guard.count(size);
        const { target, segments } = guard.resolve(name);
        await writeExtractedFile(guard, target, size, mode, (sink) => reader.copy(size, sink));
        await reader.skip(padding);
        hardlinkSources.set(segments.join('/'), target);
        continue;
      } else if (type === '2') {
        guard.count(0);
        if (options.allowSymlinks !== true || platform === 'win32') throw unsafeEntry(name, 'symlinks are not allowed');
        const { target, segments } = guard.resolve(name);
        if (!symlinkTargetInside(segments, linkname)) throw unsafeEntry(name, 'symlink points out of the target folder');
        await mkdir(path.dirname(target), { recursive: true, mode: dirMode });
        await symlink(linkname, target);
        guard.addLink(segments);
      } else if (type === '1') {
        guard.count(0);
        const { target } = guard.resolve(name);
        const from = hardlinkSources.get(entrySegments(linkname, platform).join('/'));
        if (from === undefined) throw unsafeEntry(name, 'hardlink does not refer to a known file');
        await mkdir(path.dirname(target), { recursive: true, mode: dirMode });
        await copyFile(from, target);
      } else {
        throw unsafeEntry(name, `entry type "${type}" is not supported`);
      }
      await reader.skip(size + padding);
    }
  } catch (error) {
    source.destroy();
    gunzip.destroy();
    if (error instanceof AppError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOSPC') {
      throw new AppError(507, 'DISK_FULL', 'There is not enough free disk space.');
    }
    if (typeof (error as NodeJS.ErrnoException).code === 'string' && (error as NodeJS.ErrnoException).code?.startsWith('Z_') === true) throw corrupt();
    throw error;
  }
  source.destroy();
  return { entries: guard.entries, bytes: guard.bytes };
}
