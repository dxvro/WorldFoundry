import { execFile } from 'node:child_process';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { MessageRef } from '../messages.js';
import { mapLimit } from '../mods/files.js';
import { parseJavaVersion } from './parse.js';
import type { JavaRuntime } from './select.js';

export type JavaProbe = (javaPath: string) => Promise<string | null>;

export const probeJava: JavaProbe = (javaPath) =>
  new Promise((resolve) => {
    execFile(javaPath, ['-version'], { timeout: 15_000, windowsHide: true, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      resolve(error === null ? `${stderr}\n${stdout}` : null);
    });
  });

// runtimes WorldFoundry installed itself, handed in by the managed store
export interface ManagedSource {
  list(): Promise<Array<{ javaPath: string; origin: string; originRef?: MessageRef }>>;
}

export interface DetectorOptions {
  env?: NodeJS.ProcessEnv;
  managed?: ManagedSource;
  platform?: NodeJS.Platform;
  // directories whose sub-directories are scanned as JDK homes; defaults to the usual per-platform install locations
  standardRoots?: string[];
  probe?: JavaProbe;
  cacheTtlMs?: number;
  now?: () => number;
}

const WINDOWS_VENDORS = [
  'Java',
  'Eclipse Adoptium',
  'Eclipse Foundation',
  'AdoptOpenJDK',
  'Microsoft',
  'Zulu',
  'BellSoft',
  'Amazon Corretto',
  'Semeru',
];

export const javaExecutable = (platform: NodeJS.Platform): string => (platform === 'win32' ? 'java.exe' : 'java');

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function subdirectories(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

export interface Candidate {
  path: string;
  source: JavaRuntime['source'];
  origin?: string;
  originRef?: MessageRef;
}

// the usual install locations of the platform, derived from the environment where it matters (Windows)
export function defaultStandardRoots(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    const bases = [env['ProgramFiles'], env['ProgramW6432'], env['ProgramFiles(x86)']].filter(
      (value): value is string => value !== undefined && value !== '',
    );
    const local = env['LOCALAPPDATA'];
    if (local !== undefined && local !== '') bases.push(path.join(local, 'Programs'));
    const roots: string[] = [];
    for (const base of new Set(bases)) for (const vendor of WINDOWS_VENDORS) roots.push(path.join(base, vendor));
    return roots;
  }
  return platform === 'darwin' ? ['/Library/Java/JavaVirtualMachines'] : ['/usr/lib/jvm'];
}

export async function collectCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  standardRoots: string[] = defaultStandardRoots(env, platform),
): Promise<Candidate[]> {
  const exe = javaExecutable(platform);
  const candidates: Candidate[] = [];
  const javaHome = env['JAVA_HOME'];
  if (javaHome !== undefined && javaHome !== '') candidates.push({ path: path.join(javaHome, 'bin', exe), source: 'JAVA_HOME' });
  for (const dir of (env['PATH'] ?? env['Path'] ?? '').split(path.delimiter)) {
    if (dir.trim() !== '') candidates.push({ path: path.join(dir.replace(/^"|"$/g, ''), exe), source: 'PATH' });
  }
  for (const root of standardRoots) {
    for (const dir of await subdirectories(root)) {
      const home = platform === 'darwin' ? path.join(dir, 'Contents', 'Home') : dir;
      candidates.push({ path: path.join(home, 'bin', exe), source: 'standard' });
    }
  }
  return candidates;
}

export class JavaDetector {
  private cache: { expires: number; runtimes: JavaRuntime[] } | null = null;
  private pending: Promise<JavaRuntime[]> | null = null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly standardRoots: string[] | undefined;
  private readonly probe: JavaProbe;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly managed: ManagedSource | undefined;

  constructor(options: DetectorOptions = {}) {
    this.managed = options.managed;
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.standardRoots = options.standardRoots;
    this.probe = options.probe ?? probeJava;
    this.ttlMs = options.cacheTtlMs ?? 2 * 60_000;
    this.now = options.now ?? Date.now;
  }

  async detect(rescan = false): Promise<JavaRuntime[]> {
    if (!rescan && this.cache !== null && this.cache.expires > this.now()) return this.cache.runtimes;
    this.pending ??= this.scan().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  async inspect(javaPath: string, source: JavaRuntime['source'], origin: string | null = null, originRef?: MessageRef): Promise<JavaRuntime | null> {
    const output = await this.probe(javaPath);
    const parsed = output === null ? null : parseJavaVersion(output);
    return parsed === null
      ? null
      : { path: javaPath, major: parsed.major, version: parsed.version, name: parsed.name, source, origin, ...(originRef === undefined ? {} : { originRef }) };
  }

  private async scan(): Promise<JavaRuntime[]> {
    // managed runtimes first, so a JAVA_HOME or PATH entry that points at one does not hide its origin
    const candidates: Candidate[] = ((await this.managed?.list()) ?? []).map((entry) => ({ path: entry.javaPath, source: 'managed', origin: entry.origin, ...(entry.originRef === undefined ? {} : { originRef: entry.originRef }) }));
    candidates.push(...(await collectCandidates(this.env, this.platform, this.standardRoots)));
    const unique = new Map<string, Candidate>();
    for (const candidate of candidates) {
      if (!(await isFile(candidate.path))) continue;
      let key = candidate.path;
      try {
        key = await realpath(candidate.path);
      } catch {
        // keep the plain path as the identity
      }
      const normalized = this.platform === 'win32' ? key.toLowerCase() : key;
      if (!unique.has(normalized)) unique.set(normalized, candidate);
    }
    const found = await mapLimit([...unique.values()], 4, (candidate) => this.inspect(candidate.path, candidate.source, candidate.origin ?? null, candidate.originRef));
    const runtimes = found
      .filter((runtime): runtime is JavaRuntime => runtime !== null)
      .sort((a, b) => a.major - b.major || a.path.localeCompare(b.path));
    this.cache = { expires: this.now() + this.ttlMs, runtimes };
    return runtimes;
  }
}
