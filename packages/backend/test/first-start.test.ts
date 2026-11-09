import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INITIAL_PASSWORD_FILE, ensureInitialPassword, removeInitialPasswordFile } from '../src/auth/first-start.js';
import { verifyPassword } from '../src/auth/password.js';
import { PasswordStore } from '../src/auth/store.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

const cost = { N: 2 ** 4, r: 8, p: 1 };
let dir: string;
let handle: DbHandle;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wf-first-start-'));
  handle = await openDb(path.join(dir, 'worldfoundry.db'));
  await runMigrations(handle.db);
});
afterEach(async () => {
  handle.close();
  await rm(dir, { recursive: true, force: true });
});

const run = (authToken?: string) => ensureInitialPassword({ db: handle.db, dataDir: dir, authToken, cost });

describe('first start', () => {
  it('creates a password when there is neither a token nor a password, stores only its hash and writes it to a private file', async () => {
    const result = await run();
    expect(result?.password).toMatch(/^[A-Za-z0-9]{16}$/);
    const record = await new PasswordStore(handle.db).load();
    expect(record).not.toBeNull();
    expect(record).not.toContain(result?.password);
    expect(await verifyPassword(result?.password ?? '', record ?? '')).toBe(true);
    expect(result?.file).toBe(path.join(dir, INITIAL_PASSWORD_FILE));
    expect(await readFile(path.join(dir, INITIAL_PASSWORD_FILE), 'utf8')).toContain(result?.password);
    if (process.platform !== 'win32') expect((await stat(path.join(dir, INITIAL_PASSWORD_FILE))).mode & 0o777).toBe(0o600);
  });

  it('does nothing on every later start', async () => {
    const first = await run();
    const record = await new PasswordStore(handle.db).load();
    expect(await run()).toBeNull();
    expect(await new PasswordStore(handle.db).load()).toBe(record);
    expect(await readFile(path.join(dir, INITIAL_PASSWORD_FILE), 'utf8')).toContain(first?.password);
  });

  it('does nothing when AUTH_TOKEN is the sign-in', async () => {
    expect(await run('a-long-token')).toBeNull();
    expect(await new PasswordStore(handle.db).load()).toBeNull();
    await expect(stat(path.join(dir, INITIAL_PASSWORD_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('tightens the permissions of a file that was already there', async () => {
    if (process.platform === 'win32') return;
    await writeFile(path.join(dir, INITIAL_PASSWORD_FILE), 'old', { mode: 0o644 });
    await run();
    expect((await stat(path.join(dir, INITIAL_PASSWORD_FILE))).mode & 0o777).toBe(0o600);
  });

  it('removes the file once another password is set, and does not mind when it is gone already', async () => {
    await run();
    await removeInitialPasswordFile(dir);
    await expect(stat(path.join(dir, INITIAL_PASSWORD_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(removeInitialPasswordFile(dir)).resolves.toBeUndefined();
  });
});
