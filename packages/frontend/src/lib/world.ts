import type {
  ExportJobDto,
  ExportOptionsDto,
  ImportAnalysisDto,
  ImportJobDto,
  ImportLimitsDto,
  ImportNotice,
  ImportReviewDto,
  Loader,
  MessageRef,
  ModMatchDto,
  ServerDto,
} from '@worldfoundry/backend/contract';
import { getCurrentDictionary } from '../i18n/current';
import type { Dictionary } from '../i18n/types';
import { renderRef } from '../i18n/renderRef';
import { ApiError, NETWORK_ERROR, errorFromResponse, request } from './api';
import type { Wire } from './types';

export type ExportJobView = ExportJobDto;
export type ExportOptions = ExportOptionsDto;
export type ImportJobView = ImportJobDto;
export type ImportReview = ImportReviewDto;
export type ImportNoticeView = ImportNotice;
export type ModMatchView = ModMatchDto;

// The text of an import notice in the active language: the notice is keyed by its code (or `key`) with its params
export const noticeText = (notice: ImportNotice, t: Dictionary): string =>
  renderRef({ key: notice.key ?? notice.code, ...(notice.params === undefined ? {} : { params: notice.params }) }, t, notice.text);

const enc = encodeURIComponent;

export interface SelectionInput {
  jars: string[];
  install: Array<{ key: string; projectId: string; versionId?: string }>;
}

export interface CreateFromImportBody {
  server: { name: string; loader: Loader; mcVersion: string; loaderVersion?: string; port?: number; minRamMb?: number; maxRamMb?: number; eulaAccepted?: boolean };
  importConfig: boolean;
  selection: SelectionInput;
  acknowledged: string[];
}

export const worldApi = {
  startExport: async (serverId: string, options: ExportOptions): Promise<ExportJobView> =>
    (await request<{ export: ExportJobView }>(`/api/servers/${enc(serverId)}/exports`, { method: 'POST', body: options })).export,
  startBackupExport: async (serverId: string, backupId: string, format: ExportOptions['format']): Promise<ExportJobView> =>
    (await request<{ export: ExportJobView }>(`/api/servers/${enc(serverId)}/backups/${enc(backupId)}/export`, { method: 'POST', body: { format } })).export,
  getExport: async (id: string, signal?: AbortSignal): Promise<ExportJobView> =>
    (await request<{ export: ExportJobView }>(`/api/exports/${enc(id)}`, signal === undefined ? {} : { signal })).export,
  removeExport: (id: string): Promise<{ deleted: true }> => request(`/api/exports/${enc(id)}`, { method: 'DELETE' }),
  // a plain link: the browser sends the session cookie
  exportDownloadUrl: (id: string): string => `/api/exports/${enc(id)}/download`,

  limits: (signal?: AbortSignal): Promise<Wire<ImportLimitsDto>> => request('/api/imports/limits', signal === undefined ? {} : { signal }),
  getImport: async (id: string, signal?: AbortSignal): Promise<ImportJobView> =>
    (await request<{ import: ImportJobView }>(`/api/imports/${enc(id)}`, signal === undefined ? {} : { signal })).import,
  cancelImport: (id: string): Promise<{ deleted: true }> => request(`/api/imports/${enc(id)}`, { method: 'DELETE' }),
  review: (id: string, target: { loader: Loader; mcVersion: string } | null, signal?: AbortSignal): Promise<ImportReview> =>
    request(`/api/imports/${enc(id)}/review`, { method: 'POST', body: target ?? {}, ...(signal === undefined ? {} : { signal }) }),
  createServer: (id: string, body: CreateFromImportBody): Promise<{ server: ServerDto; import: ImportJobView }> =>
    request(`/api/imports/${enc(id)}/create-server`, { method: 'POST', body }),
  replaceWorld: async (serverId: string, importId: string, acknowledged: string[]): Promise<ImportJobView> =>
    (await request<{ import: ImportJobView }>(`/api/servers/${enc(serverId)}/world/replace`, { method: 'POST', body: { importId, acknowledged } })).import,
};

// Streams the file as the raw request body (no multipart, nothing is read into memory) and reports progress.
export function uploadArchive(file: File, serverId: string | null, onProgress: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<ImportJobView> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/imports${serverId === null ? '' : `?serverId=${enc(serverId)}`}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onerror = () => reject(new ApiError(0, NETWORK_ERROR, getCurrentDictionary().import.uploadFailed));
    xhr.onabort = () => reject(new DOMException(getCurrentDictionary().import.aborted, 'AbortError'));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve((JSON.parse(xhr.responseText) as { import: ImportJobView }).import);
        } catch {
          reject(new ApiError(xhr.status, 'INVALID_RESPONSE', getCurrentDictionary().errors.codes.INVALID_RESPONSE));
        }
      } else reject(errorFromResponse(xhr.status, xhr.responseText));
    };
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
  });
}

// The answer of a world import of a game other than Minecraft: the import became a backup and was restored
export interface GameImportView {
  safety: { id: string } | null;
  warnings: string[];
  warningRefs: Array<MessageRef | null>;
  imported: { worlds: string[]; configItems: string[] };
}

// Like uploadArchive: the raw file as the body, with progress. The answer comes once the world is in place.
export function uploadGameWorld(file: File, serverId: string, onProgress: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<GameImportView> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/servers/${enc(serverId)}/game-world/import?fileName=${enc(file.name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onerror = () => reject(new ApiError(0, NETWORK_ERROR, getCurrentDictionary().import.uploadFailed));
    xhr.onabort = () => reject(new DOMException(getCurrentDictionary().import.aborted, 'AbortError'));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as GameImportView);
        } catch {
          reject(new ApiError(xhr.status, 'INVALID_RESPONSE', getCurrentDictionary().errors.codes.INVALID_RESPONSE));
        }
      } else reject(errorFromResponse(xhr.status, xhr.responseText));
    };
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
  });
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException(getCurrentDictionary().import.aborted, 'AbortError'));
    });
  });

// Polls an import until it is no longer being worked on (staged, done or failed)
export async function waitForImport(id: string, onUpdate: (job: ImportJobView) => void, signal?: AbortSignal, intervalMs = 800): Promise<ImportJobView> {
  for (;;) {
    const job = await worldApi.getImport(id, signal);
    onUpdate(job);
    if (job.status === 'staged' || job.status === 'done' || job.status === 'failed') return job;
    await sleep(intervalMs, signal);
  }
}

export async function waitForExport(id: string, onUpdate: (job: ExportJobView) => void, signal?: AbortSignal, intervalMs = 800): Promise<ExportJobView> {
  for (;;) {
    const job = await worldApi.getExport(id, signal);
    onUpdate(job);
    if (job.status !== 'running') return job;
    await sleep(intervalMs, signal);
  }
}

// ---- pure helpers ---------------------------------------------------------------------------

export interface MatchChoice {
  selected: boolean;
  // for several hits on Modrinth: the project the user picked
  candidate: string | null;
}

export type Choices = Record<string, MatchChoice>;

export function initialChoices(matches: readonly ModMatchView[]): Choices {
  return Object.fromEntries(matches.map((match) => [match.key, { selected: match.selected, candidate: null }]));
}

// What goes to the backend: jars to place, projects to install
export function buildSelection(matches: readonly ModMatchView[], choices: Choices): SelectionInput {
  const jars: string[] = [];
  const install: SelectionInput['install'] = [];
  for (const match of matches) {
    const choice = choices[match.key];
    if (choice === undefined) continue;
    if ((match.state === 'jar' || match.state === 'jar-known') && choice.selected) jars.push(match.key);
    else if (match.state === 'found' && choice.selected && match.projectId !== null) {
      install.push({ key: match.key, projectId: match.projectId, ...(match.versionId === null ? {} : { versionId: match.versionId }) });
    } else if (match.state === 'ambiguous' && choice.candidate !== null) {
      install.push({ key: match.key, projectId: choice.candidate });
    }
  }
  return { jars, install };
}

export const needsAck = (notices: readonly ImportNoticeView[]): ImportNoticeView[] => notices.filter((notice) => notice.needsConfirm);
export const hasBlocker = (notices: readonly ImportNoticeView[]): boolean => notices.some((notice) => notice.level === 'error');
export const allAcknowledged = (notices: readonly ImportNoticeView[], acknowledged: readonly string[]): boolean =>
  needsAck(notices).every((notice) => acknowledged.includes(notice.code));

// Labels follow the active language; read at call time, so call these from components that use useI18n().
export const gameTypeLabel = (gameType: number): string | undefined =>
  (getCurrentDictionary().import.gameTypes as Record<number, string | undefined>)[gameType];

export const sourceLabel = (source: ImportAnalysisDto['source']): string => getCurrentDictionary().import.sources[source];

const MATCH_CHIP: Record<ModMatchView['state'], string> = {
  'jar-known': 'chip-ok',
  jar: '',
  'wrong-loader': 'chip-warn',
  found: 'chip-ok',
  ambiguous: 'chip-warn',
  incompatible: 'chip-bad',
  'not-found': 'chip-bad',
  'client-only': '',
};

export const matchLabel = (state: ModMatchView['state']): { text: string; chip: string } => ({
  text: getCurrentDictionary().import.matchStates[state],
  chip: MATCH_CHIP[state],
});

export const isBusyJob = (job: ImportJobView | null): boolean => job !== null && (job.status === 'uploading' || job.status === 'analyzing' || job.status === 'applying');
