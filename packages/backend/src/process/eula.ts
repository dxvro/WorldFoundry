import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { rethrowFsError } from '../mods/fs-errors.js';

export const EULA_FILE = 'eula.txt';
export const EULA_URL = 'https://aka.ms/MinecraftEULA';

// only ever called after the user explicitly accepted the EULA for this server
export async function writeEulaFile(serverDir: string, accepted: boolean): Promise<void> {
  const text = `#By changing the setting below to TRUE you are indicating your agreement to our EULA (${EULA_URL}).\neula=${accepted}\n`;
  try {
    await writeFile(path.join(serverDir, EULA_FILE), text, 'utf8');
  } catch (error) {
    rethrowFsError(error, EULA_FILE);
  }
}

// withdrawing the consent must not leave eula=true behind
export async function withdrawEulaFile(serverDir: string): Promise<void> {
  let current: string;
  try {
    current = await readFile(path.join(serverDir, EULA_FILE), 'utf8');
  } catch {
    return;
  }
  if (/^\s*eula\s*=\s*true\s*$/im.test(current)) await writeEulaFile(serverDir, false);
}
