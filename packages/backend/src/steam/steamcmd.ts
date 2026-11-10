import { access, chmod, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { extractTarGz } from '../archive/tar.js';
import { extractZip } from '../archive/zip.js';
import { AppError } from '../http/errors.js';
import type { InstallerRunner } from '../installer/runner.js';
import { KeyedLock } from '../lib/keyed-lock.js';
import { downloadToTmp } from '../mods/downloader.js';

// SteamCMD is Valve's command-line client for dedicated servers. WorldFoundry downloads it from Valve into its data
// folder on first use (or uses STEAMCMD_PATH) and always logs in anonymously: no Steam account is ever involved.
export const STEAMCMD_DOWNLOAD = {
  linux: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz',
  win32: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip',
} as const;
const DOWNLOAD_HOSTS = ['steamcdn-a.akamaihd.net'];
// SteamCMD updates itself and the game files; a big game can take long on a slow line
const RUN_TIMEOUT_MS = 3 * 60 * 60_000;
const BRANCH = /^[A-Za-z0-9_.-]{1,80}$/;

export interface SteamProgress {
  percent: number | null;
  line: string;
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
const PROGRESS = /Update state \(0x[0-9a-f]+\) [a-z ,]+, progress: (\d{1,3}(?:\.\d+)?) \(/i;

export function parseProgress(line: string): number | null {
  const match = PROGRESS.exec(line);
  if (match?.[1] === undefined) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
}

export const successLine = (appId: number): RegExp => new RegExp(String.raw`Success! App '${appId}' (?:fully installed|already up to date)`);

export function buildAppUpdateArgs(appId: number, branch: string, dir: string, validate: boolean): string[] {
  if (!BRANCH.test(branch) || branch.startsWith('-')) throw new AppError(422, 'STEAM_BRANCH_INVALID', 'The Steam branch name is invalid.');
  // force_install_dir must come before the login (https://github.com/ValveSoftware/steam-for-linux/issues/8298)
  return [
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
    const staging = path.join(this.options.dir, '.staging');
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

  // Installs or updates a dedicated server. Resolves when SteamCMD confirmed success, throws otherwise.
  async appUpdate(request: AppUpdateRequest): Promise<void> {
    await this.lock.run('steamcmd', async () => {
      await this.ensure(request.signal, request.onLine);
      await mkdir(request.dir, { recursive: true });
      const { command, prefix } = this.command();
      const success = successLine(request.appId);
      let confirmed = false;
      const tail: string[] = [];
      const result = await this.options.runner({
        javaPath: command,
        args: [...prefix, ...buildAppUpdateArgs(request.appId, request.branch, request.dir, request.validate)],
        cwd: path.dirname(this.executable),
        timeoutMs: this.options.timeoutMs ?? RUN_TIMEOUT_MS,
        signal: request.signal,
        onLine: (line) => {
          request.onLine(line);
          tail.push(line);
          if (tail.length > 15) tail.shift();
          if (success.test(line)) confirmed = true;
          const percent = parseProgress(line);
          if (percent !== null) request.onProgress({ percent, line });
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
