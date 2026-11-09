import { deflateRawSync, crc32, gzipSync } from 'node:zlib';

// Independent, deliberately simple archive writers for the tests. They share no code with src/archive, so
// the readers are checked against a second implementation and against hostile layouts the real writer never produces.

export interface TarEntry {
  name: string;
  content?: Buffer | string;
  type?: '0' | '5' | '2' | '1' | '3';
  linkname?: string;
  mode?: number;
  // overrides the size field, to produce lying headers
  declaredSize?: number;
}

function field(value: string, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  buffer.write(value, 0, length, 'utf8');
  return buffer;
}

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function tarHeader(entry: TarEntry, size: number): Buffer {
  const block = Buffer.alloc(512);
  field(entry.name, 100).copy(block, 0);
  field(octal(entry.mode ?? 0o644, 8), 8).copy(block, 100);
  field(octal(0, 8), 8).copy(block, 108);
  field(octal(0, 8), 8).copy(block, 116);
  field(octal(entry.declaredSize ?? size, 12), 12).copy(block, 124);
  field(octal(0, 12), 12).copy(block, 136);
  block.fill(0x20, 148, 156);
  block.write(entry.type ?? '0', 156, 'ascii');
  field(entry.linkname ?? '', 100).copy(block, 157);
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}

export function buildTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.content ?? '');
    parts.push(tarHeader(entry, data.length));
    if (entry.type === undefined || entry.type === '0') {
      parts.push(data);
      const rest = data.length % 512;
      if (rest !== 0) parts.push(Buffer.alloc(512 - rest));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export const buildTarGz = (entries: TarEntry[]): Buffer => gzipSync(buildTar(entries));

export interface ZipEntry {
  name: string;
  content?: Buffer | string;
  stored?: boolean;
  // unix mode stored in the external attributes (symlink: 0o120777)
  mode?: number;
  // wrong checksum on purpose
  badCrc?: boolean;
}

export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(entry.content ?? '');
    const directory = entry.name.endsWith('/');
    const packed = entry.stored === true || directory ? data : deflateRawSync(data);
    const method = entry.stored === true || directory ? 0 : 8;
    const crc = entry.badCrc === true ? 1 : crc32(data);
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(entry.mode === undefined ? 20 : (3 << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc >>> 0, 16);
    header.writeUInt32LE(packed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(((entry.mode ?? 0) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += 30 + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
