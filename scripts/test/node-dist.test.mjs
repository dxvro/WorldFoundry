import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readTarGz, writeTarGz } from '../lib/archive.mjs';
import { nodeArchiveEntries, nodeBinaryMode, nodeDistUrl, selectLts, writeExecutable } from '../lib/node-dist.mjs';
import { getTarget } from '../lib/targets.mjs';

const INDEX = [
  { version: 'v27.0.0-alpha.1', lts: false },
  { version: 'v26.13.0', lts: 'Lithium' },
  { version: 'v26.12.1', lts: false },
  { version: 'v24.20.1', lts: 'Krypton' },
  { version: 'v24.9.0', lts: 'Krypton' },
];

test('LTS: newest version with an LTS name', () => {
  assert.equal(selectLts(INDEX), 'v26.13.0');
  assert.equal(selectLts([...INDEX].reverse()), 'v26.13.0');
});

test('LTS: version comparison is numeric, not textual', () => {
  assert.equal(selectLts([{ version: 'v22.9.0', lts: 'Jod' }, { version: 'v22.10.0', lts: 'Jod' }]), 'v22.10.0');
});

test('LTS: error on an empty or wrong index', () => {
  assert.throws(() => selectLts([{ version: 'v27.0.0', lts: false }]), /No LTS version/);
  assert.throws(() => selectLts({}), /Unexpected format/);
});

test('Addresses and archive paths', () => {
  assert.equal(nodeDistUrl('v26.13.0', 'SHASUMS256.txt'), 'https://nodejs.org/dist/v26.13.0/SHASUMS256.txt');
  assert.deepEqual(nodeArchiveEntries('v26.13.0', getTarget('win-x64')), {
    binary: 'node-v26.13.0-win-x64/node.exe',
    license: 'node-v26.13.0-win-x64/LICENSE',
  });
  assert.equal(nodeArchiveEntries('v26.13.0', getTarget('linux-arm64')).binary, 'node-v26.13.0-linux-arm64/bin/node');
});

test('Node executable: permissions', () => {
  const linux = getTarget('linux-x64');
  assert.equal(nodeBinaryMode(0o755, linux), 0o755);
  assert.equal(nodeBinaryMode(0o644, linux), 0o755);
  assert.equal(nodeBinaryMode(0o4755, linux), 0o755);
  assert.equal(nodeBinaryMode(0, getTarget('win-x64')), 0o755);
});

test('Node executable: the execute bit is kept (tar round trip, not on Windows)', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cm-node-'));
  try {
    const tarFile = path.join(dir, 'node.tar.gz');
    const target = getTarget('linux-x64');
    const wanted = nodeArchiveEntries('v26.13.0', target);
    await writeTarGz(tarFile, [{ path: wanted.binary, type: 'file', mode: 0o755, data: Buffer.from('#!/bin/sh\necho ok\n') }], 1_700_000_000);
    const entry = (await readTarGz(tarFile)).find((e) => e.path === wanted.binary);
    const out = path.join(dir, 'node');
    await writeExecutable(out, entry.data, nodeBinaryMode(entry.mode, target));
    assert.equal((await stat(out)).mode & 0o777, 0o755);
    const run = spawnSync(out, [], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.equal(run.stdout.trim(), 'ok');
    // without the permission fix (old bug) the start would have failed with EACCES
    const plain = path.join(dir, 'plain');
    await writeFile(plain, entry.data, { mode: 0o644 });
    assert.equal(spawnSync(plain, []).error?.code, 'EACCES');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
