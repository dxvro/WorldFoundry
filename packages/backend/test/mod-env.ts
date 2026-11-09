import type { FastifyInstance } from 'fastify';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { servers, type NewServer } from '../src/db/schema.js';
import type { ServerRuntimeGuard } from '../src/mods/runtime-guard.js';
import { FakeModrinth } from './fake-modrinth.js';
import { createTestDb, serverRow, testConfig, type TestDb } from './helpers.js';

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

export class ModEnv {
  readonly running = new Set<string>();
  readonly guard: ServerRuntimeGuard = { isRunning: (id) => this.running.has(id) };

  private constructor(
    readonly t: TestDb,
    readonly fake: FakeModrinth,
    readonly app: FastifyInstance,
  ) {}

  static async create(options: { modBackupKeep?: number } = {}): Promise<ModEnv> {
    const t = await createTestDb();
    const fake = new FakeModrinth();
    const holder: { env?: ModEnv } = {};
    const guard: ServerRuntimeGuard = { isRunning: (id) => holder.env?.running.has(id) ?? false };
    const app = buildApp({
      db: t.db,
      config: { ...testConfig(t.dir), ...(options.modBackupKeep === undefined ? {} : { modBackupKeep: options.modBackupKeep }) },
      modrinth: fake.api(),
      runtimeGuard: guard,
      javaStandardRoots: [],
      downloader: { fetch: fake.fetch, allowedHosts: ['cdn.modrinth.com'], timeoutMs: 5000 },
    });
    holder.env = new ModEnv(t, fake, app);
    return holder.env;
  }

  get serversDir(): string {
    return path.join(this.t.dir, 'servers');
  }

  serverDir(id: string): string {
    return path.join(this.serversDir, id);
  }

  async addServer(id: string, overrides: Partial<NewServer> = {}): Promise<void> {
    await this.t.db.insert(servers).values(serverRow(id, overrides));
  }

  async writeJar(serverId: string, fileName: string, content: string, dir = 'mods'): Promise<void> {
    const target = path.join(this.serverDir(serverId), dir);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, fileName), content);
  }

  async files(serverId: string, dir = 'mods'): Promise<string[]> {
    try {
      return (await readdir(path.join(this.serverDir(serverId), dir))).sort();
    } catch {
      return [];
    }
  }

  async call<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<ApiResult<T>> {
    const res = await this.app.inject({ method, url, ...(body === undefined ? {} : { payload: body as object }) });
    return { status: res.statusCode, body: res.json<T>() };
  }

  async close(): Promise<void> {
    await this.app.close();
    await this.t.cleanup();
  }
}
