#!/usr/bin/env node
// Signs SHA256SUMS.txt with Ed25519 (Node crypto) and verifies the result immediately.
//
//   UPDATE_SIGNING_KEY="$(cat private.pem)" node scripts/sign-release.mjs --sums dist/SHA256SUMS.txt
//   node scripts/sign-release.mjs --sums SHA256SUMS.txt --key-file private.pem --out SHA256SUMS.txt.sig
//
// The private key (PKCS8 PEM) comes from the environment variable UPDATE_SIGNING_KEY (GitHub Actions secret) or
// from --key-file. Without a key the script aborts so that a release without a signature can never be created. The
// matching public key must be in packages/backend/src/update/keys.ts, otherwise no client could accept the release
// (--trusted-pub replaces this check with a different key, e.g. in the CI test).
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readEmbeddedKeys } from './lib/update-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Secrets sometimes lose their line breaks when pasted; the PEM structure is restored
export function normalizePem(text) {
  const match = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(text.trim());
  if (match === null) throw new Error('The key is not a PEM (-----BEGIN PRIVATE KEY-----).');
  const body = match[2].replace(/\s+/g, '');
  return `-----BEGIN ${match[1]}-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END ${match[1]}-----\n`;
}

export function signSums(sums, privatePem) {
  const privateKey = createPrivateKey(normalizePem(privatePem));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The signing key must be an Ed25519 key.');
  const signature = sign(null, sums, privateKey);
  const publicKey = createPublicKey(privateKey);
  if (!verify(null, sums, publicKey, signature)) throw new Error('The generated signature could not be verified.');
  return { signature, publicPem: publicKey.export({ type: 'spki', format: 'pem' }) };
}

const spkiOf = (pem) => createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64');

export async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { sums: { type: 'string' }, out: { type: 'string' }, 'key-file': { type: 'string' }, 'trusted-pub': { type: 'string' } },
    strict: true,
  });
  if (values.sums === undefined) throw new Error('--sums <file> is missing.');
  const privatePem = values['key-file'] === undefined ? process.env.UPDATE_SIGNING_KEY : await readFile(values['key-file'], 'utf8');
  if (privatePem === undefined || privatePem.trim() === '') {
    throw new Error('No signing key: the secret UPDATE_SIGNING_KEY is not set (or --key-file is missing). No release is published without a signature.');
  }
  const sums = await readFile(values.sums);
  if (sums.length === 0) throw new Error('SHA256SUMS.txt is empty.');
  const { signature, publicPem } = signSums(sums, privatePem);
  const trusted = values['trusted-pub'] === undefined ? (await readEmbeddedKeys(ROOT)).map((key) => key.publicKey) : [await readFile(values['trusted-pub'], 'utf8')];
  if (!trusted.some((pem) => spkiOf(pem) === spkiOf(publicPem))) {
    throw new Error('The signing key does not belong to any public key in packages/backend/src/update/keys.ts. Clients would reject the release.');
  }
  const out = values.out ?? `${values.sums}.sig`;
  await writeFile(out, `${signature.toString('base64')}\n`);
  console.log(`Signature written: ${out}`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
