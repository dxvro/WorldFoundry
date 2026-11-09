// Tests of the privileged updater (installer/common/updater.mjs): request validation, chain of trust, flow with rollback.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  compareSemver,
  copyRegularFile,
  createContext,
  decodeSignature,
  expectedAssetName,
  isNewerVersion,
  parseSemver,
  parseSums,
  processRequest,
  reregisterWindowsService,
  stageRequest,
  taskXml,
  validateRequest,
  verifySumsSignature,
  waitForVersion,
} from '../../installer/common/updater.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function newKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

// A complete world: installed 0.1.0 (linux-x64) with its keys, and a request for the given version in request/
async function world({ target = 'linux-x64', version = '0.2.0', installed = '0.1.0', mutate = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cm-updater-'));
  const keys = newKeys();
  const installDir = path.join(root, 'opt');
  await mkdir(path.join(installDir, 'tools'), { recursive: true });
  await writeFile(path.join(installDir, 'VERSION'), `${installed}\n`);
  await writeFile(path.join(installDir, 'version.json'), JSON.stringify({ target, version: installed }));
  await writeFile(path.join(installDir, 'tools', 'update-keys.json'), JSON.stringify({ keys: [{ id: 't', publicKey: keys.publicPem }] }));
  await writeFile(path.join(installDir, 'marker.txt'), 'old');
  const updateRoot = path.join(root, 'upd');
  const requestDir = path.join(updateRoot, 'request');
  await mkdir(requestDir, { recursive: true });
  const assetName = expectedAssetName(version, target);
  const asset = Buffer.from(`package ${version}`);
  const sums = Buffer.from(`${sha256(asset)}  ${assetName}\n`);
  const signer = mutate.signWith ?? keys;
  const files = {
    [assetName]: mutate.asset ?? asset,
    'SHA256SUMS.txt': mutate.sums ?? sums,
    'SHA256SUMS.txt.sig': mutate.sig ?? Buffer.from(`${sign(null, sums, signer.privateKey).toString('base64')}\n`),
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(requestDir, name), bytes);
  const request = { schema: 1, id: 'req-12345678', version, from: installed, assetName: mutate.assetName ?? assetName, requestedAt: 1, ...mutate.request };
  await writeFile(path.join(requestDir, 'request.json'), mutate.requestRaw ?? JSON.stringify(request));
  const logs = [];
  const ctx = createContext({
    platform: 'linux',
    updateRoot,
    installDir,
    configFile: path.join(root, 'worldfoundry.env'),
    scriptPath: path.join(HERE, '..', '..', 'installer', 'common', 'updater.mjs'),
    log: (message) => logs.push(message),
    healthTimeoutMs: 50,
  });
  const status = async () => JSON.parse(await readFile(path.join(updateRoot, 'status.json'), 'utf8'));
  return { root, ctx, keys, installDir, updateRoot, requestDir, assetName, asset, status, logs, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('Updater: version comparison matches the shared test cases', async () => {
  const cases = JSON.parse(await readFile(path.join(HERE, 'semver-cases.json'), 'utf8'));
  for (const [a, b, expected] of cases) {
    assert.equal(compareSemver(parseSemver(a), parseSemver(b)), expected, `${a} <=> ${b}`);
    assert.equal(isNewerVersion(a, b), expected > 0, `${a} > ${b}`);
  }
  assert.equal(parseSemver('1.2'), null);
  assert.equal(parseSemver('01.2.3'), null);
});

test('Updater: signature, checksums and file names', () => {
  const keys = newKeys();
  const sums = Buffer.from(`${'a'.repeat(64)}  worldfoundry-0.2.0-linux-x64.tar.gz\r\n`);
  const sig = sign(null, sums, keys.privateKey).toString('base64');
  assert.ok(verifySumsSignature(sums, sig, [{ publicKey: keys.publicPem }]));
  assert.ok(!verifySumsSignature(Buffer.concat([sums, Buffer.from('x')]), sig, [{ publicKey: keys.publicPem }]));
  assert.ok(!verifySumsSignature(sums, sig, [{ publicKey: newKeys().publicPem }]));
  assert.ok(!verifySumsSignature(sums, sig, [{ publicKey: 'not a pem' }]));
  assert.equal(decodeSignature('abc'), null);
  assert.equal(parseSums(sums.toString()).get('worldfoundry-0.2.0-linux-x64.tar.gz'), 'a'.repeat(64));
  assert.throws(() => parseSums('Nonsense'), /malformed/);
  assert.equal(expectedAssetName('1.0.0', 'win-x64'), 'worldfoundry-1.0.0-setup.exe');
  assert.equal(expectedAssetName('1.0.0', 'linux-arm64'), 'worldfoundry-1.0.0-linux-arm64.tar.gz');
  assert.equal(expectedAssetName('1.0.0', 'mac'), null);
});

test('Updater: requests are checked strictly', () => {
  const ok = { schema: 1, id: 'abcd1234', version: '0.2.0', from: '0.1.0', assetName: 'worldfoundry-0.2.0-setup.exe', requestedAt: 5 };
  assert.deepEqual(validateRequest(ok), { id: 'abcd1234', version: '0.2.0', from: '0.1.0', assetName: 'worldfoundry-0.2.0-setup.exe' });
  for (const patch of [{ schema: 2 }, { id: '../x' }, { version: 'v0.2.0' }, { version: 'x' }, { assetName: '../worldfoundry-0.2.0-setup.exe' }, { assetName: 'evil.exe' }, { requestedAt: -1 }]) {
    assert.throws(() => validateRequest({ ...ok, ...patch }), /update request/);
  }
  assert.throws(() => validateRequest(null), /invalid/);
});

test('Updater: copying with a size limit, hash over the copy and without symlinks', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cm-copy-'));
  try {
    await mkdir(path.join(dir, 'in'));
    await writeFile(path.join(dir, 'in', 'a.bin'), 'hello');
    const result = await copyRegularFile(path.join(dir, 'in'), 'a.bin', path.join(dir, 'out.bin'), 100);
    assert.deepEqual(result, { sha256: sha256('hello'), size: 5 });
    await assert.rejects(copyRegularFile(path.join(dir, 'in'), 'a.bin', path.join(dir, 'out2.bin'), 3), /larger than allowed/);
    await assert.rejects(copyRegularFile(path.join(dir, 'in'), 'missing.bin', path.join(dir, 'out3.bin'), 100), /missing/);
    await assert.rejects(copyRegularFile(path.join(dir, 'in'), 'a.bin', path.join(dir, 'out.bin'), 100), /EEXIST/);
    try {
      await symlink(path.join(dir, 'in', 'a.bin'), path.join(dir, 'in', 'link.bin'));
      await assert.rejects(copyRegularFile(path.join(dir, 'in'), 'link.bin', path.join(dir, 'out4.bin'), 100), /not a regular file/);
    } catch (error) {
      if (error?.code !== 'EPERM') throw error; // Windows without the symlink right
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Updater: a valid request is taken over into the work folder, the request folder is emptied', async () => {
  const w = await world();
  try {
    const staged = await stageRequest(w.ctx);
    assert.equal(staged.request.version, '0.2.0');
    assert.ok(staged.workDir.startsWith(path.join(w.updateRoot, 'work')));
    assert.equal(await readFile(staged.assetPath, 'utf8'), 'package 0.2.0');
    assert.deepEqual(await readdir(w.requestDir), []);
  } finally {
    await w.cleanup();
  }
});

for (const [name, options, message] of [
  ['wrong key', (w) => ({ signWith: newKeys() }), /signature/i],
  ['modified checksums', () => ({ sums: Buffer.from(`${'0'.repeat(64)}  worldfoundry-0.2.0-linux-x64.tar.gz\n`) }), /signature/i],
  ['modified package', () => ({ asset: Buffer.from('evil') }), /checksum/],
  ['missing signature', () => ({ sig: Buffer.from('') }), /signature/i],
  ['package for a different system', () => ({ assetName: 'worldfoundry-0.2.0-setup.exe' }), /does not match/],
  ['broken JSON', () => ({ requestRaw: '{not json' }), /JSON/],
]) {
  test(`Updater rejects: ${name}`, async () => {
    const w = await world({ mutate: options() });
    try {
      await assert.rejects(stageRequest(w.ctx), message);
      // the request folder is empty, nothing stays behind in the work folder
      assert.deepEqual(await readdir(w.requestDir), []);
      const work = path.join(w.updateRoot, 'work');
      assert.deepEqual(existsSync(work) ? await readdir(work) : [], []);
    } finally {
      await w.cleanup();
    }
  });
}

test('Updater rejects: same version', async () => {
  const w = await world({ version: '0.1.0', installed: '0.1.0' });
  try {
    await assert.rejects(stageRequest(w.ctx), /not newer/);
    assert.deepEqual(await readdir(w.requestDir), []);
  } finally {
    await w.cleanup();
  }
});

test('Updater: target system and version come from the installation, not from the request', async () => {
  // The request names a Windows package but Linux is installed: rejected, even if everything is correctly signed
  const w = await world({ target: 'linux-x64', mutate: { assetName: 'worldfoundry-0.2.0-setup.exe' } });
  try {
    await assert.rejects(stageRequest(w.ctx), /does not match version 0\.2\.0/);
  } finally {
    await w.cleanup();
  }
});

test('Updater: a symlink instead of the checksums is not read', async (t) => {
  const w = await world();
  try {
    await rm(path.join(w.requestDir, 'SHA256SUMS.txt'));
    try {
      await symlink(path.join(w.installDir, 'VERSION'), path.join(w.requestDir, 'SHA256SUMS.txt'));
    } catch {
      return t.skip('symlinks not allowed');
    }
    await assert.rejects(stageRequest(w.ctx), /not a regular file/);
  } finally {
    await w.cleanup();
  }
});

// ---- Flow (Linux) with simulated programs ----------------------------------------------------------------

function fakeSystem(w, { newVersion = '0.2.0', installExit = 0, newWorks = true } = {}) {
  const state = { running: '0.1.0', calls: [], restored: false };
  const run = async (command, args) => {
    state.calls.push([path.basename(command), ...args].join(' '));
    const name = path.basename(command);
    if (name === 'tar') {
      const out = args[args.indexOf('-C') + 1];
      const pkg = path.join(out, 'worldfoundry-0.2.0-linux-x64');
      await mkdir(pkg, { recursive: true });
      await writeFile(path.join(pkg, 'VERSION'), `${newVersion}\n`);
      await writeFile(path.join(pkg, 'version.json'), JSON.stringify({ target: 'linux-x64' }));
      await writeFile(path.join(pkg, 'install.sh'), '#!/bin/sh\n');
      return { code: 0, output: '' };
    }
    if (name === 'cp') {
      await cp(args[1], args[2], { recursive: true });
      if (args[2] === w.installDir) state.restored = true;
      return { code: 0, output: '' };
    }
    if (name === 'install.sh') {
      await writeFile(path.join(w.installDir, 'marker.txt'), 'new');
      if (installExit === 0 && newWorks) state.running = '0.2.0';
      else state.running = 'broken';
      return { code: installExit, output: 'installation output' };
    }
    if (name === 'systemctl' && args[0] === 'start' && state.restored) state.running = '0.1.0';
    return { code: 0, output: '' };
  };
  w.ctx.run = run;
  let tick = 0;
  w.ctx.now = () => (tick += 20);
  w.ctx.sleep = async () => undefined;
  w.ctx.fetch = async () => new Response(JSON.stringify({ status: 'ok', version: state.running }), { status: 200 });
  return state;
}

test('Updater (Linux): verifies, backs up, installs, waits for the new version and reports success', async () => {
  const w = await world();
  try {
    const state = fakeSystem(w);
    assert.equal(await processRequest(w.ctx), true);
    const status = await w.status();
    assert.equal(status.state, 'done');
    assert.equal(status.id, 'req-12345678');
    assert.match(status.message, /0\.2\.0/);
    assert.equal(await readFile(path.join(w.installDir, 'marker.txt'), 'utf8'), 'new');
    // Order: unpack, back up, only then install
    const order = state.calls.map((call) => call.split(' ')[0]);
    assert.deepEqual(order.slice(0, 3), ['tar', 'cp', 'install.sh']);
    assert.ok(state.calls[2].endsWith('--upgrade'));
    assert.ok(!existsSync(path.join(w.updateRoot, 'update.lock')));
    assert.deepEqual(existsSync(path.join(w.updateRoot, 'work')) ? await readdir(path.join(w.updateRoot, 'work')) : [], []);
  } finally {
    await w.cleanup();
  }
});

test('Updater (Linux): if the health check fails, the old version comes back', async () => {
  const w = await world();
  try {
    const state = fakeSystem(w, { newWorks: false });
    await processRequest(w.ctx);
    const status = await w.status();
    assert.equal(status.state, 'rolled-back');
    assert.match(status.message, /previous version 0\.1\.0 is running again/);
    assert.equal(await readFile(path.join(w.installDir, 'marker.txt'), 'utf8'), 'old');
    assert.ok(state.calls.some((call) => call.startsWith('systemctl stop worldfoundry.service')));
  } finally {
    await w.cleanup();
  }
});

test('Updater (Linux): if install.sh fails, it is rolled back as well', async () => {
  const w = await world();
  try {
    fakeSystem(w, { installExit: 1 });
    await processRequest(w.ctx);
    const status = await w.status();
    assert.equal(status.state, 'rolled-back');
    assert.match(status.message, /installation failed \(code 1\)/);
    assert.equal(await readFile(path.join(w.installDir, 'marker.txt'), 'utf8'), 'old');
  } finally {
    await w.cleanup();
  }
});

test('Updater (Linux): a package with the wrong version is rejected before the installation', async () => {
  const w = await world();
  try {
    const state = fakeSystem(w, { newVersion: '0.9.9' });
    await processRequest(w.ctx);
    assert.equal((await w.status()).state, 'failed');
    assert.match((await w.status()).message, /0\.2\.0 for linux-x64 was expected/);
    assert.ok(!state.calls.some((call) => call.startsWith('install.sh')));
    assert.equal(await readFile(path.join(w.installDir, 'marker.txt'), 'utf8'), 'old');
  } finally {
    await w.cleanup();
  }
});

test('Updater: a rejected request reports failed with the ID of the request and installs nothing', async () => {
  const w = await world({ mutate: { signWith: newKeys() } });
  try {
    const state = fakeSystem(w);
    await processRequest(w.ctx);
    const status = await w.status();
    assert.equal(status.state, 'failed');
    assert.equal(status.id, 'req-12345678');
    assert.match(status.message, /signature/i);
    assert.deepEqual(state.calls, []);
  } finally {
    await w.cleanup();
  }
});

test('Updater: without a request nothing happens', async () => {
  const w = await world();
  try {
    await rm(path.join(w.requestDir, 'request.json'));
    assert.equal(await processRequest(w.ctx), false);
    assert.ok(!existsSync(path.join(w.updateRoot, 'status.json')));
  } finally {
    await w.cleanup();
  }
});

test('Updater: the health check recognises the expected version and sends the token to loopback only', async () => {
  const w = await world();
  try {
    await writeFile(w.ctx.configFile, "PORT='4321'\nAUTH_TOKEN='tok-12345678'\nHOST='0.0.0.0'\n");
    const seen = [];
    w.ctx.fetch = async (url, init) => {
      seen.push([String(url), init.headers.Authorization]);
      return new Response(JSON.stringify({ status: 'ok', version: '0.2.0' }));
    };
    assert.deepEqual(await waitForVersion(w.ctx, '0.2.0'), { ok: true });
    assert.deepEqual(seen, [['http://127.0.0.1:4321/api/health', 'Bearer tok-12345678']]);
    w.ctx.fetch = async () => new Response(JSON.stringify({ status: 'ok' }));
    w.ctx.sleep = async () => undefined;
    let t = 0;
    w.ctx.now = () => (t += 40);
    const result = await waitForVersion(w.ctx, '0.2.0');
    assert.equal(result.ok, false);
  } finally {
    await w.cleanup();
  }
});

test('Updater: the health check follows the changed port from network.json, but only to addresses of this computer', async () => {
  const w = await world();
  try {
    const dataDir = path.join(path.dirname(w.ctx.configFile), 'data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(w.ctx.configFile, `PORT='3000'
HOST='0.0.0.0'
AUTH_TOKEN='tok-12345678'
DATA_DIR='${dataDir}'
`);
    const seen = [];
    w.ctx.fetch = async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ status: 'ok', version: '0.2.0' }));
    };
    await writeFile(path.join(dataDir, 'network.json'), JSON.stringify({ host: '0.0.0.0', port: 3555, probeHost: '127.0.0.1' }));
    assert.deepEqual(await waitForVersion(w.ctx, '0.2.0'), { ok: true });
    // foreign address in the file: the token does not go there, the configuration applies
    await writeFile(path.join(dataDir, 'network.json'), JSON.stringify({ host: '0.0.0.0', port: 3556, probeHost: '203.0.113.9' }));
    assert.deepEqual(await waitForVersion(w.ctx, '0.2.0'), { ok: true });
    await writeFile(path.join(dataDir, 'network.json'), 'not json');
    assert.deepEqual(await waitForVersion(w.ctx, '0.2.0'), { ok: true });
    assert.deepEqual(seen, ['http://127.0.0.1:3555/api/health', 'http://127.0.0.1:3000/api/health', 'http://127.0.0.1:3000/api/health']);
  } finally {
    await w.cleanup();
  }
});

test('Updater (Windows): the task runs as SYSTEM, paths with spaces stay intact in the arguments', () => {
  const xml = taskXml('C:\\ProgramData\\WorldFoundry Update\\work\\x\\runner\\node.exe', '"C:\\a b\\updater.mjs" install-job --job "C:\\a b\\job.json"');
  assert.match(xml, /<UserId>S-1-5-18<\/UserId>/);
  assert.match(xml, /<Command>C:\\ProgramData\\WorldFoundry Update\\work\\x\\runner\\node\.exe<\/Command>/);
  assert.match(xml, /<Arguments>&quot;C:\\a b\\updater\.mjs&quot; install-job --job &quot;C:\\a b\\job\.json&quot;<\/Arguments>/);
  assert.ok(!/<(Time|Calendar|Boot|Logon)Trigger/.test(xml), 'no automatic triggers');
});

test('Updater (Windows): the hand-over to the Task Scheduler creates a copy and starts the task once', async () => {
  const w = await world({ target: 'win-x64' });
  try {
    await mkdir(path.join(w.installDir, 'node'), { recursive: true });
    await writeFile(path.join(w.installDir, 'node', 'node.exe'), 'node');
    const calls = [];
    w.ctx.platform = 'win32';
    w.ctx.run = async (command, args) => {
      calls.push([path.basename(command).toLowerCase(), ...args]);
      return { code: 0, output: '' };
    };
    await processRequest(w.ctx);
    const names = calls.map((call) => `${call[0]} ${call[1]}`);
    assert.ok(names.includes('schtasks.exe /Create'));
    assert.ok(names.includes('schtasks.exe /Run'));
    const job = JSON.parse(await readFile(path.join(w.updateRoot, 'work', 'req-12345678', 'job.json'), 'utf8'));
    assert.equal(job.version, '0.2.0');
    assert.equal(job.from, '0.1.0');
    assert.ok(job.setup.endsWith('worldfoundry-0.2.0-setup.exe'));
    assert.ok(existsSync(path.join(w.updateRoot, 'work', 'req-12345678', 'runner', 'node.exe')));
    assert.ok(existsSync(path.join(w.updateRoot, 'work', 'req-12345678', 'runner', 'updater.mjs')));
    // the lock stays with the task, and so do the work files
    assert.ok(existsSync(path.join(w.updateRoot, 'update.lock')));
  } finally {
    await w.cleanup();
  }
});

test('Windows installer: rights with NT SERVICE\\worldfoundry are only set after the services are registered (icacls 1332)', async () => {
  const iss = (await readFile(new URL('../../installer/windows/worldfoundry.iss', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const steps = iss.slice(iss.indexOf('procedure CurStepChanged'));
  const order = ['RegisterService;', 'RegisterUpdater;', 'PrepareUpdateFolders;', 'SecureFolderAndFiles;', 'CreateConfig;', 'SecureConfigFiles;'].map((name) => steps.indexOf(name));
  assert.ok(order.every((index) => index > 0), 'all steps occur in CurStepChanged');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'registration before all icacls calls with the service account');
  // no icacls call with the service account bypasses RunIcacls (retry on 1332)
  assert.ok(!/RunTool\(Icacls/.test(iss));
});

const TOOL = path.join(os.tmpdir(), 'tool.exe');
const ACCOUNT = ['NT SERVICE', 'worldfoundry'].join(String.fromCharCode(92));

test('Windows: no WinSW command "refresh" (only exists in WinSW 3, the package ships 2.12)', async () => {
  const iss = await readFile(new URL('../../installer/windows/worldfoundry.iss', import.meta.url), 'utf8');
  const updater = await readFile(new URL('../../installer/common/updater.mjs', import.meta.url), 'utf8');
  assert.ok(!/'refresh'/.test(iss) && !/'refresh'/.test(updater));
  // Order in the installer: remove, wait until the service is gone, only then register again
  const reregister = iss.slice(iss.indexOf('function ReregisterService'), iss.indexOf('procedure RegisterService'));
  const order = ["'uninstall'", 'WaitForServiceGone(Name)', 'InstallServiceWithRetry(Tool)'].map((text) => reregister.indexOf(text));
  assert.ok(order.every((index) => index > 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('Updater (Windows): the service is registered again with a wait (marked for deletion, install fails at first)', async () => {
  const w = await world({ target: 'win-x64' });
  try {
    const calls = [];
    let queries = 0;
    let installs = 0;
    w.ctx.sleep = async () => undefined;
    w.ctx.run = async (command, args) => {
      const name = path.basename(command).toLowerCase();
      calls.push(`${name} ${args.join(' ')}`);
      if (name === 'sc.exe' && args[0] === 'query') return { code: ++queries <= 3 ? 0 : 1060, output: '' };
      if (name === 'tool.exe' && args[0] === 'install') return { code: ++installs < 3 ? -1 : 0, output: '' };
      return { code: 0, output: '' };
    };
    assert.equal(await reregisterWindowsService(w.ctx, TOOL, 'worldfoundry', ACCOUNT), true);
    const steps = calls.map((call) => call.replace(/\s+$/, ''));
    assert.deepEqual(steps.filter((c) => !c.startsWith('sc.exe query')), [
      'net.exe stop worldfoundry',
      'tool.exe uninstall',
      'tool.exe install',
      'tool.exe install',
      'tool.exe install',
      `sc.exe config worldfoundry obj= ${ACCOUNT}`,
    ]);
    assert.ok(calls.indexOf('tool.exe uninstall') < calls.lastIndexOf('sc.exe query worldfoundry'));
    assert.ok(!calls.some((call) => call.includes('refresh')));
  } finally {
    await w.cleanup();
  }
});

test('Updater (Windows): if the service is missing, it is only registered', async () => {
  const w = await world({ target: 'win-x64' });
  try {
    const calls = [];
    w.ctx.sleep = async () => undefined;
    w.ctx.run = async (command, args) => {
      calls.push(`${path.basename(command).toLowerCase()} ${args.join(' ')}`);
      return { code: args[0] === 'query' ? 1060 : 0, output: '' };
    };
    assert.equal(await reregisterWindowsService(w.ctx, TOOL, 'worldfoundry-updater', 'LocalSystem'), true);
    assert.ok(!calls.some((call) => call.startsWith('tool.exe uninstall')));
    assert.ok(calls.includes('tool.exe install') && calls.includes('sc.exe config worldfoundry-updater obj= LocalSystem'));
  } finally {
    await w.cleanup();
  }
});
