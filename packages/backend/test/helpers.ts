import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import type { AppConfig } from '../src/config/env.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { TEST_ROOT_ENV } from './global-setup.js';
import type { NewMod, NewServer } from '../src/db/schema.js';

// libsql's close() does not release the Windows file handle until the native object is
// garbage collected, so tests force a GC before deleting the temp dir.
v8.setFlagsFromString('--expose-gc');
const forceGc = vm.runInNewContext('gc') as () => void;

// Best effort: after a failed statement libsql may keep the file locked until the worker
// exits; the global teardown removes whatever is left.
async function removeDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    forceGc();
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
export interface TestDb extends DbHandle {
  dir: string;
  cleanup: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const dir = await mkdtemp(path.join(process.env[TEST_ROOT_ENV] ?? os.tmpdir(), 'case-'));
  const handle = await openDb(path.join(dir, 'test.db'));
  await runMigrations(handle.db);
  return {
    ...handle,
    dir,
    cleanup: async () => {
      handle.close();
      await removeDir(dir);
    },
  };
}

export const testConfig = (dir: string): AppConfig => ({
  host: '127.0.0.1',
  port: 3999,
  dataDir: path.join(dir, 'data'),
  serversDir: path.join(dir, 'servers'),
  logLevel: 'silent',
  allowedOrigins: [],
  allowedHosts: [],
  stopTimeoutMs: 60_000,
  javaAutoInstall: false,
  modBackupKeep: 3,
  updateCheck: false,
  updateRepo: 'owner/repo',
  updateChannel: 'stable',
  updateCountdownSeconds: 0,
});

export const serverRow = (id: string, overrides: Partial<NewServer> = {}): NewServer => ({
  id,
  name: `Server ${id}`,
  loader: 'fabric',
  mcVersion: '1.21.1',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

export const modRow = (id: string, serverId: string, overrides: Partial<NewMod> = {}): NewMod => ({
  id,
  serverId,
  source: 'modrinth',
  projectId: `project-${id}`,
  name: `Mod ${id}`,
  fileName: `${id}.jar`,
  sha512: `sha-${id}`,
  sizeBytes: 123,
  installedAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});




