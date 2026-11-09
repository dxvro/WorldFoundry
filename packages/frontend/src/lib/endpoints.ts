import { request } from './api';
import type {
  AuthStatus,
  ChangePasswordInput,
  BackupListView,
  BackupSchedule,
  BackupView,
  Category,
  CreateServerInput,
  HealthInfo,
  InstallLogView,
  InstallResultView,
  JavaInstallResponse,
  Loader,
  LoaderInfo,
  LoaderVersion,
  McVersion,
  ModBackupListView,
  ModLogEntry,
  ModView,
  NetworkInput,
  NetworkState,
  OpInput,
  PlayersView,
  PropertiesEntriesPatch,
  PropertiesEntriesResult,
  PropertiesPatch,
  PropertyCatalogEntry,
  PropertiesView,
  RemoveResultView,
  RestartPlan,
  RestoreView,
  RuntimeStatus,
  ScanAndUpdates,
  ScanReport,
  SearchIndex,
  SearchResponse,
  ServerView,
  SystemInfo,
  SystemUpdateState,
  ToggleView,
  UpdateResult,
  UpdateServerInput,
} from './types';

const enc = encodeURIComponent;
const server = (id: string): string => `/api/servers/${enc(id)}`;

export const authApi = {
  status: (): Promise<AuthStatus> => request('/api/auth/status'),
  login: (token: string): Promise<AuthStatus> => request('/api/auth/login', { method: 'POST', body: { token }, ignoreUnauthorized: true }),
  logout: (): Promise<{ authenticated: false }> => request('/api/auth/logout', { method: 'POST', ignoreUnauthorized: true }),
  // a wrong current password answers 403 (not 401), so this never looks like a lost session
  changePassword: (input: ChangePasswordInput): Promise<AuthStatus> => request('/api/auth/password', { method: 'POST', body: input }),
};

export const networkApi = {
  state: (signal?: AbortSignal): Promise<NetworkState> => request('/api/system/network', signal === undefined ? {} : { signal }),
  save: (input: NetworkInput): Promise<NetworkState> => request('/api/system/network', { method: 'PUT', body: input }),
  restart: (): Promise<RestartPlan> => request('/api/system/restart', { method: 'POST', body: { confirm: true } }),
};

export const systemApi = {
  health: (): Promise<HealthInfo> => request('/api/health'),
  system: (rescan = false, signal?: AbortSignal): Promise<SystemInfo> =>
    request('/api/system', { query: rescan ? { rescan: true } : {}, ...(signal === undefined ? {} : { signal }) }),
  loaders: async (): Promise<LoaderInfo[]> => (await request<{ loaders: LoaderInfo[] }>('/api/loaders')).loaders,
  mcVersions: async (loader: Loader, snapshots: boolean, signal?: AbortSignal): Promise<McVersion[]> =>
    (await request<{ mcVersions: McVersion[] }>(`/api/loaders/${enc(loader)}/mc-versions`, { query: { snapshots }, ...(signal === undefined ? {} : { signal }) }))
      .mcVersions,
  installJava: (major: number): Promise<JavaInstallResponse> => request(`/api/java/runtimes/${major}/install`, { method: 'POST' }),
  removeJava: (major: number): Promise<{ removed: true }> => request(`/api/java/runtimes/${major}`, { method: 'DELETE' }),
  loaderVersions: async (loader: Loader, mcVersion: string, signal?: AbortSignal): Promise<LoaderVersion[]> =>
    (await request<{ versions: LoaderVersion[] }>(`/api/loaders/${enc(loader)}/versions`, { query: { mcVersion }, ...(signal === undefined ? {} : { signal }) }))
      .versions,
};

export const updateApi = {
  state: (signal?: AbortSignal): Promise<SystemUpdateState> => request('/api/system/update', signal === undefined ? {} : { signal }),
  check: (): Promise<SystemUpdateState> => request('/api/system/update/check', { method: 'POST' }),
  apply: (countdownSeconds?: number): Promise<SystemUpdateState> =>
    request('/api/system/update/apply', { method: 'POST', body: countdownSeconds === undefined ? { confirm: true } : { confirm: true, countdownSeconds } }),
  cancel: (): Promise<SystemUpdateState> => request('/api/system/update/cancel', { method: 'POST' }),
  dismiss: (): Promise<SystemUpdateState> => request('/api/system/update/dismiss', { method: 'POST' }),
  setAutoCheck: (autoCheck: boolean): Promise<SystemUpdateState> => request('/api/system/update/settings', { method: 'PATCH', body: { autoCheck } }),
};

export const serversApi = {
  list: async (signal?: AbortSignal): Promise<ServerView[]> =>
    (await request<{ servers: ServerView[] }>('/api/servers', signal === undefined ? {} : { signal })).servers,
  get: async (id: string, signal?: AbortSignal): Promise<ServerView> =>
    (await request<{ server: ServerView }>(server(id), signal === undefined ? {} : { signal })).server,
  create: async (input: CreateServerInput): Promise<ServerView> =>
    (await request<{ server: ServerView }>('/api/servers', { method: 'POST', body: input })).server,
  update: (id: string, input: UpdateServerInput): Promise<{ server: ServerView; restartRequired: boolean }> =>
    request(server(id), { method: 'PATCH', body: input }),
  remove: (id: string, backups?: 'delete' | 'keep'): Promise<{ deleted: true }> =>
    request(server(id), { method: 'DELETE', query: backups === undefined ? { confirm: true } : { confirm: true, backups } }),
  installLog: (id: string, tail = 500, signal?: AbortSignal): Promise<InstallLogView> =>
    request(`${server(id)}/install-log`, { query: { tail }, ...(signal === undefined ? {} : { signal }) }),
  install: async (id: string): Promise<ServerView> => (await request<{ server: ServerView }>(`${server(id)}/install`, { method: 'POST' })).server,
  start: (id: string): Promise<{ status: RuntimeStatus; warnings: string[] }> => request(`${server(id)}/start`, { method: 'POST' }),
  stop: (id: string): Promise<{ status: RuntimeStatus }> => request(`${server(id)}/stop`, { method: 'POST' }),
  restart: (id: string): Promise<{ status: RuntimeStatus; warnings: string[] }> => request(`${server(id)}/restart`, { method: 'POST' }),
  kill: (id: string): Promise<{ status: RuntimeStatus }> => request(`${server(id)}/kill`, { method: 'POST' }),
  properties: (id: string, signal?: AbortSignal): Promise<PropertiesView> =>
    request(`${server(id)}/properties`, signal === undefined ? {} : { signal }),
  patchProperties: (id: string, patch: PropertiesPatch): Promise<PropertiesView & { restartRequired: boolean }> =>
    request(`${server(id)}/properties`, { method: 'PATCH', body: patch }),
};

export interface SearchParams {
  query: string;
  categories: string[];
  index: SearchIndex;
  limit: number;
  offset: number;
}

export const modsApi = {
  list: async (id: string, signal?: AbortSignal): Promise<ModView[]> =>
    (await request<{ mods: ModView[] }>(`${server(id)}/mods`, signal === undefined ? {} : { signal })).mods,
  search: (id: string, params: SearchParams, signal?: AbortSignal): Promise<SearchResponse> =>
    request(`${server(id)}/mods/search`, {
      query: { query: params.query, categories: params.categories, index: params.index, limit: params.limit, offset: params.offset },
      ...(signal === undefined ? {} : { signal }),
    }),
  install: (id: string, projectId: string): Promise<InstallResultView> => request(`${server(id)}/mods`, { method: 'POST', body: { projectId } }),
  remove: (id: string, modId: string, force: boolean): Promise<RemoveResultView> =>
    request(`${server(id)}/mods/${enc(modId)}`, { method: 'DELETE', query: force ? { force: true } : {} }),
  setEnabled: (id: string, modId: string, enabled: boolean, force = false): Promise<ToggleView> =>
    request(`${server(id)}/mods/${enc(modId)}`, { method: 'PATCH', body: force ? { enabled, force } : { enabled } }),
  backups: (id: string, signal?: AbortSignal): Promise<ModBackupListView> => request(`${server(id)}/mods/backups`, signal === undefined ? {} : { signal }),
  cleanBackups: (id: string): Promise<{ removed: number; freedBytes: number }> => request(`${server(id)}/mods/backups/cleanup`, { method: 'POST' }),
  scan: (id: string): Promise<ScanReport> => request(`${server(id)}/mods/scan`, { method: 'POST' }),
  checkUpdates: (id: string): Promise<ScanAndUpdates> => request(`${server(id)}/mods/updates/check`, { method: 'POST' }),
  applyUpdates: (id: string, projectIds?: string[]): Promise<{ results: UpdateResult[] }> =>
    request(`${server(id)}/mods/updates/apply`, { method: 'POST', body: projectIds === undefined ? {} : { projectIds } }),
  updateLog: async (id: string, limit = 50, signal?: AbortSignal): Promise<ModLogEntry[]> =>
    (await request<{ entries: ModLogEntry[] }>(`${server(id)}/mods/update-log`, { query: { limit }, ...(signal === undefined ? {} : { signal }) }))
      .entries,
  categories: async (signal?: AbortSignal): Promise<Category[]> =>
    (await request<{ categories: Category[] }>('/api/modrinth/categories', signal === undefined ? {} : { signal })).categories,
};

export const backupsApi = {
  list: (id: string, signal?: AbortSignal): Promise<BackupListView> => request(`${server(id)}/backups`, signal === undefined ? {} : { signal }),
  create: async (id: string, includeConfig?: boolean): Promise<BackupView> =>
    (await request<{ backup: BackupView }>(`${server(id)}/backups`, { method: 'POST', body: includeConfig === undefined ? {} : { includeConfig } })).backup,
  remove: (id: string, backupId: string): Promise<{ deleted: true }> => request(`${server(id)}/backups/${enc(backupId)}`, { method: 'DELETE' }),
  restore: (id: string, backupId: string): Promise<RestoreView> => request(`${server(id)}/backups/${enc(backupId)}/restore`, { method: 'POST' }),
  setSchedule: async (id: string, schedule: Partial<BackupSchedule>): Promise<BackupSchedule> =>
    (await request<{ schedule: BackupSchedule }>(`${server(id)}/backups/schedule`, { method: 'PATCH', body: schedule })).schedule,
  // a plain link: the browser sends the session cookie, so the download works with and without a login
  downloadUrl: (id: string, backupId: string): string => `${server(id)}/backups/${enc(backupId)}/download`,
};

const players = (id: string): string => `${server(id)}/players`;

// Every change answers the whole PlayersView after the change
export const playersApi = {
  get: (id: string, signal?: AbortSignal): Promise<PlayersView> => request(players(id), signal === undefined ? {} : { signal }),
  addWhitelist: (id: string, name: string): Promise<PlayersView> => request(`${players(id)}/whitelist`, { method: 'POST', body: { name } }),
  removeWhitelist: (id: string, name: string): Promise<PlayersView> => request(`${players(id)}/whitelist/${enc(name)}`, { method: 'DELETE' }),
  addOp: (id: string, input: OpInput): Promise<PlayersView> => request(`${players(id)}/ops`, { method: 'POST', body: input }),
  removeOp: (id: string, name: string): Promise<PlayersView> => request(`${players(id)}/ops/${enc(name)}`, { method: 'DELETE' }),
  ban: (id: string, name: string, reason?: string): Promise<PlayersView> =>
    request(`${players(id)}/banned-players`, { method: 'POST', body: reason === undefined || reason === '' ? { name } : { name, reason } }),
  unban: (id: string, name: string): Promise<PlayersView> => request(`${players(id)}/banned-players/${enc(name)}`, { method: 'DELETE' }),
  banIp: (id: string, ip: string, reason?: string): Promise<PlayersView> =>
    request(`${players(id)}/banned-ips`, { method: 'POST', body: reason === undefined || reason === '' ? { ip } : { ip, reason } }),
  unbanIp: (id: string, ip: string): Promise<PlayersView> => request(`${players(id)}/banned-ips/${enc(ip)}`, { method: 'DELETE' }),
  setWhitelistEnabled: (id: string, enabled: boolean): Promise<PlayersView> => request(`${players(id)}/whitelist-enabled`, { method: 'POST', body: { enabled } }),
};

export const propertiesApi = {
  catalog: async (signal?: AbortSignal): Promise<PropertyCatalogEntry[]> =>
    (await request<{ catalog: PropertyCatalogEntry[] }>('/api/properties/catalog', signal === undefined ? {} : { signal })).catalog,
  setEntries: (id: string, patch: PropertiesEntriesPatch): Promise<PropertiesEntriesResult> => request(`${server(id)}/properties/entries`, { method: 'PUT', body: patch }),
};
