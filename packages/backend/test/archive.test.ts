import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { entrySegments, resolveEntry, symlinkTargetInside } from '../src/archive/safe-path.js';
import { extractTarGz, writeTarGz, type TarSource } from '../src/archive/tar.js';
import { extractZip } from '../src/archive/zip.js';
import { buildTarGz, buildZip } from './archive-builders.js';
import { scratchDir } from './server-env.js';

let dir: string;
beforeEach(async () => {
  dir = await scratchDir('archive-');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const limits = { maxBytes: 50 * 1024 * 1024, maxEntries: 1000 };
const out = (name = 'out'): string => path.join(dir, name);
const put = async (name: string, data: Buffer): Promise<string> => {
  const file = path.join(dir, name);
  await writeFile(file, data);
  return file;
};

async function rejects(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('entry names', () => {
  it('accepts plain relative names and normalizes separators', () => {
    expect(entrySegments('a/b/c.txt')).toEqual(['a', 'b', 'c.txt']);
    expect(entrySegments('./a//b\\c.txt')).toEqual(['a', 'b', 'c.txt']);
    expect(entrySegments('World Äöü/region/r.0.0.mca')).toEqual(['World Äöü', 'region', 'r.0.0.mca']);
  });

  it.each(['../evil', 'a/../../evil', '/etc/passwd', '\\windows\\x', 'C:\\x', 'c:/x', 'a/..', '', 'a\0b'])('rejects %j', (name) => {
    expect(() => entrySegments(name)).toThrowError(expect.objectContaining({ code: 'ARCHIVE_UNSAFE' }) as Error);
  });

  it('rejects names Windows cannot store only on Windows', () => {
    for (const name of ['a/con.txt', 'a/b:stream', 'a/x?', 'a/trailing.', 'a/trailing ']) {
      expect(() => entrySegments(name, 'win32')).toThrowError(expect.objectContaining({ code: 'ARCHIVE_UNSAFE' }) as Error);
      expect(() => entrySegments(name, 'linux')).not.toThrow();
    }
  });

  it('resolves inside the root and refuses everything that leaves it', () => {
    expect(resolveEntry(dir, 'a/b').target).toBe(path.join(dir, 'a', 'b'));
    expect(() => resolveEntry(dir, '../x')).toThrow();
  });

  it('accepts only symlink targets that stay below the root', () => {
    expect(symlinkTargetInside(['a', 'link'], 'target')).toBe(true);
    expect(symlinkTargetInside(['a', 'link'], '../b/c')).toBe(true);
    expect(symlinkTargetInside(['a', 'link'], '../../outside')).toBe(false);
    expect(symlinkTargetInside(['link'], '../x')).toBe(false);
    expect(symlinkTargetInside(['a', 'link'], '/etc/passwd')).toBe(false);
    expect(symlinkTargetInside(['a', 'link'], 'C:\\x')).toBe(false);
    // "b/../.." would escape if b were itself a link
    expect(symlinkTargetInside(['a', 'link'], 'b/../../x')).toBe(false);
    expect(symlinkTargetInside(['a', 'b', 'link'], 'c/../d')).toBe(false);
  });
});

describe('tar.gz round trip with the real writer', () => {
  async function pack(sources: TarSource[]): Promise<string> {
    const archive = path.join(dir, 'a.tar.gz');
    await writeTarGz(archive, sources);
    return archive;
  }

  it('keeps names, empty folders, unicode, long paths and large files', async () => {
    const big = Buffer.alloc(700_000, 7);
    await writeFile(path.join(dir, 'big.bin'), big);
    await writeFile(path.join(dir, 'small.txt'), 'Grüße');
    const longName = `${'folder/'.repeat(30)}file-with-long-name.txt`;
    const archive = await pack([
      { kind: 'dir', name: 'world', mtimeMs: 0, mode: 0o755 },
      { kind: 'dir', name: 'world/empty', mtimeMs: 0, mode: 0o755 },
      { kind: 'file', name: 'world/big.bin', file: path.join(dir, 'big.bin'), size: big.length, mtimeMs: 0, mode: 0o644 },
      { kind: 'file', name: 'World Äöü/little.txt', file: path.join(dir, 'small.txt'), size: Buffer.byteLength('Grüße'), mtimeMs: 0, mode: 0o644 },
      { kind: 'bytes', name: longName, data: Buffer.from('lang'), mtimeMs: 0, mode: 0o644 },
      { kind: 'bytes', name: 'empty.txt', data: Buffer.alloc(0), mtimeMs: 0, mode: 0o644 },
    ]);
    const report = await extractTarGz(archive, out(), limits);
    expect(report.entries).toBe(6);
    expect((await readFile(out('out/world/big.bin'))).equals(big)).toBe(true);
    expect(await readFile(out('out/World Äöü/little.txt'), 'utf8')).toBe('Grüße');
    expect(await readFile(path.join(out(), ...longName.split('/')), 'utf8')).toBe('lang');
    expect((await stat(out('out/world/empty'))).isDirectory()).toBe(true);
    expect((await readFile(out('out/empty.txt'))).length).toBe(0);
  });

  it('fails clearly when a source file shrinks while it is being read', async () => {
    await writeFile(path.join(dir, 'f.bin'), 'short');
    await expect(
      pack([{ kind: 'file', name: 'f.bin', file: path.join(dir, 'f.bin'), size: 10_000, mtimeMs: 0, mode: 0o644 }]),
    ).rejects.toMatchObject({ code: 'ARCHIVE_SOURCE_CHANGED' });
  });

  it('stops at the checkpoint', async () => {
    let calls = 0;
    await expect(
      writeTarGz(
        path.join(dir, 'stop.tar.gz'),
        [
          { kind: 'bytes', name: 'a', data: Buffer.from('1'), mtimeMs: 0, mode: 0o644 },
          { kind: 'bytes', name: 'b', data: Buffer.from('2'), mtimeMs: 0, mode: 0o644 },
        ],
        {
          checkpoint: () => {
            if (++calls > 1) throw new Error('aborted');
          },
        },
      ),
    ).rejects.toThrow('aborted');
  });

  it('reads archives made by the system tar (pax and long names)', async () => {
    let available = true;
    try {
      execFileSync('tar', ['--version'], { stdio: 'ignore' });
    } catch {
      available = false;
    }
    if (!available) return;
    const source = path.join(dir, 'src');
    await mkdir(path.join(source, 'sub'), { recursive: true });
    await writeFile(path.join(source, 'sub', 'file.txt'), 'content');
    await writeFile(path.join(source, `${'x'.repeat(120)}.txt`), 'lang');
    execFileSync('tar', ['-czf', 'sys.tar.gz', '-C', 'src', '.'], { cwd: dir });
    await extractTarGz(path.join(dir, 'sys.tar.gz'), out(), limits);
    expect(await readFile(out('out/sub/file.txt'), 'utf8')).toBe('content');
    expect(await readFile(path.join(out(), `${'x'.repeat(120)}.txt`), 'utf8')).toBe('lang');
  });
});

describe('tar extraction defenses', () => {
  it.each(['../evil.txt', 'a/../../evil.txt', '/abs/evil.txt', 'C:/evil.txt', 'a\\..\\..\\evil.txt'])('refuses the zip-slip name %j and writes nothing outside', async (name) => {
    const archive = await put('slip.tar.gz', buildTarGz([{ name: 'ok.txt', content: 'fine' }, { name, content: 'evil' }]));
    await rejects(extractTarGz(archive, out(), limits), 'ARCHIVE_UNSAFE');
    const parent = await readdir(dir);
    expect(parent).not.toContain('evil.txt');
  });

  it('refuses a symlink that points out of the folder', async () => {
    const archive = await put('link.tar.gz', buildTarGz([{ name: 'link', type: '2', linkname: '../../outside' }]));
    await rejects(extractTarGz(archive, out(), { ...limits, allowSymlinks: true }), 'ARCHIVE_UNSAFE');
  });

  it('refuses symlinks entirely unless they were allowed', async () => {
    const archive = await put('link2.tar.gz', buildTarGz([{ name: 'link', type: '2', linkname: 'target' }]));
    await rejects(extractTarGz(archive, out(), limits), 'ARCHIVE_UNSAFE');
  });

  it('refuses entries of unsupported types', async () => {
    const archive = await put('dev.tar.gz', buildTarGz([{ name: 'dev', type: '3' }]));
    await rejects(extractTarGz(archive, out(), { ...limits, allowSymlinks: true }), 'ARCHIVE_UNSAFE');
  });

  it.skipIf(process.platform === 'win32')('creates inside symlinks but never writes through them', async () => {
    const valid = await put(
      'ok.tar.gz',
      buildTarGz([
        { name: 'bin', type: '5', mode: 0o755 },
        { name: 'bin/java', content: '#!/bin/sh\n', mode: 0o755 },
        { name: 'bin/jre', type: '2', linkname: 'java' },
      ]),
    );
    await extractTarGz(valid, out('a'), { ...limits, allowSymlinks: true });
    expect((await stat(out('a/bin/java'))).mode & 0o100).toBeTruthy();
    expect((await readFile(out('a/bin/jre'), 'utf8'))).toContain('#!/bin/sh');

    const through = await put(
      'through.tar.gz',
      buildTarGz([
        { name: 'dir', type: '2', linkname: 'sub' },
        { name: 'dir/pwned.txt', content: 'x' },
      ]),
    );
    await rejects(extractTarGz(through, out('b'), { ...limits, allowSymlinks: true }), 'ARCHIVE_UNSAFE');
  });

  it('refuses hard links to unknown files and copies known ones', async () => {
    const bad = await put('hard.tar.gz', buildTarGz([{ name: 'h', type: '1', linkname: 'missing' }]));
    await rejects(extractTarGz(bad, out('a'), limits), 'ARCHIVE_UNSAFE');
    const good = await put('hard2.tar.gz', buildTarGz([{ name: 'f.txt', content: 'data' }, { name: 'h.txt', type: '1', linkname: 'f.txt' }]));
    await extractTarGz(good, out('b'), limits);
    expect(await readFile(out('b/h.txt'), 'utf8')).toBe('data');
  });

  it('enforces the byte and entry limits before writing', async () => {
    const archive = await put('big.tar.gz', buildTarGz([{ name: 'a.bin', content: Buffer.alloc(5000) }, { name: 'b.bin', content: Buffer.alloc(5000) }]));
    await rejects(extractTarGz(archive, out('a'), { maxBytes: 6000, maxEntries: 10 }), 'ARCHIVE_TOO_LARGE');
    await rejects(extractTarGz(archive, out('b'), { maxBytes: 1e9, maxEntries: 1 }), 'ARCHIVE_TOO_LARGE');
  });

  it('detects truncated, corrupt and lying archives', async () => {
    const whole = buildTarGz([{ name: 'a.bin', content: Buffer.alloc(5000, 1) }]);
    await rejects(extractTarGz(await put('trunc.tar.gz', whole.subarray(0, whole.length - 30)), out('a'), limits), 'ARCHIVE_CORRUPT');
    await rejects(extractTarGz(await put('junk.tar.gz', Buffer.from('this is not an archive')), out('b'), limits), 'ARCHIVE_CORRUPT');
    const lying = buildTarGz([{ name: 'a.bin', content: Buffer.alloc(100, 1), declaredSize: 9_000 }]);
    await rejects(extractTarGz(await put('lie.tar.gz', lying), out('c'), limits), 'ARCHIVE_CORRUPT');
  });
});

describe('zip extraction', () => {
  it('extracts stored and deflated files, folders and nested names', async () => {
    const archive = await put(
      'a.zip',
      buildZip([
        { name: 'jdk/' },
        { name: 'jdk/bin/' },
        { name: 'jdk/bin/java.exe', content: Buffer.alloc(100_000, 3) },
        { name: 'jdk/release', content: 'JAVA_VERSION="21"', stored: true },
        { name: 'jdk/empty.txt' },
      ]),
    );
    const report = await extractZip(archive, out(), limits);
    expect(report.entries).toBe(5);
    expect((await readFile(out('out/jdk/bin/java.exe'))).length).toBe(100_000);
    expect(await readFile(out('out/jdk/release'), 'utf8')).toBe('JAVA_VERSION="21"');
  });

  it.each(['../evil.txt', '/abs.txt', 'C:\\evil.txt', 'a/../../evil.txt'])('refuses the zip-slip name %j', async (name) => {
    const archive = await put('slip.zip', buildZip([{ name: 'ok.txt', content: 'x' }, { name, content: 'evil' }]));
    await rejects(extractZip(archive, out(), limits), 'ARCHIVE_UNSAFE');
    expect(await readdir(dir)).not.toContain('evil.txt');
  });

  it('refuses symlink entries, bad checksums, limits and broken files', async () => {
    await rejects(extractZip(await put('l.zip', buildZip([{ name: 'link', content: 'target', mode: 0o120777 }])), out('a'), limits), 'ARCHIVE_UNSAFE');
    await rejects(extractZip(await put('c.zip', buildZip([{ name: 'f', content: 'data', badCrc: true }])), out('b'), limits), 'ARCHIVE_CORRUPT');
    await rejects(extractZip(await put('s.zip', buildZip([{ name: 'f', content: Buffer.alloc(9000) }])), out('c'), { maxBytes: 100, maxEntries: 5 }), 'ARCHIVE_TOO_LARGE');
    await rejects(extractZip(await put('x.zip', Buffer.from('not a zip')), out('d'), limits), 'ARCHIVE_CORRUPT');
  });

  it('reads zips made by the system tar when available', async () => {
    const bsdtar = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe');
    if (process.platform !== 'win32') return;
    const source = path.join(dir, 'src');
    await mkdir(path.join(source, 'sub'), { recursive: true });
    await writeFile(path.join(source, 'sub', 'file.txt'), 'content');
    try {
      execFileSync(bsdtar, ['-a', '-cf', 'sys.zip', '-C', 'src', '.'], { cwd: dir, stdio: 'ignore' });
    } catch {
      return;
    }
    await extractZip(path.join(dir, 'sys.zip'), out(), limits);
    expect(await readFile(out('out/sub/file.txt'), 'utf8')).toBe('content');
  });
});
