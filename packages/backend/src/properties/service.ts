import { eq } from 'drizzle-orm';
import path from 'node:path';
import type { PropertyEntry, PropertiesEntriesPatch, PropertiesEntriesResponse, PropertiesView } from '../contract.js';
import { DEFAULT_LEVEL } from '../backups/world.js';
import type { Db } from '../db/client.js';
import { servers } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { mcAtMost } from '../installer/mc-version.js';
import type { KeyedLock } from '../lib/keyed-lock.js';
import type { ServerRuntimeGuard } from '../mods/runtime-guard.js';
import { checkPropertyValue, findProperty } from './catalog.js';
import type { PropertiesDocument } from './parser.js';
import { loadProperties, saveProperties } from './store.js';
import { applyPatch, applyValue, extraProperties, readTyped, type PropertiesPatch } from './typed.js';

export type { PropertiesView };

export interface PropertiesServiceOptions {
  db: Db;
  serversDir: string;
  lock: KeyedLock;
  guard: ServerRuntimeGuard;
}

export type PropertiesWriteView = PropertiesView & { restartRequired: boolean };

// an empty or missing level-name means the vanilla default, like readLevelName in backups/world.ts
const levelNameOf = (doc: PropertiesDocument): string => {
  const raw = doc.get('level-name');
  return raw === undefined || raw.trim() === '' ? DEFAULT_LEVEL : raw;
};

function viewOf(doc: PropertiesDocument): Omit<PropertiesView, 'exists'> {
  const entries: PropertyEntry[] = doc.pairs().map(({ key, value }) => ({ key, value, known: findProperty(key) !== undefined }));
  return { properties: readTyped(doc), extra: extraProperties(doc), entries };
}

export class PropertiesService {
  constructor(private readonly options: PropertiesServiceOptions) {}

  private async serverRow(serverId: string): Promise<{ port: number; mcVersion: string }> {
    const row = (await this.options.db.select({ port: servers.port, mcVersion: servers.mcVersion }).from(servers).where(eq(servers.id, serverId)))[0];
    if (row === undefined) throw new AppError(404, 'SERVER_NOT_FOUND', 'The server was not found.');
    return row;
  }

  private dir(serverId: string): string {
    return path.join(this.options.serversDir, serverId);
  }

  async read(serverId: string): Promise<PropertiesView> {
    const dbPort = (await this.serverRow(serverId)).port;
    const { doc, exists } = await loadProperties(this.dir(serverId));
    const view = viewOf(doc);
    // without a file the server will start on the port that was chosen at creation
    return exists ? { exists, ...view } : { exists, ...view, properties: { ...view.properties, 'server-port': dbPort } };
  }

  patch(serverId: string, patch: PropertiesPatch): Promise<PropertiesWriteView> {
    return this.options.lock.run(serverId, async () => {
      const { port: dbPort, mcVersion } = await this.serverRow(serverId);
      const { doc, exists } = await loadProperties(this.dir(serverId));
      if (!exists) doc.set('server-port', String(dbPort));
      applyPatch(doc, patch, mcAtMost(mcVersion, 1, 12, 2));
      return this.save(serverId, dbPort, doc, patch['server-port']);
    });
  }

  // edits any keys of the file; comments and unknown lines are kept, unknown keys are accepted
  async setEntries(serverId: string, patch: PropertiesEntriesPatch): Promise<PropertiesEntriesResponse> {
    const set = patch.set ?? {};
    const remove = patch.remove ?? [];
    // the port is only changed through a set, the file must always name one
    if (remove.includes('server-port')) {
      throw new AppError(422, 'PROPERTY_NOT_REMOVABLE', 'The server port (server-port) cannot be removed. Please set a new port instead.');
    }
    return this.options.lock.run(serverId, async () => {
      const { port: dbPort, mcVersion } = await this.serverRow(serverId);
      const { doc, exists } = await loadProperties(this.dir(serverId));
      if (!exists) doc.set('server-port', String(dbPort));
      const levelBefore = levelNameOf(doc);
      let port: number | undefined;
      for (const [key, raw] of Object.entries(set)) {
        // the schema has checked the values already; this repeats the check to get the text to write
        const check = checkPropertyValue(key, raw);
        if (!check.ok) throw new AppError(400, 'VALIDATION_ERROR', check.message);
        applyValue(doc, key, check.value, mcAtMost(mcVersion, 1, 12, 2));
        if (key === 'server-port') port = Number(check.value);
      }
      for (const key of remove) doc.remove(key);
      const written = await this.save(serverId, dbPort, doc, port);
      // a running server can rewrite server.properties itself (for example on /whitelist), which would undo this edit
      return { ...written, levelNameChanged: levelNameOf(doc) !== levelBefore, liveOverwriteRisk: written.restartRequired };
    });
  }

  // the file is authoritative; the database follows it only after the file was written
  private async save(serverId: string, dbPort: number, doc: PropertiesDocument, port: number | undefined): Promise<PropertiesWriteView> {
    await saveProperties(this.dir(serverId), doc);
    if (port !== undefined && port !== dbPort) {
      await this.options.db.transaction((tx) =>
        tx.update(servers).set({ port, updatedAt: new Date() }).where(eq(servers.id, serverId)),
      );
    }
    return {
      exists: true,
      ...viewOf(doc),
      restartRequired: this.options.guard.isRunning(serverId),
    };
  }
}
