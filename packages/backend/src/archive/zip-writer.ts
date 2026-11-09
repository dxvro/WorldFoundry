import { createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createDeflateRaw, deflateRawSync } from 'node:zlib';
import { AppError } from '../http/errors.js';
import type { TarSource } from './tar.js';

const CHUNK = 256 * 1024;
const U32 = 0xffffffff;
const ZIP64_THRESHOLD = 0xf0000000;
// formats that are compressed already; storing them saves time and rarely costs space
const STORED_EXTENSIONS = /\.(jar|zip|png|jpe?g|gz|ogg|mp4|7z|rar|xz|zst)$/i;

export interface ZipWriteOptions {
  level?: number;
  // called between files and chunks; throw to stop
  checkpoint?: () => void;
  // tests: use ZIP64 structures even for small archives
  forceZip64?: boolean;
}

interface CentralRecord {
  name: Buffer;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  dosTime: number;
  dosDate: number;
  external: number;
  directory: boolean;
  zip64: boolean;
}

function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(Number.isFinite(ms) ? ms : 0);
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function u16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value);
  return b;
}
function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0);
  return b;
}
function u64(value: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}

function zip64Extra(values: number[]): Buffer {
  return Buffer.concat([u16(1), u16(values.length * 8), ...values.map(u64)]);
}

function localHeader(name: Buffer, method: number, flags: number, crc: number, compressed: number, size: number, time: { time: number; date: number }, zip64: boolean): Buffer {
  const extra = zip64 ? zip64Extra([size, compressed]) : Buffer.alloc(0);
  return Buffer.concat([
    u32(0x04034b50),
    u16(zip64 ? 45 : 20),
    u16(flags),
    u16(method),
    u16(time.time),
    u16(time.date),
    u32(zip64 && (flags & 8) === 0 ? U32 : crc),
    u32(zip64 ? U32 : compressed),
    u32(zip64 ? U32 : size),
    u16(name.length),
    u16(extra.length),
    name,
    extra,
  ]);
}

async function* zipChunks(sources: AsyncIterable<TarSource> | Iterable<TarSource>, options: ZipWriteOptions): AsyncGenerator<Buffer> {
  const check = options.checkpoint ?? (() => undefined);
  const level = options.level ?? 6;
  const records: CentralRecord[] = [];
  let offset = 0;
  const emit = (buffer: Buffer): Buffer => {
    offset += buffer.length;
    return buffer;
  };

  for await (const source of sources) {
    check();
    const isDir = source.kind === 'dir';
    const rawName = isDir ? (source.name.endsWith('/') ? source.name : `${source.name}/`) : source.name;
    const name = Buffer.from(rawName, 'utf8');
    if (name.length > 0xffff) throw new AppError(422, 'ARCHIVE_PATH_TOO_LONG', `The path "${rawName.slice(0, 80)}" is too long for a ZIP archive.`, undefined, { path: rawName.slice(0, 80) });
    const time = dosDateTime(source.mtimeMs);
    const startOffset = offset;
    const baseExternal = isDir ? ((0o040000 | (source.mode & 0o7777)) << 16) | 0x10 : (0o100000 | (source.mode & 0o7777)) << 16;
    const external = baseExternal >>> 0;

    if (source.kind === 'dir') {
      yield emit(localHeader(name, 0, 0x0800, 0, 0, 0, time, false));
      records.push({ name, method: 0, crc: 0, compressed: 0, size: 0, offset: startOffset, dosTime: time.time, dosDate: time.date, external, directory: true, zip64: false });
      continue;
    }

    if (source.kind === 'bytes') {
      const data = source.data;
      const crc = crc32(data);
      let method = 0;
      let body = data;
      if (data.length > 64 && !STORED_EXTENSIONS.test(rawName)) {
        const packed = deflateRawSync(data, { level });
        if (packed.length < data.length) {
          method = 8;
          body = packed;
        }
      }
      yield emit(localHeader(name, method, 0x0800, crc, body.length, data.length, time, false));
      yield emit(body);
      records.push({ name, method, crc, compressed: body.length, size: data.length, offset: startOffset, dosTime: time.time, dosDate: time.date, external, directory: false, zip64: false });
      continue;
    }

    // a file: sizes and checksum are only known after streaming, so they follow in a data descriptor
    const zip64 = options.forceZip64 === true || source.size >= ZIP64_THRESHOLD || startOffset >= ZIP64_THRESHOLD;
    const method = STORED_EXTENSIONS.test(rawName) || level === 0 || source.size === 0 ? 0 : 8;
    yield emit(localHeader(name, method, 0x0808, 0, 0, 0, time, zip64));
    const handle = await open(source.file, 'r');
    let crc = 0;
    let size = 0;
    let compressed = 0;
    try {
      const raw = async function* (): AsyncGenerator<Buffer> {
        let remaining = source.size;
        while (remaining > 0) {
          check();
          const buffer = Buffer.allocUnsafe(Math.min(CHUNK, remaining));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) {
            throw new AppError(409, 'ARCHIVE_SOURCE_CHANGED', `The file "${path.basename(source.file)}" changed during the backup.`, undefined, { file: path.basename(source.file) });
          }
          remaining -= bytesRead;
          const data = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
          crc = crc32(data, crc);
          size += data.length;
          yield data;
        }
      };
      if (method === 0) {
        for await (const data of raw()) {
          compressed += data.length;
          yield emit(data);
        }
      } else {
        const deflater = createDeflateRaw({ level, chunkSize: CHUNK });
        const input = Readable.from(raw(), { objectMode: false });
        input.on('error', (error) => deflater.destroy(error));
        input.pipe(deflater);
        for await (const part of deflater) {
          const data = part as Buffer;
          compressed += data.length;
          yield emit(data);
        }
      }
    } finally {
      await handle.close();
    }
    const needs64 = zip64 || size >= U32 || compressed >= U32;
    yield emit(Buffer.concat([u32(0x08074b50), u32(crc), needs64 ? u64(compressed) : u32(compressed), needs64 ? u64(size) : u32(size)]));
    records.push({ name, method, crc, compressed, size, offset: startOffset, dosTime: time.time, dosDate: time.date, external, directory: false, zip64: needs64 });
  }

  const directoryStart = offset;
  for (const record of records) {
    const overflow = record.zip64 || record.size >= U32 || record.compressed >= U32 || record.offset >= U32;
    const fields: number[] = [];
    if (overflow) {
      if (record.size >= U32 || record.zip64) fields.push(record.size);
      if (record.compressed >= U32 || record.zip64) fields.push(record.compressed);
      if (record.offset >= U32) fields.push(record.offset);
    }
    const extra = fields.length > 0 ? zip64Extra(fields) : Buffer.alloc(0);
    yield emit(
      Buffer.concat([
        u32(0x02014b50),
        u16((3 << 8) | 63),
        u16(overflow ? 45 : 20),
        u16(record.directory ? 0x0800 : 0x0808),
        u16(record.method),
        u16(record.dosTime),
        u16(record.dosDate),
        u32(record.crc),
        u32(record.compressed >= U32 || record.zip64 ? U32 : record.compressed),
        u32(record.size >= U32 || record.zip64 ? U32 : record.size),
        u16(record.name.length),
        u16(extra.length),
        u16(0),
        u16(0),
        u16(0),
        u32(record.external),
        u32(record.offset >= U32 ? U32 : record.offset),
        record.name,
        extra,
      ]),
    );
  }
  const directorySize = offset - directoryStart;
  const big = options.forceZip64 === true || records.length >= 0xffff || directoryStart >= U32 || directorySize >= U32;
  if (big) {
    const recordAt = offset;
    yield emit(Buffer.concat([u32(0x06064b50), u64(44), u16((3 << 8) | 63), u16(45), u32(0), u32(0), u64(records.length), u64(records.length), u64(directorySize), u64(directoryStart)]));
    yield emit(Buffer.concat([u32(0x07064b50), u32(0), u64(recordAt), u32(1)]));
  }
  yield emit(
    Buffer.concat([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(big ? 0xffff : records.length),
      u16(big ? 0xffff : records.length),
      u32(big ? U32 : directorySize),
      u32(big ? U32 : directoryStart),
      u16(0),
    ]),
  );
}

// Streams a zip archive to `target` (which must not exist). Never holds more than one chunk in memory apart
// from the central directory, which grows with the number of entries.
export async function writeZip(target: string, sources: AsyncIterable<TarSource> | Iterable<TarSource>, options: ZipWriteOptions = {}): Promise<void> {
  await pipeline(Readable.from(zipChunks(sources, options), { objectMode: false }), createWriteStream(target, { flags: 'wx' }));
}
