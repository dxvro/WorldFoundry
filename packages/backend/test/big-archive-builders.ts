import { open } from 'node:fs/promises';
import { createGzip, createDeflateRaw, crc32 } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

// Streaming writers for archives with entries above 4 GiB (zip) or 8 GiB (tar) and with more than 65535 entries,
// without ever holding the data: the content is zeros, which deflate and gzip squeeze to a few megabytes. They share
// no code with src/archive, so the readers are checked against a second implementation of the format.

const U32 = 0xffffffff;
const CHUNK = 1024 * 1024;
const ZEROS = Buffer.alloc(CHUNK);

async function* zeros(size: number, onChunk?: (chunk: Buffer) => void): AsyncGenerator<Buffer> {
  let remaining = size;
  while (remaining > 0) {
    const chunk = remaining >= CHUNK ? ZEROS : ZEROS.subarray(0, remaining);
    onChunk?.(chunk);
    remaining -= chunk.length;
    yield chunk;
  }
}

const u16 = (value: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value);
  return b;
};
const u32 = (value: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
};
const u64 = (value: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
};

export interface ZeroZipEntry {
  name: string;
  // size of the (all zero) content; 0 makes an empty stored entry
  size: number;
}

export interface ZeroZipOptions {
  // leave this many bytes of (sparse) nothing in front of the first entry, so that offsets pass 4 GiB cheaply
  sparsePrefix?: number;
  // write the classic end record even for 65535 entries (legal as long as nothing else overflows)
  classicEnd?: boolean;
}

export interface ZeroZipReport {
  fileSize: number;
  offsets: number[];
}

// Writes a zip with ZIP64 structures where the values need them. Non-empty entries are deflated with a data
// descriptor (what the app's own writer produces); empty ones are plain stored entries.
export async function writeZeroZip(target: string, entries: ZeroZipEntry[], options: ZeroZipOptions = {}): Promise<ZeroZipReport> {
  const handle = await open(target, 'wx');
  let position = 0;
  const put = async (data: Buffer): Promise<void> => {
    await handle.write(data, 0, data.length, position);
    position += data.length;
  };
  const central: { name: Buffer; crc: number; compressed: number; size: number; offset: number; big: boolean }[] = [];
  const offsets: number[] = [];
  try {
    if (options.sparsePrefix !== undefined && options.sparsePrefix > 0) {
      await handle.truncate(options.sparsePrefix);
      position = options.sparsePrefix;
    }
    for (const entry of entries) {
      const name = Buffer.from(entry.name, 'utf8');
      const offset = position;
      offsets.push(offset);
      if (entry.size === 0) {
        await put(Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(0), u32(0), u32(0), u16(name.length), u16(0), name]));
        central.push({ name, crc: 0, compressed: 0, size: 0, offset, big: false });
        continue;
      }
      const extra = Buffer.concat([u16(1), u16(16), u64(0), u64(0)]);
      await put(Buffer.concat([u32(0x04034b50), u16(45), u16(0x0808), u16(8), u16(0), u16(0x21), u32(0), u32(U32), u32(U32), u16(name.length), u16(extra.length), name, extra]));
      let crc = 0;
      let compressed = 0;
      const deflater = createDeflateRaw({ level: 1, chunkSize: CHUNK });
      const input = Readable.from(
        zeros(entry.size, (chunk) => {
          crc = crc32(chunk, crc);
        }),
        { objectMode: false },
      );
      input.pipe(deflater);
      for await (const part of deflater) {
        const data = part as Buffer;
        compressed += data.length;
        await put(data);
      }
      await put(Buffer.concat([u32(0x08074b50), u32(crc), u64(compressed), u64(entry.size)]));
      central.push({ name, crc, compressed, size: entry.size, offset, big: true });
    }
    const directoryStart = position;
    for (const record of central) {
      const fields: number[] = [];
      if (record.big) fields.push(record.size, record.compressed);
      if (record.offset >= U32) fields.push(record.offset);
      const extra = fields.length === 0 ? Buffer.alloc(0) : Buffer.concat([u16(1), u16(fields.length * 8), ...fields.map(u64)]);
      await put(
        Buffer.concat([
          u32(0x02014b50),
          u16((3 << 8) | 63),
          u16(fields.length === 0 ? 20 : 45),
          u16(record.big ? 0x0808 : 0x0800),
          u16(record.big ? 8 : 0),
          u16(0),
          u16(0x21),
          u32(record.crc),
          u32(record.big ? U32 : 0),
          u32(record.big ? U32 : 0),
          u16(record.name.length),
          u16(extra.length),
          u16(0),
          u16(0),
          u16(0),
          u32((0o100644 << 16) >>> 0),
          u32(record.offset >= U32 ? U32 : record.offset),
          record.name,
          extra,
        ]),
      );
    }
    const directorySize = position - directoryStart;
    const wide = options.classicEnd === true ? directoryStart >= U32 : central.length >= 0xffff || directoryStart >= U32 || directorySize >= U32;
    if (wide) {
      const recordAt = position;
      await put(Buffer.concat([u32(0x06064b50), u64(44), u16((3 << 8) | 63), u16(45), u32(0), u32(0), u64(central.length), u64(central.length), u64(directorySize), u64(directoryStart)]));
      await put(Buffer.concat([u32(0x07064b50), u32(0), u64(recordAt), u32(1)]));
    }
    const count = wide ? 0xffff : Math.min(central.length, 0xffff);
    await put(Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(count), u16(count), u32(wide ? U32 : directorySize), u32(wide ? U32 : directoryStart), u16(0)]));
    return { fileSize: position, offsets };
  } finally {
    await handle.close();
  }
}

// ---- tar.gz ---------------------------------------------------------------------------------

function field(value: string, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  buffer.write(value, 0, length, 'utf8');
  return buffer;
}

function tarBlock(name: string, type: string, sizeField: Buffer): Buffer {
  const block = Buffer.alloc(512);
  field(name, 100).copy(block, 0);
  field('0000644\0', 8).copy(block, 100);
  field('0000000\0', 8).copy(block, 108);
  field('0000000\0', 8).copy(block, 116);
  sizeField.copy(block, 124);
  field('00000000000\0', 12).copy(block, 136);
  block.fill(0x20, 148, 156);
  block.write(type, 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}

const octalField = (value: number): Buffer => field(`${value.toString(8).padStart(11, '0')}\0`, 12);

// GNU base-256: the high bit of the first byte is set, the rest is a big-endian number
function base256Field(value: number): Buffer {
  const out = Buffer.alloc(12);
  out.writeBigUInt64BE(BigInt(value), 4);
  out[0] = 0x80;
  return out;
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(String(length) + body) !== length) length = Buffer.byteLength(String(length) + body);
  return Buffer.from(String(length) + body);
}

export type TarSizeStyle = 'pax' | 'base256';

// A tar.gz with one regular file of `size` zero bytes. 'pax' stores the size in an extended header (the field itself
// is capped at 8 GiB - 1, as the app's writer and bsdtar do), 'base256' in the header field (GNU tar).
export async function writeZeroTarGz(target: string, name: string, size: number, style: TarSizeStyle, options: { headerOnly?: boolean } = {}): Promise<void> {
  const parts: Buffer[] = [];
  if (style === 'pax') {
    const body = paxRecord('size', String(size));
    parts.push(tarBlock('PaxHeader', 'x', octalField(body.length)), body, Buffer.alloc((512 - (body.length % 512)) % 512));
    parts.push(tarBlock(name, '0', octalField(Math.min(size, 8 ** 11 - 1))));
  } else {
    parts.push(tarBlock(name, '0', base256Field(size)));
  }
  const head = Buffer.concat(parts);
  const padding = (512 - (size % 512)) % 512;
  const stream = async function* (): AsyncGenerator<Buffer> {
    yield head;
    if (options.headerOnly === true) return;
    yield* zeros(size);
    yield Buffer.alloc(padding + 1024);
  };
  await pipeline(Readable.from(stream(), { objectMode: false }), createGzip({ level: 1, chunkSize: CHUNK }), createWriteStream(target, { flags: 'wx' }));
}
