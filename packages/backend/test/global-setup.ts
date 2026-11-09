import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const TEST_ROOT_ENV = 'WORLDFOUNDRY_TEST_ROOT';

export async function setup(): Promise<void> {
  process.env[TEST_ROOT_ENV] = await mkdtemp(path.join(os.tmpdir(), 'worldfoundry-tests-'));
}

// Runs after all workers have exited, when Windows has released every SQLite file handle.
export async function teardown(): Promise<void> {
  const root = process.env[TEST_ROOT_ENV];
  if (root === undefined) return;
  await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
}
