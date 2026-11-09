// Files for the self-update in the package: the privileged updater, the trusted keys and
// (for the CI test only) the marker for test packages.
import { createPublicKey } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// The public keys are in the source code of the application (packages/backend/src/update/keys.ts)
export function parseEmbeddedKeys(source) {
  const keys = [];
  const pattern = /id:\s*'([^']+)',\s*publicKey:\s*`(-----BEGIN PUBLIC KEY-----[^`]*-----END PUBLIC KEY-----\s*)`/g;
  for (const match of source.matchAll(pattern)) keys.push({ id: match[1], publicKey: match[2].replace(/\r\n/g, '\n') });
  for (const key of keys) {
    if (createPublicKey(key.publicKey).asymmetricKeyType !== 'ed25519') throw new Error(`Key ${key.id} is not an Ed25519 key.`);
  }
  if (keys.length === 0) throw new Error('No public key found in keys.ts.');
  return keys;
}

export async function readEmbeddedKeys(root) {
  return parseEmbeddedKeys(await readFile(path.join(root, 'packages', 'backend', 'src', 'update', 'keys.ts'), 'utf8'));
}

export async function writeUpdateFiles({ root, outDir, options, log }) {
  const tools = path.join(outDir, 'tools');
  await mkdir(tools, { recursive: true });
  await cp(path.join(root, 'installer', 'common', 'updater.mjs'), path.join(tools, 'updater.mjs'));
  const keys = await readEmbeddedKeys(root);
  if (options.testUpdateApi !== null) {
    const pem = (await readFile(path.resolve(options.testUpdateKey), 'utf8')).replace(/\r\n/g, '\n');
    if (createPublicKey(pem).asymmetricKeyType !== 'ed25519') throw new Error('--test-update-key must be a public Ed25519 key.');
    const testKey = { id: 'ci-test', publicKey: pem };
    keys.push(testKey);
    await writeFile(path.join(tools, 'update-test.json'), `${JSON.stringify({ apiBase: options.testUpdateApi, trustedKeys: [testKey] }, null, 2)}\n`);
    log(`  TEST PACKAGE: update source ${options.testUpdateApi} and test key allowed (not for production use!)`);
  }
  await writeFile(path.join(tools, 'update-keys.json'), `${JSON.stringify({ keys }, null, 2)}\n`);
  log(`  Update keys in the package: ${keys.map((key) => key.id).join(', ')}`);
}
