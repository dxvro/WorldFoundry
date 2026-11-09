import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { lookupShasum, parseShasums, sha256Buffer, verifyIntegrity } from '../lib/checksums.mjs';

const A = 'a'.repeat(64);
const B = 'B'.repeat(64);

test('SHASUMS256.txt is read line by line', () => {
  const map = parseShasums(`${A}  node-v26.13.0-win-x64.zip\n${B}  win-x64/node.exe\r\n\n`);
  assert.equal(map.size, 2);
  assert.equal(lookupShasum(map, 'node-v26.13.0-win-x64.zip'), A);
  assert.equal(lookupShasum(map, 'win-x64/node.exe'), 'b'.repeat(64));
});

test('SHASUMS256.txt: the binary marker * is accepted, broken lines are not', () => {
  assert.equal(parseShasums(`${A} *datei.tar.gz`).get('datei.tar.gz'), A);
  assert.throws(() => parseShasums('no checksum here'), /Invalid line/);
  assert.throws(() => parseShasums(`${A.slice(1)}  zu-kurz`), /Invalid line/);
});

test('Checksum missing: error message', () => {
  assert.throws(() => lookupShasum(new Map(), 'x.zip'), /No checksum for x\.zip/);
});

test('SHA-256 of a buffer', () => {
  assert.equal(sha256Buffer(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('npm integrity: correct, wrong, several entries', () => {
  const data = Buffer.from('package');
  const good = `sha512-${createHash('sha512').update(data).digest('base64')}`;
  assert.equal(verifyIntegrity(data, good), true);
  assert.equal(verifyIntegrity(Buffer.from('different'), good), false);
  assert.equal(verifyIntegrity(data, `sha1-xxx ${good}`), true);
  assert.equal(verifyIntegrity(data, 'unknown'), false);
});
