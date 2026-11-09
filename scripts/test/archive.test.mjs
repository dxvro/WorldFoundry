import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { parseTar, parseZip, readTarGz, readZip, tarChunks, writeTarGz, writeZip } from '../lib/archive.mjs';

let dir;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cm-archive-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const longDir = `worldfoundry-0.1.0-linux-x64/app/node_modules/${'very-long-folder-name-'.repeat(4)}/dist/${'x'.repeat(40)}`;
const entries = () => [
  { path: 'pkg', type: 'dir', mode: 0o755 },
  { path: 'pkg/install.sh', type: 'file', mode: 0o755, data: Buffer.from('#!/bin/sh\necho hi\n') },
  { path: 'pkg/readme.txt', type: 'file', mode: 0o644, data: Buffer.from('Grüße') },
  { path: 'pkg/empty.txt', type: 'file', mode: 0o644, data: Buffer.alloc(0) },
  { path: `${longDir}/file-with-long-path.js`, type: 'file', mode: 0o644, data: Buffer.from('lang') },
  { path: 'pkg/größe/ä.txt', type: 'file', mode: 0o644, data: Buffer.from('umlaut') },
  { path: 'pkg/large.bin', type: 'file', mode: 0o644, data: Buffer.alloc(100_000, 7) },
];

test('tar: round trip with permissions, long paths and umlauts', async () => {
  const file = path.join(dir, 'a.tar.gz');
  await writeTarGz(file, entries(), 1_700_000_000);
  const read = await readTarGz(file);
  const byPath = new Map(read.map((e) => [e.path, e]));
  assert.equal(byPath.get('pkg/').type, 'dir');
  assert.equal(byPath.get('pkg/install.sh').mode & 0o777, 0o755);
  assert.equal(byPath.get('pkg/readme.txt').mode & 0o777, 0o644);
  assert.equal(byPath.get('pkg/readme.txt').data.toString('utf8'), 'Grüße');
  assert.equal(byPath.get(`${longDir}/file-with-long-path.js`).data.toString(), 'lang');
  assert.equal(byPath.get('pkg/größe/ä.txt').data.toString(), 'umlaut');
  assert.equal(byPath.get('pkg/large.bin').data.length, 100_000);
  assert.equal(byPath.get('pkg/empty.txt').data.length, 0);
});

test('tar: output is reproducible (same input, same bytes)', async () => {
  const collect = async () => {
    const chunks = [];
    for await (const chunk of tarChunks(entries(), 1_700_000_000)) chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  assert.deepEqual(await collect(), await collect());
});

test('tar: the system tar reads the archive and shows execute permissions', async (t) => {
  if (spawnSync('tar', ['--version']).status !== 0) return t.skip('no tar available');
  const file = path.join(dir, 'b.tar.gz');
  await writeTarGz(file, entries(), 1_700_000_000);
  const listing = spawnSync('tar', ['-tvzf', path.basename(file)], { encoding: 'utf8', cwd: dir });
  assert.equal(listing.status, 0, listing.stderr);
  const line = listing.stdout.split('\n').find((l) => l.trim().endsWith('pkg/install.sh'));
  assert.match(line, /^-rwxr-xr-x/);
  assert.match(listing.stdout, /file-with-long-path\.js/);
});

test('tar: empty input gives no entries', () => {
  assert.deepEqual(parseTar(Buffer.alloc(1024)), []);
});

test('zip: round trip with permissions and content', async () => {
  const file = path.join(dir, 'a.zip');
  await writeZip(file, entries());
  const read = await readZip(file);
  const byPath = new Map(read.map((e) => [e.path, e]));
  assert.equal(byPath.get('pkg/').type, 'dir');
  assert.equal(byPath.get('pkg/install.sh').mode & 0o777, 0o755);
  assert.equal(byPath.get('pkg/readme.txt').data.toString('utf8'), 'Grüße');
  assert.equal(byPath.get('pkg/large.bin').data.length, 100_000);
  assert.equal(byPath.get('pkg/empty.txt').data.length, 0);
  assert.equal(byPath.get('pkg/größe/ä.txt').data.toString(), 'umlaut');
});

test('zip: the system tar (bsdtar) reads the archive', async (t) => {
  const file = path.join(dir, 'c.zip');
  await writeZip(file, entries());
  // on Windows bsdtar from System32 (reads ZIP); the tar from Git Bash cannot
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const attempt = spawnSync(tar, ['-tf', path.basename(file)], { encoding: 'utf8', cwd: dir });
  if (attempt.status !== 0) return t.skip('no ZIP-capable tar available');
  assert.match(attempt.stdout, /pkg\/install\.sh/);
});

test('zip: an invalid file is rejected', () => {
  assert.throws(() => parseZip(Buffer.from('not a zip')), /Not a valid ZIP/);
});

test('Files from disk are read', async () => {
  const file = path.join(dir, 'd.bin');
  await writeFile(file, 'x');
  const out = path.join(dir, 'd.tar.gz');
  await writeTarGz(out, [{ path: 'd.bin', type: 'file', mode: 0o644, file }], 0);
  assert.equal((await readTarGz(out))[0].data.toString(), 'x');
});
