// The contract between the unprivileged application and the privileged updater (installer/common/updater.mjs).
//
//   <UPDATE_DIR>/request/        written by the application: the payload files and request.json (last, atomically)
//   <UPDATE_DIR>/status.json     written ONLY by the updater (root / SYSTEM); the application only reads it
//
// The updater never trusts anything in request/: it copies the files into a location the application cannot
// write, verifies signature and hash again there, and takes its own decisions (target, version, paths) itself.
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { SIGNATURE_NAME, SUMS_NAME } from './verify.js';

export const REQUEST_DIR_NAME = 'request';
export const REQUEST_FILE = 'request.json';
export const STATUS_FILE = 'status.json';
export const PROTOCOL_SCHEMA = 1;

// worldfoundry-<version>-setup.exe | worldfoundry-<version>-linux-x64.tar.gz | ...-linux-arm64.tar.gz
export const ASSET_NAME_PATTERN = /^worldfoundry-[0-9A-Za-z][0-9A-Za-z.+-]{0,60}-(?:setup\.exe|linux-(?:x64|arm64)\.tar\.gz)$/;

export const requestSchema = z.object({
  schema: z.literal(PROTOCOL_SCHEMA),
  id: z.string().min(8).max(64),
  version: z.string().min(1).max(64),
  from: z.string().min(1).max(64),
  assetName: z.string().regex(ASSET_NAME_PATTERN),
  requestedAt: z.number().int().nonnegative(),
});
export type UpdateRequest = z.infer<typeof requestSchema>;

export const STATUS_STATES = ['received', 'verifying', 'installing', 'health-check', 'done', 'failed', 'rolled-back'] as const;
export type UpdaterState = (typeof STATUS_STATES)[number];

export const statusSchema = z.object({
  schema: z.literal(PROTOCOL_SCHEMA),
  id: z.string().max(64),
  state: z.enum(STATUS_STATES),
  version: z.string().max(64),
  from: z.string().max(64),
  message: z.string().max(2000),
  updatedAt: z.number().int().nonnegative(),
});
export type UpdaterStatus = z.infer<typeof statusSchema>;

export const isTerminalState = (state: UpdaterState): boolean => state === 'done' || state === 'failed' || state === 'rolled-back';

export const requestDirOf = (updateDir: string): string => path.join(updateDir, REQUEST_DIR_NAME);

export function newRequest(version: string, from: string, assetName: string, now: number): UpdateRequest {
  return { schema: PROTOCOL_SCHEMA, id: randomUUID(), version, from, assetName, requestedAt: now };
}

export async function readStatus(updateDir: string): Promise<UpdaterStatus | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(updateDir, STATUS_FILE), 'utf8')) as unknown;
    const parsed = statusSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface StagedFiles {
  asset: string;
  sums: string;
  signature: string;
}

// Copies the verified files into the request folder and writes request.json last (atomically), so the updater
// (path unit / watcher) never sees a half-written request.
export async function submitRequest(requestDir: string, request: UpdateRequest, staged: StagedFiles): Promise<void> {
  await mkdir(requestDir, { recursive: true });
  await clearRequestDir(requestDir);
  await copyFile(staged.asset, path.join(requestDir, request.assetName));
  await copyFile(staged.sums, path.join(requestDir, SUMS_NAME));
  await copyFile(staged.signature, path.join(requestDir, SIGNATURE_NAME));
  const temp = path.join(requestDir, `.${REQUEST_FILE}.${process.pid}.tmp`);
  await writeFile(temp, `${JSON.stringify(request)}\n`, { mode: 0o640 });
  await rename(temp, path.join(requestDir, REQUEST_FILE));
}

export async function clearRequestDir(requestDir: string): Promise<void> {
  const names = [REQUEST_FILE, SUMS_NAME, SIGNATURE_NAME];
  let entries: string[] = [];
  try {
    entries = await readdir(requestDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (names.includes(entry) || ASSET_NAME_PATTERN.test(entry) || entry.startsWith(`.${REQUEST_FILE}.`)) {
      await rm(path.join(requestDir, entry), { force: true }).catch(() => undefined);
    }
  }
}
