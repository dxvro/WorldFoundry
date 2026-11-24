import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../http/errors.js';

// Minecraft shows server-icon.png from the server folder in the server list: a PNG of exactly 64 x 64 pixels.
// It is read when the server starts.
export const ICON_FILE = 'server-icon.png';
export const ICON_SIZE = 64;
export const MAX_ICON_BYTES = 256 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// width and height from the IHDR chunk, which the PNG format requires right after the signature
export function pngSize(data: Buffer): { width: number; height: number } | null {
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

export function assertValidIcon(data: Buffer): void {
  if (data.length > MAX_ICON_BYTES) throw new AppError(413, 'SERVER_ICON_TOO_LARGE', 'The server icon is too large (at most 256 KB).');
  const size = pngSize(data);
  if (size === null) throw new AppError(422, 'SERVER_ICON_INVALID', 'The server icon must be a PNG image.', undefined, { reason: 'not-png' });
  if (size.width !== ICON_SIZE || size.height !== ICON_SIZE) {
    throw new AppError(422, 'SERVER_ICON_INVALID', `The server icon must be 64 × 64 pixels (this one is ${size.width} × ${size.height}).`, undefined, {
      reason: 'size',
      width: size.width,
      height: size.height,
    });
  }
}

export async function readIcon(dir: string): Promise<Buffer | null> {
  try {
    const data = await readFile(path.join(dir, ICON_FILE));
    return pngSize(data) === null ? null : data;
  } catch {
    return null;
  }
}

// through a temporary file, so a running server never reads half an icon
export async function writeIcon(dir: string, data: Buffer): Promise<void> {
  assertValidIcon(data);
  const tmp = path.join(dir, `.${ICON_FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, data, { flag: 'wx' });
    await rename(tmp, path.join(dir, ICON_FILE));
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeIcon(dir: string): Promise<void> {
  await rm(path.join(dir, ICON_FILE), { force: true });
}
