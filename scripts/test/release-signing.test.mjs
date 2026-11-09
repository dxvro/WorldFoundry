// Signing the releases (scripts/sign-release.mjs) and update files in the package (scripts/lib/update-files.mjs)
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main as signMain, normalizePem, signSums } from '../sign-release.mjs';
import { parseEmbeddedKeys, readEmbeddedKeys, writeUpdateFiles } from '../lib/update-files.mjs';
import { parseArgs } from '../lib/targets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

async function temp(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cm-sign-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('Signing: the signature is Ed25519 over the exact bytes and verifiable', () => {
  const { privatePem, publicPem } = keypair();
  const sums = Buffer.from('abc  file\r\n');
  const { signature } = signSums(sums, privatePem);
  assert.equal(signature.length, 64);
  assert.ok(verify(null, sums, createPublicKey(publicPem), signature));
  assert.ok(!verify(null, Buffer.from('abc  file\n'), createPublicKey(publicPem), signature));
});

test('Signing: secrets without line breaks become a valid PEM again', () => {
  const { privatePem } = keypair();
  const flat = privatePem.replace(/\n/g, ' ');
  assert.equal(normalizePem(flat), privatePem);
  assert.throws(() => normalizePem('not a key'), /not a PEM/);
  assert.throws(() => signSums(Buffer.from('x'), generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' })), /Ed25519/);
});

test('Signing: without a key the script aborts (no release without a signature)', async () => {
  await temp(async (dir) => {
    await writeFile(path.join(dir, 'SHA256SUMS.txt'), 'x');
    const saved = process.env.UPDATE_SIGNING_KEY;
    delete process.env.UPDATE_SIGNING_KEY;
    try {
      await assert.rejects(signMain(['--sums', path.join(dir, 'SHA256SUMS.txt')]), /UPDATE_SIGNING_KEY is not set/);
      process.env.UPDATE_SIGNING_KEY = '  ';
      await assert.rejects(signMain(['--sums', path.join(dir, 'SHA256SUMS.txt')]), /not set/);
    } finally {
      if (saved !== undefined) process.env.UPDATE_SIGNING_KEY = saved;
    }
  });
});

test('Signing: a key that is not in keys.ts is rejected', async () => {
  await temp(async (dir) => {
    const { privatePem } = keypair();
    await writeFile(path.join(dir, 'SHA256SUMS.txt'), 'x  y\n');
    await writeFile(path.join(dir, 'private.pem'), privatePem);
    await assert.rejects(signMain(['--sums', path.join(dir, 'SHA256SUMS.txt'), '--key-file', path.join(dir, 'private.pem')]), /keys\.ts/);
  });
});

test('Signing: with --trusted-pub a .sig is created that the test key verifies', async () => {
  await temp(async (dir) => {
    const { privatePem, publicPem } = keypair();
    const sums = path.join(dir, 'SHA256SUMS.txt');
    await writeFile(sums, 'x  y\n');
    await writeFile(path.join(dir, 'private.pem'), privatePem);
    await writeFile(path.join(dir, 'public.pem'), publicPem);
    await signMain(['--sums', sums, '--key-file', path.join(dir, 'private.pem'), '--trusted-pub', path.join(dir, 'public.pem')]);
    const sig = Buffer.from((await readFile(`${sums}.sig`, 'utf8')).trim(), 'base64');
    assert.ok(verify(null, await readFile(sums), createPublicKey(publicPem), sig));
  });
});

test('Keys: keys.ts contains valid Ed25519 keys that go into the package', async () => {
  const keys = await readEmbeddedKeys(ROOT);
  assert.ok(keys.length >= 1);
  for (const key of keys) assert.equal(createPublicKey(key.publicKey).asymmetricKeyType, 'ed25519');
  assert.throws(() => parseEmbeddedKeys('export const x = 1;'), /No public key/);
});

test('Package: updater and keys are in tools/, the test marker only on request', async () => {
  await temp(async (dir) => {
    const logs = [];
    const options = parseArgs(['--target', 'linux-x64']);
    await writeUpdateFiles({ root: ROOT, outDir: path.join(dir, 'prod'), options, log: (line) => logs.push(line) });
    const prod = await readFile(path.join(dir, 'prod', 'tools', 'update-keys.json'), 'utf8');
    assert.equal(JSON.parse(prod).keys.length, (await readEmbeddedKeys(ROOT)).length);
    await assert.rejects(readFile(path.join(dir, 'prod', 'tools', 'update-test.json')), /ENOENT/);
    assert.ok((await readFile(path.join(dir, 'prod', 'tools', 'updater.mjs'), 'utf8')).includes('privileged updater'));

    const { publicPem } = keypair();
    await writeFile(path.join(dir, 'test-key.pem'), publicPem);
    const testOptions = parseArgs(['--target', 'linux-x64', '--test-update-api', 'http://127.0.0.1:4599', '--test-update-key', path.join(dir, 'test-key.pem')]);
    await writeUpdateFiles({ root: ROOT, outDir: path.join(dir, 'ci'), options: testOptions, log: (line) => logs.push(line) });
    const marker = JSON.parse(await readFile(path.join(dir, 'ci', 'tools', 'update-test.json'), 'utf8'));
    assert.equal(marker.apiBase, 'http://127.0.0.1:4599');
    assert.equal(marker.trustedKeys[0].publicKey, publicPem);
    const ciKeys = JSON.parse(await readFile(path.join(dir, 'ci', 'tools', 'update-keys.json'), 'utf8')).keys;
    assert.ok(ciKeys.some((key) => key.id === 'ci-test'));
    assert.ok(logs.some((line) => line.includes('TEST PACKAGE')));
  });
});

test('Package: options for the test version and test source', () => {
  assert.equal(parseArgs(['--target', 'linux-x64', '--version-override', '0.1.1']).versionOverride, '0.1.1');
  assert.throws(() => parseArgs(['--target', 'linux-x64', '--version-override', 'new']), /version like 0\.1\.1/);
  assert.throws(() => parseArgs(['--target', 'linux-x64', '--test-update-api', 'http://127.0.0.1:1']), /belong together/);
});

test('Installer: update files are included, units are not bound to the application', async () => {
  const read = async (...parts) => (await readFile(path.join(ROOT, 'installer', ...parts), 'utf8')).replace(/\r\n/g, '\n');
  const service = await read('linux', 'worldfoundry-update.service');
  assert.match(service, /^Type=oneshot$/m);
  assert.ok(!/^(BindsTo|PartOf|Requires|Requisite|Wants)=.*worldfoundry\.service/m.test(service), 'must not depend on worldfoundry.service');
  assert.match(await read('linux', 'worldfoundry-update.path'), /^PathExists=\/var\/lib\/worldfoundry-update\/request\/request\.json$/m);
  const app = await read('linux', 'worldfoundry.service');
  assert.match(app, /^Environment=UPDATE_DIR=\/var\/lib\/worldfoundry-update$/m);
  assert.match(app, /^ReadWritePaths=\/var\/lib\/worldfoundry \/var\/lib\/worldfoundry-update\/request$/m);
  const install = await read('linux', 'install.sh');
  assert.match(install, /--upgrade/);
  assert.match(install, /install -d -o root -g root -m 0755 "\$UPDATE_ROOT"/);
  const xml = await read('windows', 'worldfoundry-updater-service.xml');
  assert.ok(!/[^\x00-\x7f]/.test(xml), 'ASCII only');
  assert.match(xml, /<id>worldfoundry-updater<\/id>/);
  assert.match(xml, /updater\.mjs" watch/);
  assert.match(await read('windows', 'worldfoundry-service.xml'), /UPDATE_DIR" value="@UPDATEROOT@"/);
  const iss = await read('windows', 'worldfoundry.iss');
  assert.match(iss, /RegisterUpdater/);
  assert.match(iss, /PrepareUpdateFolders/);
  assert.ok(iss.includes("\work\" /inheritance:r"));
});
