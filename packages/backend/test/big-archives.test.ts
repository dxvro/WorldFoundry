import { createReadStream } from 'node:fs';
import { open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInflateRaw, crc32 } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractTarGz, writeTarGz } from '../src/archive/tar.js';
import { dataStart, extractZip, readDirectory, type ZipEntry } from '../src/archive/zip.js';
import { writeZip } from '../src/archive/zip-writer.js';
import { stageArchive } from '../src/worldio/staging.js';
import { writeZeroTarGz, writeZeroZip } from './big-archive-builders.js';
import { scratchDir } from './server-env.js';

// Archives that do not fit 32-bit fields: entries above 4 GiB, offsets above 4 GiB, more than 65535 entries and tar
// entries above 8 GiB. The big content is zeros streamed through deflate/gzip, so the archives themselves are a few
// megabytes. Extracting them writes the full size to the temp folder (4 GiB per zip test, 8 GiB for tar), so those tests
// are opt-in: BIG_ARCHIVE_TESTS=1 npm test -w @worldfoundry/backend -- big-archives. The rest always runs.

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const U32 = 2 ** 32;
const HEAVY = 600_000;
// The tests that write several GB to the temp folder (or allocate large sparse files) only run with BIG_ARCHIVE_TESTS=1
const BIG = process.env['BIG_ARCHIVE_TESTS'] === '1';

const limits = { maxBytes: 16 * GIB, maxEntries: 1_000_000, maxRatio: 1e9 };
const noCheckpoint = (): void => undefined;
const plentyOfSpace = async (): Promise<number> => Number.MAX_SAFE_INTEGER;

let dir: string;
beforeAll(async () => {
  dir = await scratchDir('big-archive-');
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
});
const at = (...parts: string[]): string => path.join(dir, ...parts);

// CRC and length of what an entry decompresses to, streamed (nothing is written)
async function checksumOf(archive: string, entry: ZipEntry): Promise<{ crc: number; length: number }> {
  const start = await dataStart(archive, entry);
  const raw = createReadStream(archive, { start, end: start + entry.compressedSize - 1, highWaterMark: MIB });
  const stream = entry.method === 8 ? raw.pipe(createInflateRaw({ chunkSize: 256 * 1024 })) : raw;
  let crc = 0;
  let length = 0;
  for await (const chunk of stream) {
    crc = crc32(chunk as Buffer, crc);
    length += (chunk as Buffer).length;
  }
  return { crc, length };
}

describe('zip with more than 65535 entries', () => {
  it('reads the ZIP64 end record and counts every entry', async () => {
    const count = 66_000;
    const archive = at('many.zip');
    await writeZeroZip(archive, [{ name: 'world/level.dat', size: 100 }, ...Array.from({ length: count }, (_unused, index) => ({ name: `world/data/f${index}.dat`, size: 0 }))]);
    const entries = await readDirectory(archive);
    expect(entries).toHaveLength(count + 1);
    expect(entries[0]).toMatchObject({ name: 'world/level.dat', size: 100 });
    expect(entries[count]?.name).toBe(`world/data/f${count - 1}.dat`);
    // the import enforces its entry limit on the real count, not on the 16-bit field
    await expect(stageArchive(archive, at('many-out'), { maxBytes: GIB, maxEntries: 65_000, maxRatio: 200 }, plentyOfSpace, noCheckpoint)).rejects.toMatchObject({ code: 'ARCHIVE_TOO_LARGE' });
    await expect(stat(at('many-out'))).rejects.toThrow();
  });

  it('accepts exactly 65535 entries with the classic end record, where 0xFFFF is a count and not a marker', async () => {
    const archive = at('classic.zip');
    await writeZeroZip(archive, Array.from({ length: 65_535 }, (_unused, index) => ({ name: `f${index}`, size: 0 })), { classicEnd: true });
    expect(await readDirectory(archive)).toHaveLength(65_535);
  });
});

describe('zip entries above 4 GiB', () => {
  const size = 4 * GIB + 3 * MIB + 17;
  const archive = (): string => at('big.zip');
  let report: Awaited<ReturnType<typeof writeZeroZip>>;

  beforeAll(async () => {
    report = await writeZeroZip(archive(), [
      { name: 'world/region/r.0.0.mca', size },
      { name: 'world/level.dat', size: 1234 },
    ]);
  }, HEAVY);

  it('reads the 64-bit sizes exactly', async () => {
    const [big, small] = await readDirectory(archive());
    expect(big).toMatchObject({ name: 'world/region/r.0.0.mca', size, method: 8 });
    expect(big?.size).toBeGreaterThan(U32);
    expect(big?.compressedSize).toBeLessThan(64 * MIB);
    expect(small).toMatchObject({ name: 'world/level.dat', size: 1234 });
    expect(report.fileSize).toBeLessThan(128 * MIB);
  });

  it('adds up the declared sizes without wrapping around at 32 bits', async () => {
    // 4 GiB + 3 MiB would pass a 4 GiB limit if the sizes were truncated to 32 bits
    await expect(stageArchive(archive(), at('limit-out'), { maxBytes: 4 * GIB, maxEntries: 100, maxRatio: 1e9 }, plentyOfSpace, noCheckpoint)).rejects.toMatchObject({ code: 'ARCHIVE_TOO_LARGE' });
    await expect(stat(at('limit-out'))).rejects.toThrow();
  });

  it('rejects a bomb by its declared size before writing anything (ratio 200)', async () => {
    await expect(stageArchive(archive(), at('bomb-out'), { maxBytes: 16 * GIB, maxEntries: 100, maxRatio: 200 }, plentyOfSpace, noCheckpoint)).rejects.toMatchObject({ code: 'ARCHIVE_BOMB' });
    await expect(stat(at('bomb-out'))).rejects.toThrow();
  });

  it('checks the free disk space for the unpacked size and says how much is needed', async () => {
    const error = await stageArchive(archive(), at('full-out'), { maxBytes: 16 * GIB, maxEntries: 100, maxRatio: 1e9 }, async () => 3 * GIB, noCheckpoint).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'DISK_FULL',
      statusCode: 507,
      details: { neededBytes: size + 1234 + 128 * MIB, freeBytes: 3 * GIB },
      params: { purpose: 'archive-extract', neededMb: Math.ceil((size + 1234 + 128 * MIB) / MIB), freeMb: 3072 },
    });
    expect((error as Error).message).toMatch(/4\.\d GB needed, 3 GB free/);
    await expect(stat(at('full-out'))).rejects.toThrow();
  });

  it.runIf(BIG)('extracts the whole entry with matching size and checksum', async () => {
    const out = at('big-out');
    const result = await stageArchive(archive(), out, limits, plentyOfSpace, noCheckpoint);
    expect(result).toMatchObject({ format: 'zip', entries: 2, bytes: size + 1234 });
    expect((await stat(path.join(out, 'world', 'region', 'r.0.0.mca'))).size).toBe(size);
    expect((await stat(path.join(out, 'world', 'level.dat'))).size).toBe(1234);
    await rm(out, { recursive: true, force: true });
  }, HEAVY);
});

describe.skipIf(!BIG)('zip offsets above 4 GiB', () => {
  it('finds entries that start behind the 4 GiB mark (ZIP64 offset field)', async () => {
    const archive = at('offsets.zip');
    const prefix = 4 * GIB + 5 * MIB;
    const report = await writeZeroZip(archive, [{ name: 'world/region/a.mca', size: 3000 }, { name: 'world/level.dat', size: 77 }], { sparsePrefix: prefix });
    expect(report.offsets[0]).toBe(prefix);
    const entries = await readDirectory(archive);
    expect(entries.map((entry) => [entry.name, entry.localOffset])).toEqual([
      ['world/region/a.mca', prefix],
      ['world/level.dat', report.offsets[1]],
    ]);
    expect(entries[1]?.localOffset).toBeGreaterThan(U32);
    const out = at('offsets-out');
    await extractZip(archive, out, { maxBytes: MIB, maxEntries: 10 });
    expect((await stat(path.join(out, 'world', 'region', 'a.mca'))).size).toBe(3000);
    expect((await readFile(path.join(out, 'world', 'level.dat'))).length).toBe(77);
  }, 120_000);
});

describe.skipIf(!BIG)('exporting an entry above 4 GiB (the app writer)', () => {
  it('writes ZIP64 sizes, data descriptors and offsets beyond 4 GiB that the reader takes back exactly', async () => {
    const bigSize = 4 * GIB + MIB + 5;
    // sparse sources: the zeros are never written to disk, only read back
    const sources = ['big.bin', 'stored.jar'].map((name) => at(name));
    for (const source of sources) {
      const handle = await open(source, 'wx');
      await handle.truncate(bigSize);
      await handle.close();
    }
    await writeFile_(at('tail.txt'), 'the end');
    const target = at('export.zip');
    const now = Date.now();
    await writeZip(target, [
      { kind: 'file', name: 'world/big.bin', file: sources[0] as string, size: bigSize, mtimeMs: now, mode: 0o644 },
      // .jar is stored, not deflated: this entry pushes the next one past the 4 GiB offset
      { kind: 'file', name: 'mods/stored.jar', file: sources[1] as string, size: bigSize, mtimeMs: now, mode: 0o644 },
      { kind: 'file', name: 'tail.txt', file: at('tail.txt'), size: 7, mtimeMs: now, mode: 0o644 },
    ]);
    await rm(sources[0] as string);
    await rm(sources[1] as string);
    const [big, stored, tail] = await readDirectory(target);
    expect(big).toMatchObject({ name: 'world/big.bin', size: bigSize, method: 8 });
    expect(stored).toMatchObject({ name: 'mods/stored.jar', size: bigSize, compressedSize: bigSize, method: 0 });
    expect(tail?.localOffset).toBeGreaterThan(U32);
    expect(tail).toMatchObject({ name: 'tail.txt', size: 7 });
    // every entry reads back with the checksum the writer stored
    let expectedCrc = 0;
    for (let remaining = bigSize; remaining > 0; remaining -= Math.min(remaining, MIB)) expectedCrc = crc32(Buffer.alloc(Math.min(remaining, MIB)), expectedCrc);
    for (const entry of [big, stored] as ZipEntry[]) {
      const result = await checksumOf(target, entry);
      expect(result.length).toBe(bigSize);
      expect(result.crc).toBe(expectedCrc);
      expect(entry.crc).toBe(expectedCrc);
    }
  }, HEAVY);
});

async function writeFile_(file: string, text: string): Promise<void> {
  const handle = await open(file, 'wx');
  await handle.writeFile(text);
  await handle.close();
}

describe('tar.gz entries above 8 GiB', () => {
  const size = 8 * GIB + MIB + 1;

  it.each(['pax', 'base256'] as const)('reads the size from the %s header (rejected by the limit before any data is written)', async (style) => {
    const archive = at(`header-${style}.tar.gz`);
    await writeZeroTarGz(archive, 'world/region/r.0.0.mca', size, style, { headerOnly: true });
    // 8 GiB is the most an octal size field holds: a reader that stopped there would accept this limit
    await expect(extractTarGz(archive, at(`header-${style}-out`), { maxBytes: 8 * GIB, maxEntries: 10 })).rejects.toMatchObject({ code: 'ARCHIVE_TOO_LARGE' });
    // within the limit it starts writing and then finds the stream too short
    await expect(extractTarGz(archive, at(`header-${style}-out2`), { maxBytes: 9 * GIB, maxEntries: 10, onProgress: () => undefined })).rejects.toMatchObject({ code: 'ARCHIVE_CORRUPT' });
    await rm(at(`header-${style}-out2`), { recursive: true, force: true });
  }, 120_000);

  it.runIf(BIG)('writes and extracts a whole entry above 8 GiB (PAX size record)', async () => {
    const archive = at('big.tar.gz');
    await writeZeroTarGz(archive, 'world/region/r.0.0.mca', size, 'pax');
    const out = at('tar-out');
    const report = await extractTarGz(archive, out, { maxBytes: 16 * GIB, maxEntries: 10 });
    expect(report).toEqual({ entries: 1, bytes: size });
    expect((await stat(path.join(out, 'world', 'region', 'r.0.0.mca'))).size).toBe(size);
    await rm(out, { recursive: true, force: true });
  }, HEAVY);

  it.runIf(BIG)('the app writer states sizes above 8 GiB in a PAX record that its reader takes back', async () => {
    // a sparse 8 GiB + 1 file: only the header handling is under test, so it is read through the real writer but
    // the reader only has to find the size, so extraction stops at the limit
    const source = at('sparse.bin');
    const handle = await open(source, 'wx');
    await handle.truncate(size);
    await handle.close();
    const archive = at('written.tar.gz');
    await writeTarGz(archive, [{ kind: 'file', name: 'world/r.mca', file: source, size, mtimeMs: 0, mode: 0o644 }], { level: 1 });
    await rm(source);
    await expect(extractTarGz(archive, at('written-out'), { maxBytes: 8 * GIB, maxEntries: 10 })).rejects.toMatchObject({ code: 'ARCHIVE_TOO_LARGE' });
  }, HEAVY);
});
