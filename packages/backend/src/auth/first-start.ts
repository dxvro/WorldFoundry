import { chmod, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/client.js';
import { generatePassword, hashPassword, type ScryptCost } from './password.js';
import { PasswordStore } from './store.js';

export const INITIAL_PASSWORD_FILE = 'initial-password.txt';

export interface InitialPassword {
  password: string;
  // where the password was written for whoever missed it in the log
  file: string;
}

export interface FirstStartOptions {
  db: Db;
  dataDir: string;
  // AUTH_TOKEN of the configuration: when set, it is the first sign-in and nothing is generated
  authToken: string | undefined;
  cost?: ScryptCost;
  generate?: () => string;
}

// WorldFoundry never runs without a sign-in. A start that finds neither an AUTH_TOKEN nor a stored password creates
// a random password, stores its hash, and leaves the plain text in a file only the owner of the data folder can read.
// Returns null when a sign-in already exists.
export async function ensureInitialPassword(options: FirstStartOptions): Promise<InitialPassword | null> {
  if (options.authToken !== undefined) return null;
  const store = new PasswordStore(options.db);
  if ((await store.load()) !== null) return null;

  const password = (options.generate ?? generatePassword)();
  const file = path.join(options.dataDir, INITIAL_PASSWORD_FILE);
  // the file first: a password that is stored but written nowhere would lock everyone out
  await writeFile(
    file,
    `WorldFoundry: password for the first sign-in\n\n  ${password}\n\nSet your own password under System > Password; this file is deleted then.\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  // mode is ignored for a file that already existed
  await chmod(file, 0o600).catch(() => undefined);
  await store.save(await hashPassword(password, options.cost));
  return { password, file };
}

// The initial password stops being valid as soon as another one is set; its file must not outlive it.
export async function removeInitialPasswordFile(dataDir: string): Promise<void> {
  await rm(path.join(dataDir, INITIAL_PASSWORD_FILE), { force: true });
}
