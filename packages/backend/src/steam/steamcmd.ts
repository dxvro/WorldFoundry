import { access, chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { extractTarGz } from '../archive/tar.js';
import { extractZip } from '../archive/zip.js';
import { AppError } from '../http/errors.js';
import type { InstallerRunner } from '../installer/runner.js';
import { KeyedLock } from '../lib/keyed-lock.js';
import { downloadToTmp } from '../mods/downloader.js';
import { msg, type Msg } from '../messages.js';

// SteamCMD is Valve's command-line client for dedicated servers. WorldFoundry downloads it from Valve into its data
// folder on first use (or uses STEAMCMD_PATH) and always logs in anonymously: no Steam account is ever involved.
export const STEAMCMD_DOWNLOAD = {
  linux: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz',
  win32: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip',
} as const;
const DOWNLOAD_HOSTS = ['steamcdn-a.akamaihd.net'];
// SteamCMD reads steam_dev.cfg next to itself. By default it keeps few HTTP/2 connections to the first content server
// it picks; when that one is slow from the user's line (measured: 1 MB/s from one CDN node on a 80 MB/s line), a big
// server like ARK takes hours. These settings let it open more connections and try more servers (measured: 11 -> 26 MB/s).
// Written once into the SteamCMD that WorldFoundry manages and never over a file that already exists.
export const STEAM_DEV_CFG_NAME = 'steam_dev.cfg';
export const STEAM_DEV_CFG = [
  '@nClientDownloadEnableHTTP2PlatformLinux 0',
  '@fDownloadRateImprovementToAddAnotherConnection 1.0',
  '@cMaxInitialDownloadSources 15',
  '',
].join('\n');
// SteamCMD updates itself and the game files; a big game can take long on a slow line
const RUN_TIMEOUT_MS = 3 * 60 * 60_000;
const BRANCH = /^[A-Za-z0-9_.-]{1,80}$/;

export type SteamStep = 'download' | 'preallocate' | 'verify' | 'commit' | 'other';

export interface SteamProgress {
  percent: number | null;
  line: string;
  step: SteamStep;
  doneBytes: number | null;
  totalBytes: number | null;
  // measured over the last seconds while downloading; null before there is enough to measure
  bytesPerSecond: number | null;
}

export interface AppUpdateRequest {
  appId: number;
  // Steam beta branch; 'public' is the default branch
  branch: string;
  dir: string;
  validate: boolean;
  signal: AbortSignal;
  onLine: (line: string) => void;
  onProgress: (progress: SteamProgress) => void;
  // download the files of another platform (ARK: Survival Ascended ships Windows binaries only)
  platformType?: 'windows' | 'linux';
}

export interface SteamCmdOptions {
  // <dataDir>/steamcmd
  dir: string;
  runner: InstallerRunner;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  // an existing steamcmd(.sh|.exe); WorldFoundry then downloads nothing
  configuredPath?: string;
  timeoutMs?: number;
}

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

// "Update state (0x61) downloading, progress: 45.12 (1234 / 5678)"
const PROGRESS = /Update state \(0x[0-9a-f]+\) ([a-z ,]+), progress: (\d{1,3}(?:\.\d+)?) \((?:(\d+) \/ (\d+)\))?/i;

export function parseProgress(line: string): number | null {
  return parseSteamLine(line)?.percent ?? null;
}

// " Update state (0x61) downloading, progress: 45.12 (1234 / 5678)" -> step, percent and bytes
export function parseSteamLine(line: string): { step: SteamStep; percent: number; doneBytes: number | null; totalBytes: number | null } | null {
  const match = PROGRESS.exec(line);
  if (match?.[2] === undefined) return null;
  const value = Number(match[2]);
  if (!Number.isFinite(value)) return null;
  const state = (match[1] ?? '').toLowerCase();
  const step: SteamStep = state.includes('downloading') ? 'download' : state.includes('preallocating') ? 'preallocate' : state.includes('verifying') ? 'verify' : state.includes('committing') ? 'commit' : 'other';
  const done = match[3] === undefined ? null : Number(match[3]);
  // "(0 / 0)" while SteamCMD is still looking at the depots: nothing known yet
  const total = match[4] === undefined || Number(match[4]) === 0 ? null : Number(match[4]);
  return { step, percent: Math.min(100, Math.max(0, value)), doneBytes: done, totalBytes: total };
}

const SPEED_WINDOW_MS = 10_000;

// Download speed over a sliding window of the byte counts SteamCMD prints (about every two seconds)
export class SpeedMeter {
  private samples: Array<{ at: number; bytes: number }> = [];

  constructor(private readonly now: () => number = Date.now) {}

  // the speed after this sample; null until two samples lie at least a second apart
  add(bytes: number): number | null {
    const at = this.now();
    const last = this.samples.at(-1);
    // a new phase or file list starts from fewer bytes: measure afresh
    if (last !== undefined && bytes < last.bytes) this.samples = [];
    this.samples.push({ at, bytes });
    while (this.samples.length > 2 && at - (this.samples[1]?.at ?? at) >= SPEED_WINDOW_MS) this.samples.shift();
    const first = this.samples[0];
    if (first === undefined || at - first.at < 1000) return null;
    return ((bytes - first.bytes) * 1000) / (at - first.at);
  }

  reset(): void {
    this.samples = [];
  }
}

const unitText = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
};

// The install step text of a SteamCMD progress line, with amounts and the measured speed
export function steamProgressMessage(game: string, progress: SteamProgress): Msg {
  if (progress.totalBytes === null) return msg('INSTALL_STEP_STEAM_DOWNLOAD', { game, done: '0 B', total: '?', speed: '' });
  const done = progress.doneBytes === null ? '?' : unitText(progress.doneBytes);
  const total = progress.totalBytes === null ? '?' : unitText(progress.totalBytes);
  switch (progress.step) {
    case 'preallocate':
      return msg('INSTALL_STEP_STEAM_PREALLOCATE', { game, total });
    case 'verify':
      return msg('INSTALL_STEP_STEAM_VERIFY', { game, done, total });
    case 'commit':
      return msg('INSTALL_STEP_STEAM_COMMIT', { game, done, total });
    default:
      return msg('INSTALL_STEP_STEAM_DOWNLOAD', { game, done, total, speed: progress.bytesPerSecond === null ? '' : `${unitText(progress.bytesPerSecond)}/s` });
  }
}

export const successLine = (appId: number): RegExp => new RegExp(String.raw`Success! App '${appId}' (?:fully installed|already up to date)`);

export function buildAppUpdateArgs(appId: number, branch: string, dir: string, validate: boolean, platformType?: 'windows' | 'linux'): string[] {
  if (!BRANCH.test(branch) || branch.startsWith('-')) throw new AppError(422, 'STEAM_BRANCH_INVALID', 'The Steam branch name is invalid.');
  // force_install_dir must come before the login (https://github.com/ValveSoftware/steam-for-linux/issues/8298)
  return [
    ...(platformType === undefined ? [] : ['+@sSteamCmdForcePlatformType', platformType]),
    '+force_install_dir',
    path.resolve(dir),
    '+login',
    'anonymous',
    '+app_update',
    String(appId),
    ...(branch === 'public' ? [] : ['-beta', branch]),
    ...(validate ? ['validate'] : []),
    '+quit',
  ];
}

export class SteamCmd {
  private readonly platform: NodeJS.Platform;
  // SteamCMD keeps one state folder: never run two at the same time
  private readonly lock = new KeyedLock();

  constructor(private readonly options: SteamCmdOptions) {
    this.platform = options.platform ?? process.platform;
  }

  // the folder SteamCMD lives in (ARK copies it for -automanagedmods)
  get directory(): string {
    return this.options.configuredPath === undefined ? this.options.dir : path.dirname(this.options.configuredPath);
  }

  // downloads SteamCMD when it is missing, without running anything
  prepare(signal: AbortSignal, onLine: (line: string) => void): Promise<void> {
    return this.lock.run('steamcmd', () => this.ensure(signal, onLine));
  }

  private get executable(): string {
    if (this.options.configuredPath !== undefined) return this.options.configuredPath;
    return path.join(this.options.dir, this.platform === 'win32' ? 'steamcmd.exe' : 'steamcmd.sh');
  }

  // the program to start and its leading arguments: the .sh script runs through bash
  private command(): { command: string; prefix: string[] } {
    const file = this.executable;
    return this.platform !== 'win32' && file.endsWith('.sh') ? { command: '/bin/bash', prefix: [file] } : { command: file, prefix: [] };
  }

  async ensure(signal: AbortSignal, onLine: (line: string) => void): Promise<void> {
    if (await exists(this.executable)) return;
    if (this.options.configuredPath !== undefined) {
      throw new AppError(409, 'STEAMCMD_MISSING', `SteamCMD was not found at ${this.options.configuredPath} (STEAMCMD_PATH).`, undefined, { path: this.options.configuredPath });
    }
    if (this.platform !== 'win32' && this.platform !== 'linux') {
      throw new AppError(422, 'STEAMCMD_PLATFORM', 'SteamCMD servers are supported on Windows and Linux only.');
    }
    onLine('Downloading SteamCMD from Valve ...');
    const url = STEAMCMD_DOWNLOAD[this.platform];
    // next to the target, not inside it: the target is replaced as a whole once the download is unpacked
    const staging = `${this.options.dir}.staging`;
    await rm(staging, { recursive: true, force: true });
    try {
      // Valve publishes no checksum for this file; it is fetched over HTTPS from Valve's CDN only, and SteamCMD
      // replaces itself with a signed current build on its first run.
      const archive = await downloadToTmp(
        { url, fileName: path.basename(url), fileKind: 'archive', requireZip: this.platform === 'win32' },
        staging,
        { fetch: this.options.fetch ?? fetch, allowedHosts: DOWNLOAD_HOSTS, timeoutMs: 5 * 60_000, signal },
      );
      const unpacked = path.join(staging, 'unpacked');
      const limits = { maxBytes: 200 * 1024 * 1024, maxEntries: 2000, platform: this.platform, checkpoint: () => signal.throwIfAborted() };
      await (this.platform === 'win32' ? extractZip(archive, unpacked, limits) : extractTarGz(archive, unpacked, limits));
      const name = path.basename(this.executable);
      if (!(await exists(path.join(unpacked, name)))) throw new AppError(502, 'STEAMCMD_INVALID', 'The SteamCMD download does not contain the program.');
      if (this.platform !== 'win32') await chmod(path.join(unpacked, 'linux32', 'steamcmd'), 0o755).catch(() => undefined);
      await mkdir(path.dirname(this.options.dir), { recursive: true });
      await rm(this.options.dir, { recursive: true, force: true });
      await rename(unpacked, this.options.dir);
      onLine('SteamCMD is ready.');
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // only for the SteamCMD of WorldFoundry: an installation named with STEAMCMD_PATH belongs to the user
  private async tuneDownloads(): Promise<void> {
    if (this.options.configuredPath !== undefined) return;
    await writeFile(path.join(this.options.dir, STEAM_DEV_CFG_NAME), STEAM_DEV_CFG, { flag: 'wx' }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
  }

  // Installs or updates a dedicated server. Resolves when SteamCMD confirmed success, throws otherwise.
  async appUpdate(request: AppUpdateRequest): Promise<void> {
    await this.lock.run('steamcmd', async () => {
      await this.ensure(request.signal, request.onLine);
      await this.tuneDownloads();
      await mkdir(request.dir, { recursive: true });
      const { command, prefix } = this.command();
      const success = successLine(request.appId);
      let confirmed = false;
      const tail: string[] = [];
      const meter = new SpeedMeter();
      let step: SteamStep | null = null;
      const result = await this.options.runner({
        javaPath: command,
        args: [...prefix, ...buildAppUpdateArgs(request.appId, request.branch, request.dir, request.validate, request.platformType)],
        cwd: path.dirname(this.executable),
        timeoutMs: this.options.timeoutMs ?? RUN_TIMEOUT_MS,
        signal: request.signal,
        onLine: (line) => {
          request.onLine(line);
          tail.push(line);
          if (tail.length > 15) tail.shift();
          if (success.test(line)) confirmed = true;
          const parsed = parseSteamLine(line);
          if (parsed !== null) {
            if (parsed.step !== step) meter.reset();
            step = parsed.step;
            const bytesPerSecond = parsed.step === 'download' && parsed.doneBytes !== null ? meter.add(parsed.doneBytes) : null;
            request.onProgress({ ...parsed, line, bytesPerSecond });
          }
        },
      }).catch((error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code;
        throw new AppError(500, 'STEAMCMD_FAILED', `SteamCMD could not be started${code === undefined ? '' : ` (${code})`}.`, undefined, { reason: 'not-started', output: '' });
      });
      if (result.aborted) throw new AppError(500, 'INSTALL_ABORTED', 'The installation was interrupted (the application is shutting down).');
      if (result.timedOut) throw new AppError(500, 'STEAMCMD_FAILED', 'SteamCMD took too long and was stopped.', undefined, { reason: 'timeout', output: tail.join('\n') });
      if (!confirmed) {
        // the 32-bit loader of SteamCMD is missing on a 64-bit Linux without multiarch libraries
        const missing32 = this.platform === 'linux' && tail.some((line) => /linux32\/steamcmd: (?:No such file or directory|cannot execute)|lib32gcc|libstdc\+\+\.so\.6/i.test(line));
        throw new AppError(
          500,
          'STEAMCMD_FAILED',
          missing32
            ? 'SteamCMD needs 32-bit libraries on Linux. On Debian or Ubuntu install them with: sudo apt install lib32gcc-s1'
            : `SteamCMD did not confirm the installation (exit code ${result.exitCode ?? 'unknown'}).\nLast output:\n${tail.join('\n')}`,
          undefined,
          { reason: missing32 ? 'lib32' : 'exit', output: tail.join('\n') },
        );
      }
    });
  }
}
