// Wire types of the HTTP and WebSocket API. The frontend imports this file with `import type` only, so it
// must stay free of runtime dependencies on Node: every import below is type-only or reaches a pure module.
//
// Translatable texts. Every human-readable text outside an AppError carries its English wording in the text field
// and, next to it, a reference { key, params? } (MessageRef) that a client can render in its own language:
//   - for a text field `x` the reference is `xRef` (`message`/`messageRef`, `error`/`errorRef`, `note`/`noteRef`,
//     `text`/`textRef` on console lines); for a list `xs` it is the parallel list `xRefs` (same order and length)
//   - a reference is null (or absent) where the text has no key: rows stored before references existed, output of
//     other programs (the update service's status text, the Minecraft server's console), text of the user
//   - a key is one of MessageKey (params in MessageParamsMap), the AppError code of an error (params in
//     ErrorParamsMap, the same as `error.params` of the HTTP error body), or MESSAGE_LIST (several messages in a row)
//   - a param is a string, a number or a nested MessageRef (the `reason` of a failure); unknown keys and missing
//     params fall back to the English text
//   - import notices have `code` (their key, unless `key` is set), `params` and `text`
import type { BackupKind, BackupStatus, DependencyType, InstallState, Loader, ModSource, UpdateStatus } from './db/enums.js';
import type { Backup, Mod, ModDependency, ModUpdateLogEntry as ModUpdateLogRow, Server } from './db/schema.js';
import type { AppEvent } from './events/bus.js';
import type { MessageParams, MessageRef } from './messages.js';
import type { InstallLogLine, InstallLogView } from './installer/install-log.js';
import type { LaunchSpec } from './installer/launch-spec.js';
import type { JavaRuntime } from './java/select.js';
import type { Category, SearchIndex, VersionType } from './modrinth/types.js';
import type { ConsoleLine, RuntimeStatus } from './process/types.js';
import type { PropertiesPatch, TypedProperties } from './properties/typed.js';
import type { CreateServerInput, UpdateServerInput } from './servers/schemas.js';
import type { InstallMode, LatestRelease, SystemUpdateState, UpdateHistoryEntry, UpdatePhase, UpdateProgress } from './update/types.js';

export type {
  AppEvent,
  BackupKind,
  BackupStatus,
  InstallLogLine,
  InstallLogView,
  Category,
  ConsoleLine,
  CreateServerInput,
  DependencyType,
  InstallState,
  JavaRuntime,
  LaunchSpec,
  Loader,
  Mod,
  ModDependency,
  ModSource,
  PropertiesPatch,
  RuntimeStatus,
  SearchIndex,
  TypedProperties,
  UpdateServerInput,
  UpdateStatus,
  VersionType,
};
export type { ErrorParamsMap, MessageKey, MessageParams, MessageParamsMap, MessageRef } from './messages.js';
export type { InstallMode, LatestRelease, SystemUpdateState, UpdateHistoryEntry, UpdatePhase, UpdateProgress };
export type { SelfUpdateResult } from './db/enums.js';
export type { ConsoleStream, ServerState } from './process/types.js';
export type * from './worldio/dto.js';

export interface ErrorBody {
  // params: the dynamic parts of the message (host, name, number, ...); details repeats them when nothing else is in there
  error: { code: string; message: string; details?: unknown; params?: MessageParams };
}

// One row of the mod update log; errorRef belongs to `error`
export type ModUpdateLogEntry = Omit<ModUpdateLogRow, 'errorRef'> & { errorRef: MessageRef | null };

export interface ServerDto extends Omit<Server, 'launchSpec' | 'installErrorRef'> {
  launchSpec: LaunchSpec | null;
  // key and params for `installError`; null for errors stored before references existed
  installErrorRef: MessageRef | null;
  status: RuntimeStatus;
}

export interface HealthInfo {
  status: 'ok';
  database: 'ok';
  version?: string;
  uptimeSeconds?: number;
  lanUrls?: string[];
}

export interface SystemInfo {
  totalMemoryMb: number;
  freeMemoryMb: number;
  cpuCount: number;
  platform: string;
  arch: string;
  javaRuntimes: JavaRuntime[];
  // whether a missing Java is installed automatically (JAVA_AUTO_INSTALL)
  javaAutoInstall: boolean;
  managedJava: ManagedJavaDto[];
  javaInstalls: JavaInstallState[];
}

export interface ManagedJavaDto {
  major: number;
  version: string;
  release: string;
  image: 'jre' | 'jdk';
  sha256: string;
  installedAt: number;
  sizeBytes: number;
  javaPath: string;
  origin: string;
  originRef: MessageRef;
  // names of running or starting servers that use it; a runtime in use cannot be removed
  inUseBy: string[];
}

export interface JavaInstallState {
  major: number;
  phase: string | null;
  percent: number | null;
  message: string | null;
  messageRef: MessageRef | null;
}

export interface JavaInstallResponse {
  runtime: JavaRuntime;
  alreadyInstalled: boolean;
}

export interface AuthStatus {
  authRequired: boolean;
  authenticated: boolean;
  // what the login asks for: the access token of the config file (until a password is set) or the password chosen in the UI
  credential: 'none' | 'token' | 'password';
}

export interface ChangePasswordInput {
  currentPassword?: string;
  newPassword: string;
}

export interface NetworkAddress {
  address: string;
  interfaceName: string;
  url: string;
  // 10/8, 172.16/12 or 192.168/16
  private: boolean;
}

// Values chosen in the UI (null = not set, the config file decides)
export interface NetworkSettings {
  bindHost: string | null;
  port: number | null;
  // additional host names on top of ALLOWED_HOSTS
  allowedHosts: string[];
  publicAddress: string | null;
}

export interface NetworkValues {
  host: string;
  port: number;
  allowedHosts: string[];
}

export interface NetworkState {
  hostname: string;
  hostnameUrl: string;
  // physical adapters, the best candidate first
  lan: NetworkAddress[];
  // VPN and virtual adapters (WSL, Hyper-V, Docker, VirtualBox, Tailscale, ...)
  virtual: NetworkAddress[];
  // what the running process listens on right now
  active: NetworkValues & { urls: string[] };
  settings: NetworkSettings;
  // from the config file / environment
  defaults: NetworkValues;
  // what the next start will use
  pending: NetworkValues & { urls: string[] };
  publicUrl: string | null;
  restartRequired: boolean;
  // fallbacks that happened at the last start (address missing, port taken)
  warnings: string[];
  warningRefs: Array<MessageRef | null>;
  restart: { automatic: boolean; note: string; noteRef: MessageRef | null };
}

export interface NetworkInput {
  bindHost?: string | null;
  port?: number | null;
  allowedHosts?: string[];
  publicAddress?: string | null;
}

export interface RestartPlan {
  restarting: true;
  // the address(es) to open after the restart
  urls: string[];
  automatic: boolean;
  note: string;
  noteRef: MessageRef | null;
}

export interface LoaderInfo {
  id: Loader;
  name: string;
  supportsMods: boolean;
  requiresInstallerJava: boolean;
}

export interface McVersion {
  id: string;
  type: 'release' | 'snapshot';
}

export interface LoaderVersion {
  version: string;
  stable: boolean;
  recommended: boolean;
}

export interface PropertiesView {
  exists: boolean;
  properties: TypedProperties;
  // untyped keys, kept for compatibility; `entries` lists every key of the file
  extra: Record<string, string>;
  entries: PropertyEntry[];
}

// one definition of server.properties in file order; known is true when the key is in the catalog
export interface PropertyEntry {
  key: string;
  value: string;
  known: boolean;
}

export type PropertyType = 'boolean' | 'integer' | 'enum' | 'string';
export type PropertyCategory = 'world' | 'gameplay' | 'players' | 'network' | 'advanced';

// GET /api/properties/catalog returns { catalog: PropertyCatalogEntry[] }; values are always written as text
export interface PropertyCatalogEntry {
  key: string;
  type: PropertyType;
  category: PropertyCategory;
  default: string;
  min?: number;
  max?: number;
  options?: string[];
  suggestions?: string[];
  secret?: boolean;
}

// PUT /api/servers/:serverId/properties/entries; keys in `remove` are dropped from the file
export interface PropertiesEntriesPatch {
  set?: Record<string, string>;
  remove?: string[];
}

// Response of PUT /api/servers/:serverId/properties/entries: the new PropertiesView plus
// - restartRequired: the server is running, so changes only apply after a restart
// - levelNameChanged: the world folder the server uses is now a different one
// - liveOverwriteRisk: same condition as restartRequired (the server is starting, online or stopping). A running
//   server keeps some settings in memory and rewrites server.properties itself (for example on /whitelist on|off),
//   which can overwrite the edit just saved. The UI should warn about this.
export interface PropertiesEntriesResponse extends PropertiesView {
  restartRequired: boolean;
  levelNameChanged: boolean;
  liveOverwriteRisk: boolean;
}

export interface SearchHitDto {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  categories: string[];
  downloads: number;
  follows: number;
  iconUrl: string | null;
  serverSide: string | null;
  installed: boolean;
  // set when installed: the mod's id and whether it is switched on
  modId: string | null;
  enabled: boolean;
}

export interface SearchResponse {
  hits: SearchHitDto[];
  totalHits: number;
  offset: number;
  limit: number;
}

export interface RemoveResult {
  removed: Mod;
  orphaned: Mod[];
}

export interface ToggleResult {
  mod: Mod;
  // every mod whose state changed, the requested one first
  changed: Mod[];
  // dependencies that were switched on together with the requested mod
  dependencies: Mod[];
  warnings: string[];
  // parallel to `warnings`; the dependency warning has the key MOD_DEPENDENCY_ENABLED
  warningRefs: MessageRef[];
}

export interface ModBackupEntry {
  fileName: string;
  sizeBytes: number;
  createdAt: number;
  modName: string | null;
  logId: number | null;
  // would be deleted by the cleanup (older than the newest N of its mod)
  removable: boolean;
}

export interface ModBackupList {
  backups: ModBackupEntry[];
  totalBytes: number;
  keep: number;
}

export interface BackupDto extends Omit<Backup, 'worlds' | 'noteRef' | 'errorRef'> {
  worlds: string[];
  // key and params for `note` and `error`; null for rows written before references existed (or text without a key)
  noteRef: MessageRef | null;
  errorRef: MessageRef | null;
}

export interface BackupSchedule {
  intervalHours: number | null;
  keepLast: number;
  includeConfig: boolean;
}

export interface BackupListResponse {
  backups: BackupDto[];
  schedule: BackupSchedule;
  totalBytes: number;
  freeBytes: number | null;
  // a backup of this server is being written right now
  running: boolean;
}

export interface RestoreResponse {
  backup: BackupDto;
  safety: BackupDto | null;
  warnings: string[];
  warningRefs: Array<MessageRef | null>;
}

export interface ScanReport {
  scanned: number;
  added: number;
  renamed: number;
  // files whose state changed by a hand-made rename between .jar and .jar.disabled
  toggled: number;
  replaced: number;
  removed: number;
  identified: number;
  modrinthAvailable: boolean;
  warnings: string[];
  // parallel to `warnings`
  warningRefs: MessageRef[];
}

export interface UpdateCandidate {
  modId: string;
  projectId: string;
  name: string;
  currentVersionId: string;
  currentVersionNumber: string;
  newVersionId: string;
  newVersionNumber: string;
  versionType: VersionType;
  newFileName: string;
}

export interface UpdateResult {
  modId: string;
  name: string;
  status: UpdateStatus;
  error?: string;
  // key and params for `error` (set together with it)
  errorRef?: MessageRef;
}

export interface InstallResult {
  installed: Mod[];
  // switched-off mods that were needed and are active again
  reenabled: Mod[];
  warnings: string[];
  // parallel to `warnings`
  warningRefs: MessageRef[];
}

// ---- WebSocket messages ---------------------------------------------------------------------

export type ConsoleServerMessage =
  | { type: 'status'; status: RuntimeStatus }
  | { type: 'history'; lines: ConsoleLine[] }
  | { type: 'line'; line: ConsoleLine }
  | { type: 'ack'; id?: string }
  | { type: 'error'; code: string; message: string; id?: string }
  | { type: 'pong' };

export interface ConsoleClientCommand {
  type: 'command';
  command: string;
  id?: string;
}

export type EventsServerMessage =
  | { type: 'snapshot'; serverTime: number; servers: Array<{ serverId: string; status: RuntimeStatus }> }
  | AppEvent
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };


// ---- player lists (whitelist, operators, bans) ----

export type PlayerListKey = 'whitelist' | 'ops' | 'bannedPlayers' | 'bannedIps';

export interface WhitelistEntry {
  uuid: string;
  name: string;
}

export interface OpEntry {
  uuid: string;
  name: string;
  level: number;
  bypassesPlayerLimit: boolean;
}

// created: "yyyy-MM-dd HH:mm:ss Z"; expires: the same format or "forever"
export interface BanEntry {
  uuid: string;
  name: string;
  created: string;
  source: string;
  expires: string;
  reason: string;
}

export interface IpBanEntry {
  ip: string;
  created: string;
  source: string;
  expires: string;
  reason: string;
}

// Error details (AppError.details) of the player endpoints, for translating the messages:
// PLAYER_NOT_FOUND and PLAYER_NOT_LISTED: { name } (for IP bans: { name: <ip> }); OP_LEVEL_LIVE: { level } (the server's level)
// POST /api/servers/:serverId/players/whitelist-enabled { enabled: boolean } -> PlayersView
export interface PlayersView {
  // false for Minecraft versions before 1.7.6 (no JSON lists); the lists are then empty and cannot be changed
  supported: boolean;
  // live: the server is online and changes go through console commands; file: the files are edited directly
  mode: 'live' | 'file';
  // the server is starting or stopping: the lists can be read but not changed
  busy: boolean;
  online: string[];
  // white-list in server.properties
  whitelistEnabled: boolean;
  onlineMode: boolean;
  // op-permission-level in server.properties (0 to 4, vanilla default 4): the level `/op` assigns. A running server
  // uses the value it was started with, so after an edit of the file this can differ until the next restart.
  opPermissionLevel: number;
  whitelist: WhitelistEntry[];
  ops: OpEntry[];
  bannedPlayers: BanEntry[];
  bannedIps: IpBanEntry[];
  // lists whose file is damaged (shown as empty, never overwritten)
  corrupt: PlayerListKey[];
  // live change sent, but the file did not show it within the wait time (the server may still be working on it)
  pending: boolean;
  notice: string | null;
  // key (PLAYERS_PENDING) for `notice`
  noticeRef: MessageRef | null;
}
