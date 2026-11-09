import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config/env.js';
import { servers, type NewServer, type Server } from '../src/db/schema.js';
import { LoaderCatalog } from '../src/installer/catalog.js';
import type { InstallerRun, InstallerRunner } from '../src/installer/runner.js';
import { serializeLaunchSpec } from '../src/installer/launch-spec.js';
import { JavaDetector } from '../src/java/detect.js';
import { JavaService } from '../src/java/service.js';
import { eq } from 'drizzle-orm';
import { killWindowsTree, realSpawner, type ProcessSpawner, type ServerProcess, type SpawnRequest } from '../src/process/spawner.js';
import type { RuntimeStatus } from '../src/process/types.js';
import type { ServiceOptions } from '../src/services.js';
import { FakeModrinth } from './fake-modrinth.js';
import { FakeUpstream } from './fake-upstream.js';
import { createTestDb, testConfig, type TestDb } from './helpers.js';
import { TEST_ROOT_ENV } from './global-setup.js';
import os from 'node:os';

export const FAKE_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-server.mjs');

export class FakeSpawner implements ProcessSpawner {
  mode = 'normal';
  format = 'vanilla';
  extraEnv: Record<string, string> = {};
  startDelay = 30;
  readonly calls: SpawnRequest[] = [];
  readonly children: ServerProcess[] = [];

  spawn(request: SpawnRequest): ServerProcess {
    this.calls.push(request);
    const child = spawn(process.execPath, [FAKE_SERVER, ...request.args], {
      cwd: request.cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, FAKE_MODE: this.mode, FAKE_FORMAT: this.format, FAKE_START_DELAY: String(this.startDelay), ...this.extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.children.push(child);
    return child;
  }

  async killTree(child: ServerProcess): Promise<void> {
    await realSpawner.killTree(child);
  }

  async killAll(): Promise<void> {
    for (const child of this.children) {
      if (child.pid !== undefined && child.exitCode === null && process.platform === 'win32') await killWindowsTree(child.pid);
      else if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '0.0.0.0', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

export const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor<T>(check: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 8000, label = 'condition'): Promise<T> {
  // polling returns as soon as the condition holds, so a generous floor only matters on a stalled runner
  const end = Date.now() + Math.max(timeoutMs, 20_000);
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await wait(20);
  }
}

export const JAVA_OUTPUT = (version: string): string =>
  `openjdk version "${version}" 2024-01-01\nOpenJDK Runtime Environment Temurin-${version}+1 (build ${version}+1)\n`;

export function fakeJava(versions: Record<string, string>): JavaService {
  const detector = new JavaDetector({
    env: {},
    platform: process.platform,
    standardRoots: [],
    probe: async (javaPath) => {
      const version = versions[javaPath];
      return version === undefined ? null : JAVA_OUTPUT(version);
    },
  });
  // detection scans the file system, so the fake runtimes are supplied directly
  const entries = Object.entries(versions).map(([javaPath, version]) => ({
    path: javaPath,
    major: version.startsWith('1.') ? Number(version.split('.')[1]) : Number(version.split('.')[0]),
    version,
    name: `Test ${version}`,
    source: 'PATH' as const,
    origin: null,
  }));
  detector.detect = async () => entries.sort((a, b) => a.major - b.major);
  return new JavaService(detector);
}

export class FakeInstaller {
  readonly runs: InstallerRun[] = [];
  mode: 'modern' | 'legacy' | 'legacy-universal' | 'fail' | 'timeout' | 'nothing' | 'hang' = 'modern';

  readonly runner: InstallerRunner = async (run) => {
    this.runs.push(run);
    const jar = String(run.args[1]);
    const version = jar.replace(/^(forge|neoforge)-/, '').replace(/-installer\.jar$/, '');
    run.onLine('Installer started');
    if (this.mode === 'fail') {
      run.onLine('Could not download libraries');
      return { exitCode: 1, timedOut: false, aborted: false };
    }
    if (this.mode === 'timeout') return { exitCode: null, timedOut: true, aborted: false };
    if (this.mode === 'hang') {
      return new Promise((resolve) => run.signal.addEventListener('abort', () => resolve({ exitCode: null, timedOut: false, aborted: true })));
    }
    if (this.mode === 'modern') {
      const dir = path.join(run.cwd, 'libraries', 'net', jar.startsWith('neoforge') ? 'neoforged/neoforge' : 'minecraftforge/forge', version);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'unix_args.txt'), '-DlibraryDirectory=libraries\n');
      await writeFile(path.join(dir, 'win_args.txt'), '-DlibraryDirectory=libraries\n');
    } else if (this.mode === 'legacy') {
      await writeFile(path.join(run.cwd, `forge-${version}.jar`), 'jar');
    } else if (this.mode === 'legacy-universal') {
      await writeFile(path.join(run.cwd, `forge-${version}-universal.jar`), 'jar');
    }
    run.onLine('Installation finished');
    return { exitCode: 0, timedOut: false, aborted: false };
  };
}

export interface EnvOptions {
  authToken?: string;
  frontendDir?: string;
  allowedOrigins?: string[];
  allowedHosts?: string[];
  java?: Record<string, string>;
  stopTimeoutMs?: number;
  readSamples?: ServiceOptions['readSamples'];
  totalMemoryMb?: number;
  portProbe?: ServiceOptions['portProbe'];
  installerTimeoutMs?: number;
  startWarningMs?: number;
  // replaces the fake Java service, e.g. one with a managed-runtime installer
  javaService?: (dataDir: string) => JavaService;
  freeSpace?: ServiceOptions['freeSpace'];
  saveTimings?: ServiceOptions['saveTimings'];
  backupCheckMs?: number;
  config?: Partial<AppConfig>;
  // network settings (interfaces, host name, config-file defaults), restart handler and password hashing cost
  network?: ServiceOptions['network'];
  restart?: ServiceOptions['restart'];
  players?: ServiceOptions['players'];
  authOptions?: ServiceOptions['authOptions'];
  // options of the self-update service (fake GitHub, keys, install mode, timings)
  update?: ServiceOptions['update'];
  // runs after the database exists and before the application is built, e.g. to seed servers for the boot sequence
  prepare?: (context: { t: TestDb; config: AppConfig }) => Promise<void>;
}

export const DEFAULT_JAVA = { [path.join(os.tmpdir(), 'fake-jdk21', 'bin', 'java.exe')]: '21.0.1' };

export class ServerEnv {
  private constructor(
    readonly t: TestDb,
    readonly app: FastifyInstance,
    readonly config: AppConfig,
    readonly javaPath: string,
    readonly spawner: FakeSpawner,
    readonly upstream: FakeUpstream,
    readonly installer: FakeInstaller,
    readonly modrinth: FakeModrinth,
  ) {}

  static async create(options: EnvOptions = {}): Promise<ServerEnv> {
    const t = await createTestDb();
    const base = testConfig(t.dir);
    const config: AppConfig = {
      ...base,
      allowedOrigins: options.allowedOrigins ?? [],
      allowedHosts: options.allowedHosts ?? [],
      stopTimeoutMs: options.stopTimeoutMs ?? 5000,
      ...options.config,
      ...(options.frontendDir === undefined ? {} : { frontendDir: options.frontendDir }),
      ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
    };
    await mkdir(config.serversDir, { recursive: true });
    await options.prepare?.({ t, config });
    const javaPath = Object.keys(options.java ?? DEFAULT_JAVA)[0] ?? '';
    const spawner = new FakeSpawner();
    const upstream = new FakeUpstream();
    const installer = new FakeInstaller();
    const modrinth = new FakeModrinth();
    const app = buildApp({
      db: t.db,
      config,
      modrinth: modrinth.api(),
      downloader: { fetch: modrinth.fetch, allowedHosts: ['cdn.modrinth.com'], timeoutMs: 5000 },
      catalog: new LoaderCatalog({ fetch: upstream.fetch, userAgent: 'test-agent/1.0', timeoutMs: 3000, cacheTtlMs: 60_000, downloadTimeoutMs: 5000 }),
      java: options.javaService?.(config.dataDir) ?? fakeJava(options.java ?? DEFAULT_JAVA),
      ...(options.freeSpace === undefined ? {} : { freeSpace: options.freeSpace }),
      ...(options.saveTimings === undefined ? {} : { saveTimings: options.saveTimings }),
      spawner,
      installerRunner: installer.runner,
      ...(options.update === undefined ? {} : { update: options.update }),
      ...(options.network === undefined ? {} : { network: options.network }),
      ...(options.restart === undefined ? {} : { restart: options.restart }),
      ...(options.players === undefined ? {} : { players: options.players }),
      // cheap hashing and no caching of the stored password: tests change it from the outside
      authOptions: options.authOptions ?? { cost: { N: 1024, r: 8, p: 1 }, refreshMs: 0 },
      ...(options.readSamples === undefined ? {} : { readSamples: options.readSamples }),
      ...(options.portProbe === undefined ? {} : { portProbe: options.portProbe }),
      totalMemoryMb: () => options.totalMemoryMb ?? 16_384,
      timings: {
        closeGraceMs: 300,
        metricsIntervalMs: 200,
        loginFailureDelayMs: 0,
        backupCheckMs: options.backupCheckMs ?? 0,
        ...(options.installerTimeoutMs === undefined ? {} : { installerTimeoutMs: options.installerTimeoutMs }),
        ...(options.startWarningMs === undefined ? {} : { startWarningMs: options.startWarningMs }),
      },
    });
    const env = new ServerEnv(t, app, config, javaPath, spawner, upstream, installer, modrinth);
    await app.ready();
    return env;
  }

  get services(): FastifyInstance['services'] {
    return this.app.services;
  }

  serverDir(id: string): string {
    return path.join(this.config.serversDir, id);
  }

  async addServer(overrides: Partial<NewServer> = {}): Promise<Server> {
    const id = overrides.id ?? randomUUID();
    const port = overrides.port ?? (await freePort());
    await mkdir(this.serverDir(id), { recursive: true });
    await writeFile(path.join(this.serverDir(id), 'server.jar'), 'jar');
    const row: NewServer = {
      id,
      name: `Server ${id.slice(0, 4)}`,
      loader: 'vanilla',
      mcVersion: '1.21.1',
      installState: 'installed',
      launchSpec: serializeLaunchSpec({ kind: 'jar', jar: 'server.jar' }),
      requiredJavaMajor: 21,
      eulaAccepted: true,
      port,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    await this.t.db.insert(servers).values(row);
    return (await this.row(id)) as Server;
  }

  async row(id: string): Promise<Server | undefined> {
    return (await this.t.db.select().from(servers).where(eq(servers.id, id)))[0];
  }

  async call<T = Record<string, unknown>>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: T; headers: Record<string, unknown> }> {
    const res = await this.app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: body as object }) });
    const text = res.body;
    return { status: res.statusCode, body: (text === '' ? {} : JSON.parse(text)) as T, headers: res.headers };
  }

  async status(id: string): Promise<RuntimeStatus> {
    return this.services.manager.status(id);
  }

  async waitState(id: string, state: RuntimeStatus['state'], timeoutMs = 8000): Promise<RuntimeStatus> {
    return waitFor(() => (this.services.manager.status(id).state === state ? this.services.manager.status(id) : undefined), timeoutMs, `state ${state}`);
  }

  async readFakeArgs(id: string): Promise<{ args: string[]; pid: number }> {
    const file = path.join(this.serverDir(id), 'fake-args.json');
    return waitFor(async () => {
      try {
        return JSON.parse(await readFile(file, 'utf8')) as { args: string[]; pid: number };
      } catch {
        return undefined;
      }
    });
  }

  async close(): Promise<void> {
    await this.services.manager.shutdown(3000).catch(() => undefined);
    await this.spawner.killAll();
    await this.app.close();
    await this.t.cleanup();
  }
}

export async function scratchDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(process.env[TEST_ROOT_ENV] ?? os.tmpdir(), prefix));
}
