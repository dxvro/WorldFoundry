import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assertAllowedUrl } from '../lib/download.mjs';
import { collectFrontendPackages, formatNotices } from '../lib/notices.mjs';
import { machineMatches, readMachine } from '../lib/native.mjs';
import { WINSW } from '../lib/pins.mjs';
import { findNonAsciiPaths, isPrunableDirName, lockEntry, npmPlatformFlags, pruneNodeModules } from '../lib/stage.mjs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { getTarget, TARGET_NAMES, unitForTarget } from '../lib/targets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('Download: https only and allowed hosts only (redirects too)', () => {
  assert.doesNotThrow(() => assertAllowedUrl('https://nodejs.org/dist/index.json', ['nodejs.org']));
  assert.doesNotThrow(() => assertAllowedUrl('https://release-assets.githubusercontent.com/x', ['github.com', 'githubusercontent.com']));
  assert.throws(() => assertAllowedUrl('http://nodejs.org/dist/index.json', ['nodejs.org']), /Only https/);
  assert.throws(() => assertAllowedUrl('https://evil.example.com/node.zip', ['nodejs.org']), /not allowed/);
  assert.throws(() => assertAllowedUrl('https://nodejs.org.evil.com/x', ['nodejs.org']), /not allowed/);
  assert.throws(() => assertAllowedUrl('https://notnodejs.org/x', ['nodejs.org']), /not allowed/);
});

test('Native library: ELF and PE headers', () => {
  const elf = Buffer.alloc(64);
  elf.write('\x7fELF', 0, 'latin1');
  elf[5] = 1;
  elf.writeUInt16LE(0xb7, 18);
  assert.deepEqual(readMachine(elf), { format: 'elf', value: 0xb7 });
  assert.equal(machineMatches(readMachine(elf), getTarget('linux-arm64').machine), true);
  assert.equal(machineMatches(readMachine(elf), getTarget('linux-x64').machine), false);

  const pe = Buffer.alloc(256);
  pe.write('MZ', 0, 'latin1');
  pe.writeUInt32LE(0x80, 0x3c);
  pe.writeUInt32LE(0x00004550, 0x80);
  pe.writeUInt16LE(0x8664, 0x84);
  assert.equal(machineMatches(readMachine(pe), getTarget('win-x64').machine), true);
  assert.equal(readMachine(Buffer.from('nothing')), null);
});

test('npm platform options for the target system', () => {
  assert.deepEqual(npmPlatformFlags(getTarget('linux-arm64')), ['--os=linux', '--cpu=arm64', '--libc=glibc']);
  assert.deepEqual(npmPlatformFlags(getTarget('win-x64')), ['--os=win32', '--cpu=x64']);
});

test('package-lock.json contains the libsql platform package with a checksum for every target', async () => {
  const lock = JSON.parse(await readFile(path.join(ROOT, 'package-lock.json'), 'utf8'));
  for (const name of TARGET_NAMES) {
    const entry = lockEntry(lock, getTarget(name).libsql);
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
    assert.match(entry.integrity, /^sha512-/);
  }
  assert.throws(() => lockEntry(lock, '@libsql/does-not-exist'), /package-lock\.json/);
});

test('WinSW is pinned: version, https, SHA-256', () => {
  assert.match(WINSW.version, /^\d+\.\d+\.\d+$/);
  assert.match(WINSW.url, /^https:\/\/github\.com\/winsw\/winsw\/releases\/download\/v/);
  assert.match(WINSW.sha256, /^[0-9a-f]{64}$/);
  assert.ok(WINSW.url.includes(WINSW.version));
});

test('Notices file: lists components and license texts', () => {
  const text = formatNotices({
    productName: 'Test',
    packages: [
      { name: 'zod', version: '4.0.0', license: 'MIT', text: 'MIT text' },
      { name: 'without', version: '1', license: 'ISC', text: '' },
    ],
    extras: [{ name: 'Node.js', version: 'v26.13.0', license: 'MIT', text: 'Node license' }],
  });
  for (const part of ['zod 4.0.0 (MIT)', 'MIT text', 'Node license', 'Eclipse Temurin', 'does not ship a license text']) assert.ok(text.includes(part), part);
});

test('Notices file: contains the bundled frontend dependencies', async () => {
  const names = (await collectFrontendPackages(ROOT)).map((item) => item.name);
  for (const name of ['react', 'react-dom', 'scheduler', 'lucide-react', '@fontsource-variable/geist']) assert.ok(names.includes(name), name);
});

test('License: the repository ships the GPL-3.0 text', async () => {
  const text = await readFile(path.join(ROOT, 'LICENSE'), 'utf8');
  assert.match(text, /GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
  for (const file of ['package.json', 'packages/backend/package.json', 'packages/frontend/package.json']) {
    assert.equal(JSON.parse(await readFile(path.join(ROOT, file), 'utf8')).license, 'GPL-3.0-only', file);
  }
});

test('Scripts: syntax check with bash -n', (t) => {
  if (spawnSync('bash', ['--version']).status !== 0) return t.skip('bash not available');
  for (const file of ['install.sh', 'uninstall.sh']) {
    const result = spawnSync('bash', ['-n', path.join(ROOT, 'installer', 'linux', file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

test('Service configuration: WinSW settings for a clean shutdown', async () => {
  const xml = (await readFile(path.join(ROOT, 'installer', 'windows', 'worldfoundry-service.xml'), 'utf8')).replace(/\r\n/g, '\n');
  const seconds = Number(/<stoptimeout>(\d+) sec<\/stoptimeout>/.exec(xml)?.[1]);
  assert.ok(seconds >= 160, `stoptimeout ${seconds}`);
  assert.match(xml, /<stopparentprocessfirst>true<\/stopparentprocessfirst>/);
  assert.match(xml, /@DATADIR@\\worldfoundry\.env/);
  assert.ok(!/[^\x00-\x7f]/.test(xml), 'ASCII only, because the installer edits the file as ANSI');
});

test('systemd unit: shutdown and hardening', async () => {
  const unit = (await readFile(path.join(ROOT, 'installer', 'linux', 'worldfoundry.service'), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(unit, /^TimeoutStopSec=180$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^KillMode=mixed$/m);
  assert.ok(!/^MemoryDenyWriteExecute=(true|yes)/m.test(unit), 'MemoryDenyWriteExecute would break Java');
  assert.match(unit, /^NoNewPrivileges=true$/m);
  // SteamCMD is a 32-bit program; "native" alone kills it with SIGSYS (exit code 159, "Bad system call")
  assert.match(unit, /^SystemCallArchitectures=native x86$/m);
  assert.equal(unitForTarget(unit, getTarget('linux-x64')), unit);
  const arm = unitForTarget(unit, getTarget('linux-arm64'));
  assert.match(arm, /^SystemCallArchitectures=native$/m);
  assert.doesNotMatch(arm, /native x86/);
});

test('node_modules: test folders are removed, special characters in paths are found', async () => {
  assert.equal(isPrunableDirName('test'), true);
  assert.equal(isPrunableDirName('dist'), false);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cm-prune-'));
  try {
    await mkdir(path.join(dir, 'package', 'test', 'fixtures', 'snow ☃'), { recursive: true });
    await mkdir(path.join(dir, 'package', 'lib'), { recursive: true });
    await writeFile(path.join(dir, 'package', 'lib', 'index.js'), '');
    assert.deepEqual((await findNonAsciiPaths(dir)).length, 1);
    assert.equal(await pruneNodeModules(dir), 1);
    assert.deepEqual(await findNonAsciiPaths(dir), []);
    assert.ok((await readFile(path.join(dir, 'package', 'lib', 'index.js'), 'utf8')) === '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Test machine deployment: valid bash, a target is required, the first install opens the firewall', async () => {
  const script = path.join(ROOT, 'scripts', 'deploy-vm.sh');
  const check = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
  if (check.error === undefined) assert.equal(check.status, 0, check.stderr);
  const missing = spawnSync('bash', [script], { encoding: 'utf8' });
  if (missing.error === undefined) {
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /deploy-vm\.sh <user@host>/);
  }
  const text = await readFile(script, 'utf8');
  assert.match(text, /if \[ -d \/opt\/worldfoundry \]; then FIRST=''; else FIRST='--open-firewall'; fi/);
  assert.match(text, /ssh -t /, 'sudo needs a terminal on the remote side');
  // no address of any particular machine is written into the script
  assert.doesNotMatch(text, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
});
