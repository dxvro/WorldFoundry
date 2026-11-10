import { eq } from 'drizzle-orm';
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { servers, type Server } from '../../db/schema.js';
import { AppError } from '../../http/errors.js';
import type { KeyedLock } from '../../lib/keyed-lock.js';
import type { ServerRuntimeGuard } from '../../mods/runtime-guard.js';
import { iniFile, parseZomboidSettings } from './adapter.js';
import { readIniValues, setIniValues } from './ini.js';

// Steam Workshop for Project Zomboid. The server downloads the items itself on start; WorldFoundry only keeps the
// three lists of <profile>.ini in order: WorkshopItems (Workshop ids), Mods (mod ids inside the items) and Map.
// Details come from GetPublishedFileDetails, which needs no API key.
const DETAILS_URL = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';
export const ZOMBOID_WORKSHOP_APP = 108600;
export const DEFAULT_MAP = 'Muldraugh, KY';
const MAX_ITEMS = 300;

const DetailSchema = z.object({
  publishedfileid: z.string(),
  result: z.number(),
  title: z.string().optional(),
  description: z.string().optional(),
  preview_url: z.string().optional(),
  file_size: z.union([z.number(), z.string()]).optional(),
  time_updated: z.number().optional(),
  consumer_app_id: z.number().optional(),
});
const ResponseSchema = z.object({ response: z.object({ publishedfiledetails: z.array(DetailSchema).default([]) }) });

export interface WorkshopDetails {
  id: string;
  found: boolean;
  title: string | null;
  previewUrl: string | null;
  sizeBytes: number | null;
  updatedAt: number | null;
  // read from the description ("Mod ID: ...", "Map Folder: ..."); authors write them by hand, so they are suggestions
  modIds: string[];
  mapFolders: string[];
  // false: the item belongs to another game
  forZomboid: boolean;
  // the Steam app the item belongs to; null when Steam did not say
  appId: number | null;
}

export interface WorkshopApi {
  details(ids: readonly string[]): Promise<WorkshopDetails[]>;
}

const lines = (text: string, label: RegExp): string[] => {
  const out: string[] = [];
  for (const match of text.matchAll(label)) {
    const value = match[1]?.replace(/\[\/?[a-z]+\]/gi, '').trim();
    if (value !== undefined && value !== '' && value.length <= 100 && !value.includes(';') && !out.includes(value)) out.push(value);
  }
  return out;
};
export const modIdsOf = (description: string): string[] => lines(description, /^[ \t]*Mod ?ID:[ \t]*([^\r\n]+)$/gim);
export const mapFoldersOf = (description: string): string[] => lines(description, /^[ \t]*Map ?Folder:[ \t]*([^\r\n]+)$/gim);

export class SteamWorkshopClient implements WorkshopApi {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async details(ids: readonly string[]): Promise<WorkshopDetails[]> {
    if (ids.length === 0) return [];
    const body = new URLSearchParams({ itemcount: String(ids.length) });
    ids.forEach((id, index) => body.set(`publishedfileids[${index}]`, id));
    let response: Response;
    try {
      response = await this.fetchFn(DETAILS_URL, { method: 'POST', body, headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new AppError(502, 'UPSTREAM_UNREACHABLE', 'The Steam Workshop cannot be reached. Please check the internet connection.', undefined, { host: 'api.steampowered.com' });
    }
    if (!response.ok) throw new AppError(502, 'UPSTREAM_ERROR', `The Steam Workshop responded with HTTP ${response.status}.`, undefined, { host: 'api.steampowered.com' });
    const parsed = ResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new AppError(502, 'UPSTREAM_INVALID', 'The Steam Workshop returned data in an unexpected format.', undefined, { host: 'api.steampowered.com' });
    const byId = new Map(parsed.data.response.publishedfiledetails.map((detail) => [detail.publishedfileid, detail]));
    return ids.map((id) => {
      const detail = byId.get(id);
      const found = detail !== undefined && detail.result === 1;
      const description = found ? (detail.description ?? '') : '';
      const size = found ? Number(detail.file_size) : NaN;
      return {
        id,
        found,
        title: found ? (detail.title ?? null) : null,
        previewUrl: found ? (detail.preview_url ?? null) : null,
        sizeBytes: Number.isFinite(size) ? size : null,
        updatedAt: found && detail.time_updated !== undefined ? detail.time_updated * 1000 : null,
        modIds: modIdsOf(description),
        mapFolders: mapFoldersOf(description),
        forZomboid: found ? detail.consumer_app_id === undefined || detail.consumer_app_id === ZOMBOID_WORKSHOP_APP : false,
        appId: found ? (detail.consumer_app_id ?? null) : null,
      };
    });
  }
}

// A Workshop id from an id or a link (steamcommunity.com/sharedfiles/filedetails/?id=123)
export function workshopIdOf(input: string): string | null {
  const text = input.trim();
  if (/^\d{1,20}$/.test(text)) return text;
  const match = /[?&]id=(\d{1,20})(?:&|$)/.exec(text);
  return match?.[1] ?? null;
}

const split = (value: string | undefined): string[] => (value ?? '').split(';').map((part) => part.trim()).filter((part) => part !== '');

const MOD_ID = /^[^;\r\n]{1,100}$/;
export const WorkshopSaveSchema = z
  .object({
    items: z.array(z.string().regex(/^\d{1,20}$/)).max(MAX_ITEMS),
    mods: z.array(z.string().trim().regex(MOD_ID)).max(MAX_ITEMS * 4),
    maps: z.array(z.string().trim().regex(MOD_ID)).max(50),
  })
  .strict();
export type WorkshopSave = z.infer<typeof WorkshopSaveSchema>;

export interface WorkshopView {
  items: WorkshopDetails[];
  mods: string[];
  maps: string[];
  // set when the details could not be loaded; the lists themselves are still shown
  detailsError: string | null;
}

export class ZomboidWorkshopService {
  constructor(
    private readonly options: { db: Db; serversDir: string; lock: KeyedLock; guard: ServerRuntimeGuard; api: WorkshopApi },
  ) {}

  private async server(serverId: string): Promise<Server> {
    const row = (await this.options.db.select().from(servers).where(eq(servers.id, serverId)))[0];
    if (row === undefined) throw new AppError(404, 'SERVER_NOT_FOUND', 'The server was not found.');
    if (row.game !== 'zomboid') throw new AppError(409, 'GAME_FEATURE_UNSUPPORTED', 'The Steam Workshop is only available for Project Zomboid servers.', undefined, { game: row.game });
    return row;
  }

  private file(server: Server): string {
    return iniFile(path.join(this.options.serversDir, server.id), parseZomboidSettings(server).profile);
  }

  async get(serverId: string): Promise<WorkshopView> {
    const server = await this.server(serverId);
    const values = readIniValues(await readFile(this.file(server), 'utf8').catch(() => ''));
    const ids = split(values.get('WorkshopItems'));
    let items: WorkshopDetails[];
    let detailsError: string | null = null;
    try {
      items = await this.options.api.details(ids);
    } catch (error) {
      detailsError = error instanceof Error ? error.message : String(error);
      items = ids.map((id) => ({ id, found: false, title: null, previewUrl: null, sizeBytes: null, updatedAt: null, modIds: [], mapFolders: [], forZomboid: true, appId: null }));
    }
    const maps = split(values.get('Map'));
    return { items, mods: split(values.get('Mods')), maps: maps.length === 0 ? [DEFAULT_MAP] : maps, detailsError };
  }

  async lookup(input: string): Promise<WorkshopDetails> {
    const id = workshopIdOf(input);
    if (id === null) throw new AppError(422, 'WORKSHOP_ID_INVALID', 'Please enter a Workshop id or the link of a Workshop item.');
    const [details] = await this.options.api.details([id]);
    if (details === undefined || !details.found) throw new AppError(404, 'WORKSHOP_NOT_FOUND', 'This Workshop item was not found or is not public.');
    if (!details.forZomboid) throw new AppError(422, 'WORKSHOP_WRONG_GAME', 'This Workshop item is not for Project Zomboid.');
    return details;
  }

  async save(serverId: string, input: WorkshopSave): Promise<WorkshopView> {
    const running = (): AppError => new AppError(409, 'SERVER_RUNNING', 'The server is running. Please stop it before changing its Workshop items.');
    if (this.options.guard.isRunning(serverId)) throw running();
    await this.options.lock.run(serverId, async () => {
      if (this.options.guard.isRunning(serverId)) throw running();
      const server = await this.server(serverId);
      const file = this.file(server);
      const unique = (list: string[]): string[] => [...new Set(list)];
      const maps = unique(input.maps);
      const text = setIniValues(await readFile(file, 'utf8').catch(() => ''), {
        WorkshopItems: unique(input.items).join(';'),
        Mods: unique(input.mods).join(';'),
        Map: (maps.length === 0 ? [DEFAULT_MAP] : maps).join(';'),
      });
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(`${file}.part`, text, 'utf8');
      await rename(`${file}.part`, file);
    });
    return this.get(serverId);
  }
}
