import { eq } from 'drizzle-orm';
import path from 'node:path';
import type { PlayerListKey, PlayersView } from '../contract.js';
import type { Db } from '../db/client.js';
import { servers } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { msg, type Msg } from '../messages.js';
import { mcAtMost, parseMcVersion } from '../installer/mc-version.js';
import type { KeyedLock } from '../lib/keyed-lock.js';
import type { RuntimeStatus } from '../process/types.js';
import { loadProperties, saveProperties } from '../properties/store.js';
import { lookupMojangProfile, type Profile } from './mojang.js';
import { FLOODGATE_PREFIX, isAddableName, type OpInput } from './schemas.js';
import { corruptListError, readList, writeList, type ListTypes } from './store.js';
import { formatBanDate, offlineUuid } from './uuid.js';

// What the service needs from the process manager
export interface PlayersRuntime {
  status(serverId: string): RuntimeStatus;
  sendCommand(serverId: string, command: string): Promise<void>;
}

export interface PlayersTimings {
  // how long a live change waits for the server to write the file, and how often the file is checked meanwhile
  liveWaitMs?: number;
  pollMs?: number;
  lookupTimeoutMs?: number;
}

// Replacements for tests
export interface PlayersOverrides {
  fetch?: typeof fetch;
  timings?: PlayersTimings;
  now?: () => Date;
  mojangUrl?: string;
}

export interface PlayersServiceOptions extends PlayersOverrides {
  db: Db;
  serversDir: string;
  lock: KeyedLock;
  runtime: PlayersRuntime;
  userAgent: string;
}

const DEFAULT_LIVE_WAIT_MS = 5000;
const DEFAULT_POLL_MS = 100;
const DEFAULT_REASON = 'Banned by an operator.';
const SOURCE = 'WorldFoundry';
const FILE_STATES: ReadonlySet<string> = new Set(['offline', 'crashed']);

interface Facts {
  supported: boolean;
  whitelistEnabled: boolean;
  onlineMode: boolean;
  opLevel: number;
}

interface Change<K extends PlayerListKey> {
  key: K;
  // console command for live mode, built from the current list
  command(entries: ListTypes[K][]): string;
  // name that needs a UUID when the file is edited directly
  lookup?: string;
  // reason why the change cannot be made while the server runs
  liveError?: AppError;
  // refuses removals of unknown entries
  check?(entries: ListTypes[K][]): void;
  // whether the list already shows the change
  done(entries: ListTypes[K][]): boolean;
  edit(entries: ListTypes[K][], profile: Profile | null, created: string): ListTypes[K][];
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// An exact match wins; otherwise every entry that differs only in capitalisation matches
function matching<T extends { name: string }>(entries: readonly T[], name: string): T[] {
  const exact = entries.filter((entry) => entry.name === name);
  return exact.length > 0 ? exact : entries.filter((entry) => same(entry.name, name));
}

// `name` in the details is the entry as requested (the IP address for IP bans), for translating the message
const notListed = (what: string): AppError => new AppError(404, 'PLAYER_NOT_LISTED', `"${what}" is not in this list.`, { name: what }, { name: what });

const busy = (): AppError => new AppError(409, 'PLAYERS_BUSY', 'Wait until the server is running or stopped.');

const unsupported = (): AppError =>
  new AppError(409, 'PLAYERS_UNSUPPORTED', 'The player lists are only kept as JSON files from Minecraft 1.7.6 on and cannot be managed for this version.');

const PENDING_NOTICE = msg('PLAYERS_PENDING');

// Java before 18 reads the console input in the Windows code page (cp1252), so anything beyond ASCII arrives garbled.
// German umlauts are written out; other characters cannot be sent safely while the server runs.
const TRANSLITERATION: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' };
export function asciiReason(text: string): string | null {
  const converted = text.replace(/[äöüÄÖÜß]/g, (char) => TRANSLITERATION[char] ?? char);
  return /^[\x20-\x7e]*$/.test(converted) ? converted : null;
}
const reasonNotAscii = (): AppError =>
  new AppError(
    422,
    'REASON_NOT_ASCII',
    'While the server is running, only ASCII characters are possible in the reason (umlauts and "ß" are transliterated). Please remove special characters or stop the server first.',
  );

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class PlayersService {
  constructor(private readonly options: PlayersServiceOptions) {}

  private dir(serverId: string): string {
    return path.join(this.options.serversDir, serverId);
  }

  private async facts(serverId: string): Promise<Facts> {
    const row = (await this.options.db.select({ mcVersion: servers.mcVersion }).from(servers).where(eq(servers.id, serverId)))[0];
    if (row === undefined) throw new AppError(404, 'SERVER_NOT_FOUND', 'The server was not found.');
    // versions that cannot be parsed are not Minecraft releases the lists are known for
    const supported = parseMcVersion(row.mcVersion) !== null && !mcAtMost(row.mcVersion, 1, 7, 5);
    const { doc } = await loadProperties(this.dir(serverId));
    const raw = doc.get('op-permission-level')?.trim() ?? '';
    const level = Number(raw);
    return {
      supported,
      whitelistEnabled: doc.get('white-list')?.trim().toLowerCase() === 'true',
      onlineMode: doc.get('online-mode')?.trim().toLowerCase() !== 'false',
      // vanilla accepts 0 to 4 (default 4); a 0 is kept as it is, /op then assigns level 0 like it does in vanilla
      opLevel: raw !== '' && Number.isInteger(level) && level >= 0 && level <= 4 ? level : 4,
    };
  }

  private async view(serverId: string, facts: Facts, extra: { pending?: boolean; notice?: Msg | null } = {}): Promise<PlayersView> {
    const dir = this.dir(serverId);
    const status = this.options.runtime.status(serverId);
    const corrupt: PlayerListKey[] = [];
    const load = async <K extends PlayerListKey>(key: K): Promise<ListTypes[K][]> => {
      if (!facts.supported) return [];
      const data = await readList(dir, key);
      if (data.corrupt) corrupt.push(key);
      return data.entries;
    };
    const [whitelist, ops, bannedPlayers, bannedIps] = await Promise.all([load('whitelist'), load('ops'), load('bannedPlayers'), load('bannedIps')]);
    return {
      supported: facts.supported,
      mode: status.state === 'online' ? 'live' : 'file',
      busy: !FILE_STATES.has(status.state) && status.state !== 'online',
      online: status.players,
      whitelistEnabled: facts.whitelistEnabled,
      onlineMode: facts.onlineMode,
      opPermissionLevel: facts.opLevel,
      whitelist,
      ops,
      bannedPlayers,
      bannedIps,
      corrupt,
      pending: extra.pending ?? false,
      notice: extra.notice?.text ?? null,
      noticeRef: extra.notice?.ref ?? null,
    };
  }

  async read(serverId: string): Promise<PlayersView> {
    return this.view(serverId, await this.facts(serverId));
  }

  // ---- whitelist ---------------------------------------------------------------------------

  addWhitelist(serverId: string, name: string): Promise<PlayersView> {
    return this.run(serverId, () => ({
      key: 'whitelist',
      command: () => `whitelist add ${name}`,
      lookup: name,
      done: (entries) => entries.some((entry) => same(entry.name, name)),
      edit: (entries, profile) => upsert(entries, (entry) => entry.uuid === profile?.uuid, { uuid: profile?.uuid ?? '', name: profile?.name ?? name }),
    }));
  }

  removeWhitelist(serverId: string, name: string): Promise<PlayersView> {
    return this.run(serverId, () => ({
      key: 'whitelist',
      command: (entries) => `whitelist remove ${matching(entries, name)[0]?.name ?? name}`,
      check: (entries) => {
        if (matching(entries, name).length === 0) throw notListed(name);
      },
      done: (entries) => !entries.some((entry) => same(entry.name, name)),
      edit: (entries) => without(entries, matching(entries, name)),
    }));
  }

  // Turns the whitelist on or off. Live: the console command, then the wait for server.properties to show it; stopped:
  // server.properties is edited directly under the lock.
  setWhitelistEnabled(serverId: string, enabled: boolean): Promise<PlayersView> {
    return this.options.lock.run(serverId, async () => {
      const facts = await this.facts(serverId);
      const state = this.options.runtime.status(serverId).state;
      const live = state === 'online';
      if (!live && !FILE_STATES.has(state)) throw busy();
      const dir = this.dir(serverId);
      if (!live) {
        const { doc, exists } = await loadProperties(dir);
        // like the properties service: a new file must name the port that was chosen at creation
        if (!exists) {
          const row = (await this.options.db.select({ port: servers.port }).from(servers).where(eq(servers.id, serverId)))[0];
          if (row !== undefined) doc.set('server-port', String(row.port));
        }
        doc.set('white-list', String(enabled));
        await saveProperties(dir, doc);
        return this.view(serverId, await this.facts(serverId));
      }
      if (facts.whitelistEnabled === enabled) return this.view(serverId, facts);
      await this.options.runtime.sendCommand(serverId, `whitelist ${enabled ? 'on' : 'off'}`);
      const applied = await this.waitUntil(async () => (await this.facts(serverId)).whitelistEnabled === enabled);
      return this.view(serverId, await this.facts(serverId), applied ? {} : { pending: true, notice: PENDING_NOTICE });
    });
  }

  // ---- operators ---------------------------------------------------------------------------

  // `/op` always assigns the op-permission-level the server was started with (a later edit of server.properties only
  // counts after a restart) and keeps an existing player-limit flag, and a running server rewrites ops.json from memory.
  // So a different level or the player-limit flag is refused while the server runs and has to be set while it is
  // stopped; without a level the server's op-permission-level from the file is used. A file value of 0 is not changed
  // to 4: vanilla then assigns level 0 as well (such an operator can do nothing more than anybody else).
  addOp(serverId: string, input: OpInput): Promise<PlayersView> {
    const { name } = input;
    return this.run(serverId, (facts) => {
      const level = input.level ?? facts.opLevel;
      const bypassesPlayerLimit = input.bypassesPlayerLimit ?? false;
      const change: Change<'ops'> = {
        key: 'ops',
        command: () => `op ${name}`,
        lookup: name,
        done: (entries) => entries.some((entry) => same(entry.name, name)),
        edit: (entries, profile) =>
          upsert(entries, (entry) => entry.uuid === profile?.uuid, { uuid: profile?.uuid ?? '', name: profile?.name ?? name, level, bypassesPlayerLimit }),
      };
      if (level !== facts.opLevel || bypassesPlayerLimit) {
        change.liveError = new AppError(
          409,
          'OP_LEVEL_LIVE',
          `While the server is running, only the default level (${facts.opLevel}) is assigned. Please set a different level or "bypass player limit" while the server is stopped.`,
          { level: facts.opLevel },
        );
      }
      return change;
    });
  }

  removeOp(serverId: string, name: string): Promise<PlayersView> {
    return this.run(serverId, () => ({
      key: 'ops',
      command: (entries) => `deop ${matching(entries, name)[0]?.name ?? name}`,
      check: (entries) => {
        if (matching(entries, name).length === 0) throw notListed(name);
      },
      done: (entries) => !entries.some((entry) => same(entry.name, name)),
      edit: (entries) => without(entries, matching(entries, name)),
    }));
  }

  // ---- banned players ----------------------------------------------------------------------

  addBan(serverId: string, name: string, reason: string | undefined): Promise<PlayersView> {
    const text = reason === undefined || reason === '' ? undefined : reason;
    return this.run(serverId, () => ({
      key: 'bannedPlayers',
      command: () => banCommand(`ban ${name}`, text),
      ...liveReasonError(text),
      lookup: name,
      done: (entries) => entries.some((entry) => same(entry.name, name)),
      edit: (entries, profile, created) =>
        upsert(entries, (entry) => entry.uuid === profile?.uuid, {
          uuid: profile?.uuid ?? '',
          name: profile?.name ?? name,
          created,
          source: SOURCE,
          expires: 'forever',
          reason: text ?? DEFAULT_REASON,
        }),
    }));
  }

  removeBan(serverId: string, name: string): Promise<PlayersView> {
    return this.run(serverId, () => ({
      key: 'bannedPlayers',
      command: (entries) => `pardon ${matching(entries, name)[0]?.name ?? name}`,
      check: (entries) => {
        if (matching(entries, name).length === 0) throw notListed(name);
      },
      done: (entries) => !entries.some((entry) => same(entry.name, name)),
      edit: (entries) => without(entries, matching(entries, name)),
    }));
  }

  // ---- banned IPs --------------------------------------------------------------------------

  addIpBan(serverId: string, ip: string, reason: string | undefined): Promise<PlayersView> {
    const text = reason === undefined || reason === '' ? undefined : reason;
    return this.run(serverId, () => ({
      key: 'bannedIps',
      command: () => banCommand(`ban-ip ${ip}`, text),
      ...liveReasonError(text),
      done: (entries) => entries.some((entry) => same(entry.ip, ip)),
      edit: (entries, _profile, created) =>
        upsert(entries, (entry) => same(entry.ip, ip), { ip, created, source: SOURCE, expires: 'forever', reason: text ?? DEFAULT_REASON }),
    }));
  }

  removeIpBan(serverId: string, ip: string): Promise<PlayersView> {
    return this.run(serverId, () => ({
      key: 'bannedIps',
      command: () => `pardon-ip ${ip}`,
      check: (entries) => {
        if (!entries.some((entry) => same(entry.ip, ip))) throw notListed(ip);
      },
      done: (entries) => !entries.some((entry) => same(entry.ip, ip)),
      edit: (entries) => entries.filter((entry) => !same(entry.ip, ip)),
    }));
  }

  // ---- shared flow -------------------------------------------------------------------------

  private async profile(facts: Facts, name: string): Promise<Profile> {
    if (!facts.onlineMode) return { uuid: offlineUuid(name), name };
    // Floodgate/Geyser (Bedrock) players have no Mojang account; only the running server can resolve them
    if (name.startsWith(FLOODGATE_PREFIX)) {
      throw new AppError(
        409,
        'PLAYER_NAME_NEEDS_RUNNING_SERVER',
        `"${name}" is a Bedrock name (Floodgate/Geyser) and has no Mojang account, so the UUID cannot be determined while the server is stopped. Please start the server and add the player there.`,
        { name },
      );
    }
    return lookupMojangProfile(name, {
      fetch: this.options.fetch ?? fetch,
      userAgent: this.options.userAgent,
      ...(this.options.mojangUrl === undefined ? {} : { baseUrl: this.options.mojangUrl }),
      ...(this.options.timings?.lookupTimeoutMs === undefined ? {} : { timeoutMs: this.options.timings.lookupTimeoutMs }),
    });
  }

  private async run<K extends PlayerListKey>(serverId: string, build: (facts: Facts) => Change<K>): Promise<PlayersView> {
    const facts = await this.facts(serverId);
    if (!facts.supported) throw unsupported();
    const change = build(facts);
    // the schema checked the shape; with online-mode=true only Mojang names (or Bedrock names with ".") are accepted
    if (change.lookup !== undefined && !isAddableName(change.lookup, facts.onlineMode)) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'Invalid player name: on servers in online mode, 1 to 16 letters, digits or underscores are allowed (Bedrock names start with ".").',
      );
    }
    // the Mojang lookup happens outside the lock, so a slow answer does not hold up a start or a backup
    let profile: Profile | null = null;
    if (change.lookup !== undefined && FILE_STATES.has(this.options.runtime.status(serverId).state)) {
      profile = await this.profile(facts, change.lookup);
    }
    return this.options.lock.run(serverId, async () => {
      const state = this.options.runtime.status(serverId).state;
      const live = state === 'online';
      if (!live && !FILE_STATES.has(state)) throw busy();
      const dir = this.dir(serverId);
      const current = await readList(dir, change.key);
      if (current.corrupt) throw corruptListError(change.key);
      change.check?.(current.entries);

      if (!live) {
        if (profile === null && change.lookup !== undefined) profile = await this.profile(facts, change.lookup);
        const created = formatBanDate((this.options.now ?? (() => new Date()))());
        await writeList(dir, change.key, change.edit(current.entries, profile, created));
        return this.view(serverId, facts);
      }

      if (change.liveError !== undefined) throw change.liveError;
      if (change.done(current.entries)) return this.view(serverId, facts);
      await this.options.runtime.sendCommand(serverId, change.command(current.entries));
      const applied = await this.waitForFile(dir, change);
      return this.view(serverId, facts, applied ? {} : { pending: true, notice: PENDING_NOTICE });
    });
  }

  // The running server keeps the lists in memory and writes the file on every change
  private async waitForFile<K extends PlayerListKey>(dir: string, change: Change<K>): Promise<boolean> {
    return this.waitUntil(async () => {
      const latest = await readList(dir, change.key).catch(() => null);
      // a half-written file reads as corrupt for a moment; just look again
      return latest !== null && !latest.corrupt && change.done(latest.entries);
    });
  }

  // polls until the check passes or the wait time is over; a check that throws counts as "not yet"
  private async waitUntil(check: () => Promise<boolean>): Promise<boolean> {
    const deadline = Date.now() + (this.options.timings?.liveWaitMs ?? DEFAULT_LIVE_WAIT_MS);
    const pollMs = this.options.timings?.pollMs ?? DEFAULT_POLL_MS;
    for (;;) {
      await sleep(pollMs);
      if (await check().catch(() => false)) return true;
      if (Date.now() >= deadline) return false;
    }
  }
}

// the console command of a ban; the reason is converted to ASCII (see asciiReason), the caller refuses what does not fit
function banCommand(command: string, reason: string | undefined): string {
  return reason === undefined ? command : `${command} ${asciiReason(reason) ?? ''}`.trimEnd();
}

function liveReasonError(reason: string | undefined): { liveError?: AppError } {
  return reason !== undefined && asciiReason(reason) === null ? { liveError: reasonNotAscii() } : {};
}

function upsert<T>(entries: T[], matches: (entry: T) => boolean, entry: T): T[] {
  const index = entries.findIndex(matches);
  if (index < 0) return [...entries, entry];
  return entries.map((existing, i) => (i === index ? entry : existing));
}

function without<T>(entries: T[], removed: readonly T[]): T[] {
  return entries.filter((entry) => !removed.includes(entry));
}
