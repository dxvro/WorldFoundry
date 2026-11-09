#!/usr/bin/env node
// Generates an Ed25519 key pair for release signatures.
//   node scripts/update-keygen.mjs --out private.pem
// The private key (PKCS8 PEM) is written to the file (never overwritten) and belongs in the GitHub settings as the secret
// UPDATE_SIGNING_KEY, NOT in the repository. The public key is printed and goes into
// packages/backend/src/update/keys.ts.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { out: { type: 'string' }, 'pub-out': { type: 'string' } }, strict: true });
if (values.out === undefined) {
  console.error('Usage: node scripts/update-keygen.mjs --out private.pem');
  process.exit(2);
}
if (existsSync(values.out)) {
  console.error(`Error: ${values.out} already exists and will not be overwritten.`);
  process.exit(1);
}
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync(values.out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
if (values['pub-out'] !== undefined) writeFileSync(values['pub-out'], publicKey.export({ type: 'spki', format: 'pem' }));
console.log(`Private key: ${values.out} (keep it secret, store it as the secret UPDATE_SIGNING_KEY)`);
console.log('Public key (add it to keys.ts):\n');
console.log(publicKey.export({ type: 'spki', format: 'pem' }));
