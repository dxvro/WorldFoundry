import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { parseHostHeader } from '../http/host.js';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

// src/config and dist/config share the same depth: <backend>/<src|dist>/config
export const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// the repository root when the code runs from a checkout (<repo>/packages/backend)
export const REPO_ROOT = path.resolve(CODE_ROOT, '..', '..');

const APP_DIR_NAME = 'WorldFoundry';

export function isRepoLayout(codeRoot: string = CODE_ROOT): boolean {
  const repo = path.resolve(codeRoot, '..', '..');
  return path.join(repo, 'packages', 'backend') === codeRoot && existsSync(path.join(repo, 'package.json'));
}

// Base for default data folders and for relative paths: the checkout itself, otherwise a per-user folder
export function defaultHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, codeRoot: string = CODE_ROOT): string {
  if (isRepoLayout(codeRoot)) return path.resolve(codeRoot, '..', '..');
  const home = os.homedir();
  let base: string;
  let lowerCase = false;
  if (platform === 'win32') base = env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local');
  else if (platform === 'darwin') base = path.join(home, 'Library', 'Application Support');
  else {
    base = env['XDG_DATA_HOME'] ?? path.join(home, '.local', 'share');
    lowerCase = true;
  }
  return path.join(base, lowerCase ? APP_DIR_NAME.toLowerCase() : APP_DIR_NAME);
}

// built frontend next to the backend (<root>/frontend/dist), independent of the working directory
export const defaultFrontendDir = (codeRoot: string = CODE_ROOT): string => path.resolve(codeRoot, '..', 'frontend', 'dist');

export const DEFAULT_UPDATE_REPO = 'dxvro/WorldFoundry';
export const UPDATE_CHANNELS = ['stable', 'prerelease'] as const;

// Largest world archive accepted for an import (IMPORT_MAX_MB): 256 GB by default, 1 TB at most. The free disk
// space is the real guard; the limit only keeps absurd uploads out. Sizes beyond 4 GiB are fine everywhere in the
// import path (ZIP64, tar PAX/base-256 sizes, plain numbers).
export const DEFAULT_IMPORT_MAX_MB = 262_144;
export const IMPORT_MAX_MB_LIMIT = 1_048_576;

const nonEmpty = (value: unknown): unknown => (value === '' ? undefined : value);

const booleanText = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;
    const text = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'ja', 'on'].includes(text)) return true;
    if (['false', '0', 'no', 'nein', 'off'].includes(text)) return false;
    return value;
  },
  z.boolean({ message: 'must be true or false' }),
);

const envSchema = z.object({
  HOST: z.preprocess(nonEmpty, z.string().min(1).default('0.0.0.0')),
  PORT: z.preprocess(nonEmpty, z.coerce.number().int().min(1).max(65535).default(3000)),
  CONFIG_FILE: z.preprocess(nonEmpty, z.string().min(1).optional()),
  DATA_DIR: z.preprocess(nonEmpty, z.string().min(1).optional()),
  SERVERS_DIR: z.preprocess(nonEmpty, z.string().min(1).optional()),
  FRONTEND_DIR: z.preprocess(nonEmpty, z.string().min(1).optional()),
  LOG_LEVEL: z.preprocess(nonEmpty, z.enum(LOG_LEVELS).default('info')),
  MODRINTH_USER_AGENT: z.preprocess(nonEmpty, z.string().min(3).max(200).optional()),
  STEAMCMD_PATH: z.preprocess(nonEmpty, z.string().min(1).max(1024).optional()),
  AUTH_TOKEN: z.preprocess(nonEmpty, z.string().min(8, 'at least 8 characters').max(200).optional()),
  ALLOWED_ORIGINS: z.preprocess(nonEmpty, z.string().optional()),
  ALLOWED_HOSTS: z.preprocess(nonEmpty, z.string().optional()),
  STOP_TIMEOUT_SECONDS: z.preprocess(nonEmpty, z.coerce.number().int().min(5).max(3600).default(120)),
  JAVA_AUTO_INSTALL: z.preprocess(nonEmpty, booleanText.default(true)),
  MOD_BACKUP_KEEP: z.preprocess(nonEmpty, z.coerce.number().int().min(1).max(100).default(3)),
  UPDATE_CHECK: z.preprocess(nonEmpty, booleanText.default(true)),
  UPDATE_REPO: z.preprocess(nonEmpty, z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, 'must have the form owner/repository').default(DEFAULT_UPDATE_REPO)),
  UPDATE_CHANNEL: z.preprocess(nonEmpty, z.enum(UPDATE_CHANNELS).default('stable')),
  UPDATE_COUNTDOWN_SECONDS: z.preprocess(nonEmpty, z.coerce.number().int().min(0).max(600).default(60)),
  UPDATE_DIR: z.preprocess(nonEmpty, z.string().min(1).optional()),
  UPDATE_API_BASE: z.preprocess(nonEmpty, z.url().optional()),
  IMPORT_MAX_MB: z.preprocess(nonEmpty, z.coerce.number().int().min(16).max(IMPORT_MAX_MB_LIMIT).default(DEFAULT_IMPORT_MAX_MB)),
});

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  serversDir: string;
  // built frontend; undefined disables static serving (the API-only embedder case)
  frontendDir?: string;
  // the env file that was (or would be) read at start, resolved from CONFIG_FILE
  configFile?: string;
  logLevel: (typeof LOG_LEVELS)[number];
  modrinthUserAgent?: string;
  authToken?: string;
  // an existing steamcmd(.sh|.exe); without it WorldFoundry downloads SteamCMD into the data folder
  steamcmdPath?: string;
  allowedOrigins: string[];
  allowedHosts: string[];
  stopTimeoutMs: number;
  // install a managed Eclipse Temurin when the server needs a Java version that is missing
  javaAutoInstall: boolean;
  // backups per project that stay in <mods|plugins>_backup after updates
  modBackupKeep: number;
  // self-update: check GitHub releases (UPDATE_CHECK), which repository, which channel
  updateCheck: boolean;
  updateRepo: string;
  updateChannel: (typeof UPDATE_CHANNELS)[number];
  // default countdown (seconds) before running servers are stopped for an update
  updateCountdownSeconds: number;
  // folder of the privileged updater (status.json, request/); only set by the service installations
  updateDir?: string;
  // test builds only (see update/test-build.ts); ignored otherwise
  updateApiBase?: string;
  // largest accepted world archive upload, in MB (IMPORT_MAX_MB)
  importMaxMb?: number;
}

export class ConfigError extends Error {}

function parseOrigins(raw: string | undefined): string[] {
  const origins: string[] = [];
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    try {
      origins.push(new URL(trimmed).origin);
    } catch {
      throw new ConfigError(`Invalid configuration:
  - ALLOWED_ORIGINS: "${trimmed}" is not a valid address (e.g. http://localhost:5173)`);
    }
  }
  return origins;
}

function parseHosts(raw: string | undefined): string[] {
  const hosts: string[] = [];
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const hostname = parseHostHeader(trimmed);
    if (hostname === null) {
      throw new ConfigError(`Invalid configuration:
  - ALLOWED_HOSTS: "${trimmed}" is not a valid host name (e.g. craft.example.lan)`);
    }
    hosts.push(hostname);
  }
  return hosts;
}

// CONFIG_FILE comes from the real environment only (it cannot live in the file it names)
export function resolveConfigFile(source: NodeJS.ProcessEnv = process.env): { file: string; explicit: boolean } {
  const given = source['CONFIG_FILE'];
  if (given !== undefined && given.trim() !== '') return { file: path.resolve(given.trim()), explicit: true };
  return { file: path.join(defaultHome(source), '.env'), explicit: false };
}

export interface LoadOptions {
  codeRoot?: string;
  platform?: NodeJS.Platform;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env, options: LoadOptions = {}): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const env = parsed.data;
  const codeRoot = options.codeRoot ?? CODE_ROOT;
  const home = defaultHome(source, options.platform ?? process.platform, codeRoot);
  const configFile = env.CONFIG_FILE === undefined ? undefined : path.resolve(env.CONFIG_FILE);
  // relative paths are relative to the env file when one is named, otherwise to the default home
  const base = configFile === undefined ? home : path.dirname(configFile);
  return {
    host: env.HOST,
    port: env.PORT,
    dataDir: path.resolve(base, env.DATA_DIR ?? path.join(home, 'data')),
    serversDir: path.resolve(base, env.SERVERS_DIR ?? path.join(home, 'servers')),
    frontendDir: path.resolve(base, env.FRONTEND_DIR ?? defaultFrontendDir(codeRoot)),
    ...(configFile === undefined ? {} : { configFile }),
    logLevel: env.LOG_LEVEL,
    ...(env.MODRINTH_USER_AGENT === undefined ? {} : { modrinthUserAgent: env.MODRINTH_USER_AGENT }),
    ...(env.AUTH_TOKEN === undefined ? {} : { authToken: env.AUTH_TOKEN }),
    ...(env.STEAMCMD_PATH === undefined ? {} : { steamcmdPath: path.resolve(home, env.STEAMCMD_PATH) }),
    allowedOrigins: parseOrigins(env.ALLOWED_ORIGINS),
    allowedHosts: parseHosts(env.ALLOWED_HOSTS),
    stopTimeoutMs: env.STOP_TIMEOUT_SECONDS * 1000,
    javaAutoInstall: env.JAVA_AUTO_INSTALL,
    modBackupKeep: env.MOD_BACKUP_KEEP,
    updateCheck: env.UPDATE_CHECK,
    updateRepo: env.UPDATE_REPO,
    updateChannel: env.UPDATE_CHANNEL,
    updateCountdownSeconds: env.UPDATE_COUNTDOWN_SECONDS,
    ...(env.UPDATE_DIR === undefined ? {} : { updateDir: path.resolve(base, env.UPDATE_DIR) }),
    ...(env.UPDATE_API_BASE === undefined ? {} : { updateApiBase: env.UPDATE_API_BASE }),
    importMaxMb: env.IMPORT_MAX_MB,
  };
}

// Reads the env file into `target` without overriding variables that are already set. A missing default
// file is normal (everything has defaults); a CONFIG_FILE that does not exist is a configuration error.
export function loadDotEnv(target: NodeJS.ProcessEnv = process.env): string | null {
  const { file, explicit } = resolveConfigFile(target);
  if (!existsSync(file)) {
    if (explicit) throw new ConfigError(`Invalid configuration:\n  - CONFIG_FILE: The file "${file}" was not found.`);
    return null;
  }
  let values: Record<string, string>;
  try {
    values = parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
  } catch {
    throw new ConfigError(`Invalid configuration:\n  - CONFIG_FILE: The file "${file}" could not be read.`);
  }
  for (const [key, value] of Object.entries(values)) {
    if (target[key] === undefined && key !== 'CONFIG_FILE') target[key] = value;
  }
  return file;
}
