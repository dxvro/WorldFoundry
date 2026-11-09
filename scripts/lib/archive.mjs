// Small archive library without dependencies: write/read tar.gz, write/read zip.
// Own implementation so that file permissions (execute bit) are correct even when building on Windows
// and the archives are reproducible (fixed time, uid/gid 0).
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import zlib from 'node:zlib';

const BLOCK = 512;

// ---------------------------------------------------------------- tar

function octal(value, length) {
  const text = value.toString(8);
  if (text.length > length - 1) throw new Error(`Value ${value} does not fit in ${length} bytes (tar)`);
  return text.padStart(length - 1, '0') + '\0';
}

function putString(buffer, text, offset, length) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > length) throw new Error(`Text too long for tar field: ${text}`);
  bytes.copy(buffer, offset);
}

function tarHeader({ name, prefix = '', mode, size, mtime, type }) {
  const header = Buffer.alloc(BLOCK);
  putString(header, name, 0, 100);
  header.write(octal(mode, 8), 100, 'ascii');
  header.write(octal(0, 8), 108, 'ascii'); // uid
  header.write(octal(0, 8), 116, 'ascii'); // gid
  header.write(octal(size, 12), 124, 'ascii');
  header.write(octal(mtime, 12), 136, 'ascii');
  header.fill(0x20, 148, 156); // the checksum field counts as spaces
  header.write(type, 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  header.write('root', 265, 'ascii');
  header.write('root', 297, 'ascii');
  putString(header, prefix, 345, 155);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return header;
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  const bodyLength = Buffer.byteLength(body);
  let length = bodyLength + 1;
  while (String(length).length + bodyLength !== length) length = String(length).length + bodyLength;
  return Buffer.from(`${length}${body}`, 'utf8');
}

function pad(buffer) {
  const rest = buffer.length % BLOCK;
  return rest === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(BLOCK - rest)]);
}

function splitName(fullName) {
  if (Buffer.byteLength(fullName) <= 100) return { name: fullName, prefix: '' };
  const parts = fullName.split('/');
  for (let i = parts.length - 1; i > 0; i -= 1) {
    const prefix = parts.slice(0, i).join('/');
    const name = parts.slice(i).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  return null;
}

// entries: [{ path, type: 'file'|'dir', mode, data?: Buffer, file?: string }], path separated by "/"
export async function* tarChunks(entries, mtime) {
  for (const entry of entries) {
    const isDir = entry.type === 'dir';
    const fullName = isDir && !entry.path.endsWith('/') ? `${entry.path}/` : entry.path;
    const data = isDir ? Buffer.alloc(0) : (entry.data ?? (await readFile(entry.file)));
    const split = splitName(fullName);
    let name;
    let prefix = '';
    if (split === null || /[^\x20-\x7e]/.test(fullName)) {
      const pax = paxRecord('path', fullName);
      yield tarHeader({ name: 'PaxHeader/entry', mode: 0o644, size: pax.length, mtime, type: 'x' });
      yield pad(pax);
      name = Buffer.from(fullName, 'utf8').subarray(0, 100).toString('latin1').replace(/[^\x20-\x7e]/g, '_');
    } else {
      ({ name, prefix } = split);
    }
    yield tarHeader({ name, prefix, mode: entry.mode, size: data.length, mtime, type: isDir ? '5' : '0' });
    if (data.length > 0) yield pad(data);
  }
  yield Buffer.alloc(BLOCK * 2);
}

async function writeChunks(chunks, destination) {
  const out = createWriteStream(destination);
  try {
    for await (const chunk of chunks) {
      if (!out.write(chunk)) await once(out, 'drain');
    }
  } finally {
    out.end();
  }
  await once(out, 'finish');
}

export async function writeTarGz(destination, entries, mtime) {
  const gzip = zlib.createGzip({ level: 9 });
  const out = createWriteStream(destination);
  const finished = once(out, 'finish');
  gzip.pipe(out);
  for await (const chunk of tarChunks(entries, mtime)) {
    if (!gzip.write(chunk)) await once(gzip, 'drain');
  }
  gzip.end();
  await finished;
}

export function parseTar(buffer) {
  const entries = [];
  let offset = 0;
  let paxPath = null;
  let longName = null;
  const readString = (start, length) => {
    const slice = buffer.subarray(start, start + length);
    const end = slice.indexOf(0);
    return slice.subarray(0, end === -1 ? length : end).toString('utf8');
  };
  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(readString(offset + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] === 0 ? 0x30 : header[156]);
    const mode = parseInt(readString(offset + 100, 8).trim() || '0', 8);
    const base = readString(offset, 100);
    const prefix = readString(offset + 345, 155);
    const dataStart = offset + BLOCK;
    const data = buffer.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') {
      const text = data.toString('utf8');
      const match = /\d+ path=([^\n]*)\n/.exec(text);
      if (match !== null) paxPath = match[1];
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    const name = paxPath ?? longName ?? (prefix === '' ? base : `${prefix}/${base}`);
    paxPath = null;
    longName = null;
    entries.push({ path: name, type: type === '5' ? 'dir' : type === '0' ? 'file' : type === '2' ? 'symlink' : 'other', mode, data });
  }
  return entries;
}

export async function readTarGz(file) {
  const compressed = await readFile(file);
  return parseTar(zlib.gunzipSync(compressed));
}

// ---------------------------------------------------------------- zip

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1; // 2000-01-01, fixed value for reproducible archives

function localHeader(nameBytes, crc, compressedSize, size, method) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6); // file names are UTF-8
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressedSize, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBytes]);
}

function centralHeader(nameBytes, crc, compressedSize, size, method, offset, mode, isDir) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE((3 << 8) | 20, 4); // created on Unix, version 2.0
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(method, 10);
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compressedSize, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  const fileType = isDir ? 0o040000 : 0o100000;
  header.writeUInt32LE((((fileType | mode) << 16) | (isDir ? 0x10 : 0)) >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, nameBytes]);
}

export async function writeZip(destination, entries) {
  const handle = await open(destination, 'w');
  const central = [];
  let position = 0;
  const write = async (buffer) => {
    await handle.write(buffer, 0, buffer.length, position);
    position += buffer.length;
  };
  try {
    for (const entry of entries) {
      const isDir = entry.type === 'dir';
      const name = isDir && !entry.path.endsWith('/') ? `${entry.path}/` : entry.path;
      const nameBytes = Buffer.from(name, 'utf8');
      const data = isDir ? Buffer.alloc(0) : (entry.data ?? (await readFile(entry.file)));
      const crc = zlib.crc32(data);
      const deflated = data.length === 0 ? data : zlib.deflateRawSync(data, { level: 9 });
      const useDeflate = deflated.length < data.length;
      const stored = useDeflate ? deflated : data;
      const method = useDeflate ? 8 : 0;
      central.push(centralHeader(nameBytes, crc, stored.length, data.length, method, position, entry.mode, isDir));
      await write(localHeader(nameBytes, crc, stored.length, data.length, method));
      if (stored.length > 0) await write(stored);
    }
    const centralStart = position;
    const centralBuffer = Buffer.concat(central);
    await write(centralBuffer);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(centralBuffer.length, 12);
    end.writeUInt32LE(centralStart, 16);
    await write(end);
  } finally {
    await handle.close();
  }
}

export function parseZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('Not a valid ZIP archive (end record is missing).');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Damaged ZIP archive (central directory).');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttrs = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('ZIP64 is not supported.');
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.push({
      path: name,
      type: name.endsWith('/') ? 'dir' : 'file',
      mode: (externalAttrs >>> 16) & 0o7777,
      get data() {
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return zlib.inflateRawSync(raw);
        throw new Error(`Unsupported ZIP compression ${method}`);
      },
      size,
    });
  }
  return entries;
}

export async function readZip(file) {
  return parseZip(await readFile(file));
}

