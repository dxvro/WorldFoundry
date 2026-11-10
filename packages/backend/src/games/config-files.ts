import { eq } from 'drizzle-orm';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/client.js';
import { servers, type Server } from '../db/schema.js';
import type { EventBus } from '../events/bus.js';
import { AppError } from '../http/errors.js';
import type { KeyedLock } from '../lib/keyed-lock.js';
import type { ServerRuntimeGuard } from '../mods/runtime-guard.js';
import type { GameAdapters } from './adapters.js';
import type { ConfigFile } from './types.js';

export const MAX_CONFIG_BYTES = 1024 * 1024;

export interface ConfigFileInfo {
  key: string;
  label: string;
  description: string;
  path: string;
  format: ConfigFile['format'];
  exists: boolean;
  sizeBytes: number;
}

export interface ConfigFileText {
  file: ConfigFileInfo;
  text: string;
}

export interface ConfigFilesOptions {
  db: Db;
  serversDir: string;
  lock: KeyedLock;
  bus: EventBus;
  games: GameAdapters;
  guard: ServerRuntimeGuard;
}

// The settings files of a game as plain text. Writing needs the server stopped: the game reads them at start and may
// write them back while it runs.
export class ConfigFilesService {
  constructor(private readonly options: ConfigFilesOptions) {}

  private async server(serverId: string): Promise<Server> {
    const row = (await this.options.db.select().from(servers).where(eq(servers.id, serverId)))[0];
    if (row === undefined) throw new AppError(404, 'SERVER_NOT_FOUND', 'The server was not found.');
    return row;
  }

  private files(server: Server): ConfigFile[] {
    const adapter = this.options.games.forServer(server);
    return adapter.configFiles?.(server, path.join(this.options.serversDir, server.id)) ?? [];
  }

  private async info(file: ConfigFile): Promise<ConfigFileInfo> {
    const stats = await stat(file.file).catch(() => null);
    return { key: file.key, label: file.label, description: file.description, path: file.display, format: file.format, exists: stats?.isFile() === true, sizeBytes: stats?.size ?? 0 };
  }

  private find(server: Server, key: string): ConfigFile {
    const file = this.files(server).find((entry) => entry.key === key);
    if (file === undefined) throw new AppError(404, 'CONFIG_FILE_NOT_FOUND', 'This settings file does not exist for the server.');
    return file;
  }

  async list(serverId: string): Promise<ConfigFileInfo[]> {
    return Promise.all(this.files(await this.server(serverId)).map((file) => this.info(file)));
  }

  async read(serverId: string, key: string): Promise<ConfigFileText> {
    const file = this.find(await this.server(serverId), key);
    const info = await this.info(file);
    if (info.sizeBytes > MAX_CONFIG_BYTES) throw new AppError(413, 'CONFIG_FILE_TOO_LARGE', 'The file is too large to be edited here.');
    const text = info.exists ? await readFile(file.file, 'utf8') : '';
    return { file: info, text };
  }

  async write(serverId: string, key: string, text: string): Promise<ConfigFileText> {
    if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw new AppError(413, 'CONFIG_FILE_TOO_LARGE', 'The text is too large.');
    if (text.includes('\u0000')) throw new AppError(422, 'CONFIG_FILE_INVALID', 'The text contains invalid characters.');
    const running = (): AppError => new AppError(409, 'SERVER_RUNNING', 'The server is running. Please stop it before changing its settings files.');
    if (this.options.guard.isRunning(serverId)) throw running();
    return this.options.lock.run(serverId, async () => {
      if (this.options.guard.isRunning(serverId)) throw running();
      const server = await this.server(serverId);
      const file = this.find(server, key);
      const adapter = this.options.games.forServer(server);
      const others = await this.options.db.select().from(servers);
      const columns = (await adapter.checkConfig?.(server, file, text, others)) ?? {};
      await mkdir(path.dirname(file.file), { recursive: true });
      const part = `${file.file}.part`;
      await writeFile(part, text, 'utf8');
      await rename(part, file.file);
      if (Object.keys(columns).length > 0) {
        await this.options.db.transaction((tx) => tx.update(servers).set({ ...columns, updatedAt: new Date() }).where(eq(servers.id, serverId)));
        this.options.bus.emit({ type: 'server.changed', serverId, reason: 'updated' });
      }
      return { file: await this.info(file), text };
    });
  }
}
