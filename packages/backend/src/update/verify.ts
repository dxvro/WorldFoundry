import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { AppError } from '../http/errors.js';
import type { TrustedKey } from './keys.js';

export const SUMS_NAME = 'SHA256SUMS.txt';
export const SIGNATURE_NAME = 'SHA256SUMS.txt.sig';
export const MAX_SUMS_BYTES = 64 * 1024;
export const MAX_SIGNATURE_BYTES = 1024;

// "<64 hex>  <name>" per line (also "*name" for binary mode); CRLF is tolerated
export function parseSha256Sums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(trimmed);
    if (match === null) throw new AppError(502, 'UPDATE_SUMS_INVALID', 'The checksum file of the release is malformed.');
    const name = (match[2] as string).trim();
    // the same name twice with different hashes would let an attacker choose which line wins
    const hash = (match[1] as string).toLowerCase();
    if (map.has(name) && map.get(name) !== hash) throw new AppError(502, 'UPDATE_SUMS_INVALID', 'The checksum file of the release is contradictory.');
    map.set(name, hash);
  }
  return map;
}

function loadKeys(keys: readonly TrustedKey[]): KeyObject[] {
  const result: KeyObject[] = [];
  for (const key of keys) {
    try {
      const object = createPublicKey(key.publicKey);
      if (object.asymmetricKeyType === 'ed25519') result.push(object);
    } catch {
      // an unusable key never verifies anything
    }
  }
  return result;
}

// The .sig file holds the base64 text of the 64-byte Ed25519 signature over the exact bytes of SHA256SUMS.txt
export function decodeSignature(text: string): Buffer | null {
  const compact = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  const bytes = Buffer.from(compact, 'base64');
  return bytes.length === 64 ? bytes : null;
}

export function verifySumsSignature(sums: Buffer, signatureText: string, keys: readonly TrustedKey[]): boolean {
  const signature = decodeSignature(signatureText);
  if (signature === null) return false;
  return loadKeys(keys).some((key) => {
    try {
      return cryptoVerify(null, sums, key, signature);
    } catch {
      return false;
    }
  });
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export interface VerifyInput {
  sums: Buffer;
  signature: string;
  keys: readonly TrustedKey[];
  assetName: string;
  assetSha256: string;
}

// Order matters: first the signature of the sums, only then are the sums believed, then the hash of the asset.
export function verifyRelease(input: VerifyInput): void {
  if (!verifySumsSignature(input.sums, input.signature, input.keys)) {
    throw new AppError(502, 'UPDATE_SIGNATURE_INVALID', 'The signature of the release is invalid. The update was rejected for security reasons.');
  }
  const expected = parseSha256Sums(input.sums.toString('utf8')).get(input.assetName);
  if (expected === undefined) {
    throw new AppError(502, 'UPDATE_SUMS_INVALID', `"${input.assetName}" is not listed in the signed checksums.`, undefined, { asset: input.assetName });
  }
  if (expected !== input.assetSha256.toLowerCase()) {
    throw new AppError(502, 'UPDATE_HASH_MISMATCH', 'The downloaded file does not match the signed checksum. The update was rejected.');
  }
}
