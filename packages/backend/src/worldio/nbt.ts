import { gunzipSync, gzipSync } from 'node:zlib';
import { AppError } from '../http/errors.js';

// A small NBT (Named Binary Tag) reader and writer, big-endian "Java Edition" flavour. It keeps the tag types
// so that a file read here can be written back unchanged; callers use the accessor helpers below.

export type NbtTag =
  | { type: 'byte' | 'short' | 'int' | 'float' | 'double'; value: number }
  | { type: 'long'; value: bigint }
  | { type: 'string'; value: string }
  | { type: 'byteArray'; value: Buffer }
  | { type: 'intArray'; value: number[] }
  | { type: 'longArray'; value: bigint[] }
  | { type: 'list'; elementType: NbtTagType; value: NbtTag[] }
  | { type: 'compound'; value: Map<string, NbtTag> };

export type NbtTagType = NbtTag['type'] | 'end';
export type NbtCompound = Extract<NbtTag, { type: 'compound' }>;

const IDS: NbtTagType[] = ['end', 'byte', 'short', 'int', 'long', 'float', 'double', 'byteArray', 'string', 'list', 'compound', 'intArray', 'longArray'];
const MAX_DEPTH = 512;
export const MAX_NBT_BYTES = 64 * 1024 * 1024;

const invalid = (detail: string): AppError => new AppError(422, 'NBT_INVALID', `The NBT file is corrupt (${detail}).`, undefined, { detail });

class Reader {
  private pos = 0;
  constructor(private readonly buf: Buffer) {}

  private need(count: number): void {
    if (count < 0 || this.pos + count > this.buf.length) throw invalid('file ends unexpectedly');
  }
  u8(): number {
    this.need(1);
    return this.buf.readUInt8(this.pos++);
  }
  i8(): number {
    this.need(1);
    return this.buf.readInt8(this.pos++);
  }
  i16(): number {
    this.need(2);
    const v = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  i64(): bigint {
    this.need(8);
    const v = this.buf.readBigInt64BE(this.pos);
    this.pos += 8;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.buf.readFloatBE(this.pos);
    this.pos += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.buf.readDoubleBE(this.pos);
    this.pos += 8;
    return v;
  }
  bytes(count: number): Buffer {
    this.need(count);
    const out = this.buf.subarray(this.pos, this.pos + count);
    this.pos += count;
    return out;
  }
  string(): string {
    return this.bytes(this.u16()).toString('utf8');
  }
}

function readPayload(r: Reader, type: NbtTagType, depth: number): NbtTag {
  if (depth > MAX_DEPTH) throw invalid('nested too deeply');
  switch (type) {
    case 'byte':
      return { type, value: r.i8() };
    case 'short':
      return { type, value: r.i16() };
    case 'int':
      return { type, value: r.i32() };
    case 'long':
      return { type, value: r.i64() };
    case 'float':
      return { type, value: r.f32() };
    case 'double':
      return { type, value: r.f64() };
    case 'byteArray': {
      const length = r.i32();
      return { type, value: Buffer.from(r.bytes(length)) };
    }
    case 'string':
      return { type, value: r.string() };
    case 'intArray': {
      const length = r.i32();
      if (length < 0 || length * 4 > MAX_NBT_BYTES) throw invalid('invalid length');
      const value: number[] = [];
      for (let i = 0; i < length; i++) value.push(r.i32());
      return { type, value };
    }
    case 'longArray': {
      const length = r.i32();
      if (length < 0 || length * 8 > MAX_NBT_BYTES) throw invalid('invalid length');
      const value: bigint[] = [];
      for (let i = 0; i < length; i++) value.push(r.i64());
      return { type, value };
    }
    case 'list': {
      const elementId = r.u8();
      const elementType = IDS[elementId];
      const length = r.i32();
      if (elementType === undefined || length < 0) throw invalid('invalid list');
      if (elementType === 'end' && length > 0) throw invalid('invalid list');
      const value: NbtTag[] = [];
      for (let i = 0; i < length; i++) value.push(readPayload(r, elementType, depth + 1));
      return { type, elementType, value };
    }
    case 'compound': {
      const value = new Map<string, NbtTag>();
      for (;;) {
        const id = r.u8();
        if (id === 0) break;
        const child = IDS[id];
        if (child === undefined) throw invalid(`unknown tag type ${id}`);
        const name = r.string();
        value.set(name, readPayload(r, child, depth + 1));
      }
      return { type, value };
    }
    default:
      throw invalid('unexpected tag');
  }
}

// Parses an uncompressed NBT document; the root must be a compound.
export function parseNbt(data: Buffer): { name: string; root: NbtCompound } {
  const r = new Reader(data);
  if (r.u8() !== 10) throw invalid('root is not a compound');
  const name = r.string();
  const root = readPayload(r, 'compound', 0) as NbtCompound;
  return { name, root };
}

// Accepts gzip (level.dat, playerdata) as well as raw NBT
export function parseNbtFile(data: Buffer, maxBytes = MAX_NBT_BYTES): { name: string; root: NbtCompound } {
  let plain = data;
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
    try {
      plain = gunzipSync(data, { maxOutputLength: maxBytes });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw invalid('too large when unpacked');
      throw invalid('faulty compression');
    }
  }
  return parseNbt(plain);
}

// ---- writing --------------------------------------------------------------------------------

function writePayload(tag: NbtTag, out: Buffer[]): void {
  const push = (size: number, fill: (b: Buffer) => void): void => {
    const b = Buffer.alloc(size);
    fill(b);
    out.push(b);
  };
  switch (tag.type) {
    case 'byte':
      push(1, (b) => b.writeInt8(tag.value));
      break;
    case 'short':
      push(2, (b) => b.writeInt16BE(tag.value));
      break;
    case 'int':
      push(4, (b) => b.writeInt32BE(tag.value));
      break;
    case 'long':
      push(8, (b) => b.writeBigInt64BE(tag.value));
      break;
    case 'float':
      push(4, (b) => b.writeFloatBE(tag.value));
      break;
    case 'double':
      push(8, (b) => b.writeDoubleBE(tag.value));
      break;
    case 'byteArray':
      push(4, (b) => b.writeInt32BE(tag.value.length));
      out.push(tag.value);
      break;
    case 'string': {
      const text = Buffer.from(tag.value, 'utf8');
      push(2, (b) => b.writeUInt16BE(text.length));
      out.push(text);
      break;
    }
    case 'intArray':
      push(4, (b) => b.writeInt32BE(tag.value.length));
      for (const v of tag.value) push(4, (b) => b.writeInt32BE(v));
      break;
    case 'longArray':
      push(4, (b) => b.writeInt32BE(tag.value.length));
      for (const v of tag.value) push(8, (b) => b.writeBigInt64BE(v));
      break;
    case 'list':
      push(5, (b) => {
        b.writeUInt8(IDS.indexOf(tag.elementType), 0);
        b.writeInt32BE(tag.value.length, 1);
      });
      for (const element of tag.value) writePayload(element, out);
      break;
    case 'compound':
      for (const [name, entry] of tag.value) {
        push(1, (b) => b.writeUInt8(IDS.indexOf(entry.type)));
        const key = Buffer.from(name, 'utf8');
        push(2, (b) => b.writeUInt16BE(key.length));
        out.push(key);
        writePayload(entry, out);
      }
      out.push(Buffer.from([0]));
      break;
  }
}

export function writeNbt(root: NbtCompound, rootName = ''): Buffer {
  const out: Buffer[] = [Buffer.from([10])];
  const name = Buffer.from(rootName, 'utf8');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(name.length);
  out.push(length, name);
  writePayload(root, out);
  return Buffer.concat(out);
}

export const writeNbtGzip = (root: NbtCompound, rootName = ''): Buffer => gzipSync(writeNbt(root, rootName));

// ---- builders (tests and the player data conversion) ----------------------------------------

export const nbt = {
  byte: (value: number): NbtTag => ({ type: 'byte', value }),
  short: (value: number): NbtTag => ({ type: 'short', value }),
  int: (value: number): NbtTag => ({ type: 'int', value }),
  long: (value: bigint | number): NbtTag => ({ type: 'long', value: BigInt(value) }),
  float: (value: number): NbtTag => ({ type: 'float', value }),
  double: (value: number): NbtTag => ({ type: 'double', value }),
  string: (value: string): NbtTag => ({ type: 'string', value }),
  intArray: (value: number[]): NbtTag => ({ type: 'intArray', value }),
  longArray: (value: bigint[]): NbtTag => ({ type: 'longArray', value }),
  byteArray: (value: Buffer): NbtTag => ({ type: 'byteArray', value }),
  list: (elementType: NbtTagType, value: NbtTag[]): NbtTag => ({ type: 'list', elementType, value }),
  compound: (entries: Record<string, NbtTag> = {}): NbtCompound => ({ type: 'compound', value: new Map(Object.entries(entries)) }),
};

// ---- accessors ------------------------------------------------------------------------------

export function child(tag: NbtTag | undefined, ...path: string[]): NbtTag | undefined {
  let current = tag;
  for (const key of path) {
    if (current?.type !== 'compound') return undefined;
    current = current.value.get(key);
  }
  return current;
}

// case-insensitive lookup of a direct child ("fml" vs "FML")
export function childInsensitive(tag: NbtTag | undefined, name: string): NbtTag | undefined {
  if (tag?.type !== 'compound') return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of tag.value) if (key.toLowerCase() === lower) return value;
  return undefined;
}

export function asString(tag: NbtTag | undefined): string | null {
  return tag?.type === 'string' ? tag.value : null;
}

export function asNumber(tag: NbtTag | undefined): number | null {
  if (tag === undefined) return null;
  if (tag.type === 'byte' || tag.type === 'short' || tag.type === 'int' || tag.type === 'float' || tag.type === 'double') return tag.value;
  if (tag.type === 'long') return Number(tag.value);
  return null;
}

export function asList(tag: NbtTag | undefined): NbtTag[] {
  return tag?.type === 'list' ? tag.value : [];
}
