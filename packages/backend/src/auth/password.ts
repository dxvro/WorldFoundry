import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Passwords are stored as a scrypt record: "scrypt$N$r$p$<salt base64>$<hash base64>". The cost parameters travel
// with the record, so they can be raised later without invalidating existing passwords.
export interface ScryptCost {
  N: number;
  r: number;
  p: number;
}

export const DEFAULT_COST: ScryptCost = { N: 2 ** 15, r: 8, p: 1 };
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
// limits for records read from the database, so a damaged value cannot ask for gigabytes of memory
const MAX_N = 2 ** 17;
const MAX_R = 16;
const MAX_P = 4;

const derive = (password: string, salt: Buffer, cost: ScryptCost): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    // scrypt needs 128 * N * r bytes; the default limit of Node is exactly too small for N = 2^15, r = 8
    const maxmem = 128 * cost.N * cost.r + 128 * cost.r * cost.p + 8 * 1024 * 1024;
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N: cost.N, r: cost.r, p: cost.p, maxmem }, (error, key) => (error === null ? resolve(key) : reject(error)));
  });

export async function hashPassword(password: string, cost: ScryptCost = DEFAULT_COST): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, cost);
  return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

interface ParsedRecord {
  cost: ScryptCost;
  salt: Buffer;
  hash: Buffer;
}

export function parseRecord(record: string): ParsedRecord | null {
  const parts = record.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const validCost = Number.isInteger(N) && N >= 2 && N <= MAX_N && (N & (N - 1)) === 0 && Number.isInteger(r) && r >= 1 && r <= MAX_R && Number.isInteger(p) && p >= 1 && p <= MAX_P;
  if (!validCost) return null;
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const hash = Buffer.from(parts[5] ?? '', 'base64');
  if (salt.length < 8 || hash.length !== KEY_LENGTH) return null;
  return { cost: { N, r, p }, salt, hash };
}

// false for a wrong password and for a damaged record alike
export async function verifyPassword(password: string, record: string): Promise<boolean> {
  const parsed = parseRecord(record);
  if (parsed === null) return false;
  try {
    const key = await derive(password, parsed.salt, parsed.cost);
    return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
  } catch {
    return false;
  }
}

// German message when the new password is not acceptable, otherwise null
export function validateNewPassword(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `The password must be at least ${PASSWORD_MIN_LENGTH} characters long.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `The password must be at most ${PASSWORD_MAX_LENGTH} characters long.`;
  if (new Set(password).size < 4) return 'The password is too simple: it should contain at least four different characters.';
  return null;
}

// A readable random password without look-alike characters (0/O, 1/l/I), for the reset command
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generatePassword(length = 16): string {
  const limit = 256 - (256 % ALPHABET.length);
  let result = '';
  while (result.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < limit && result.length < length) result += ALPHABET[byte % ALPHABET.length];
    }
  }
  return result;
}
