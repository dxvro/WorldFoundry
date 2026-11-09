import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { mods, servers } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { cfProjectId, modLoaderTypeOf } from '../mods/curseforge.js';
import { requireLoaderProfile } from '../mods/profile.js';
import { SettingsStore } from '../settings/store.js';
import { CLASS_BUKKIT_PLUGINS, CLASS_MODS, type CurseForgeApi } from './client.js';

export const KEY_SETTING = 'curseforge.apiKey';
const PAGE_SIZE = 20;

export interface CurseForgeStatus {
  configured: boolean;
}

export interface CurseForgeHit {
  id: number;
  name: string;
  summary: string;
  author: string | null;
  downloads: number;
  iconUrl: string | null;
  websiteUrl: string | null;
  // false: only the CurseForge website and app may download it
  downloadable: boolean;
  installed: boolean;
}

export interface CurseForgeSearch {
  hits: CurseForgeHit[];
  total: number;
  offset: number;
  limit: number;
}

const notConfigured = (): AppError =>
  new AppError(409, 'CURSEFORGE_NOT_CONFIGURED', 'No CurseForge API key is set. Please enter your own key under System > CurseForge.');

// The user's own CurseForge API key. It is kept in the database of this computer and never sent anywhere but to CurseForge.
export class CurseForgeService {
  private readonly settings: SettingsStore;

  constructor(
    private readonly db: Db,
    readonly api: CurseForgeApi,
  ) {
    this.settings = new SettingsStore(db);
  }

  async status(): Promise<CurseForgeStatus> {
    return { configured: (await this.settings.get(KEY_SETTING)) !== null };
  }

  async setKey(raw: string): Promise<CurseForgeStatus> {
    const key = raw.trim();
    if (key.length < 10 || key.length > 200 || /\s/.test(key)) {
      throw new AppError(422, 'CURSEFORGE_KEY_INVALID', 'This does not look like a CurseForge API key.');
    }
    await this.api.checkKey(key);
    await this.settings.set(KEY_SETTING, key);
    return { configured: true };
  }

  async clearKey(): Promise<CurseForgeStatus> {
    await this.settings.set(KEY_SETTING, null);
    return { configured: false };
  }

  async key(): Promise<string> {
    const key = await this.settings.get(KEY_SETTING);
    if (key === null) throw notConfigured();
    return key;
  }

  async search(serverId: string, query: string, offset: number): Promise<CurseForgeSearch> {
    const server = (await this.db.select().from(servers).where(eq(servers.id, serverId)))[0];
    if (server === undefined) throw new AppError(404, 'SERVER_NOT_FOUND', 'The server was not found.');
    const profile = requireLoaderProfile(server.loader);
    const apiKey = await this.key();
    const result = await this.api.search(apiKey, {
      classId: profile.projectType === 'plugin' ? CLASS_BUKKIT_PLUGINS : CLASS_MODS,
      query,
      gameVersion: server.mcVersion,
      modLoaderType: modLoaderTypeOf(server.loader),
      index: offset,
      pageSize: PAGE_SIZE,
    });
    const installed = new Set(
      (await this.db.select({ projectId: mods.projectId }).from(mods).where(eq(mods.serverId, serverId))).map((row) => row.projectId),
    );
    return {
      hits: result.mods.map((mod) => ({
        id: mod.id,
        name: mod.name,
        summary: mod.summary,
        author: mod.authors[0]?.name ?? null,
        downloads: mod.downloadCount,
        iconUrl: mod.logo?.thumbnailUrl ?? null,
        websiteUrl: mod.links.websiteUrl ?? null,
        downloadable: mod.allowModDistribution !== false,
        installed: installed.has(cfProjectId(mod.id)),
      })),
      total: result.total,
      offset,
      limit: PAGE_SIZE,
    };
  }
}
