// Wire types of the world import and export API. Type-only, so the frontend can import them through contract.ts.
import type { Loader } from '../db/enums.js';
import type { MessageParams, MessageRef } from '../messages.js';

export type ExportFormat = 'zip' | 'tar.gz';
export type ExportModsMode = 'none' | 'manifest' | 'jars';
export type ExportStatus = 'running' | 'ready' | 'failed';

export interface ExportOptionsDto {
  format: ExportFormat;
  mods: ExportModsMode;
  // server.properties, ops, whitelist, banned lists and the config folders
  includeConfig: boolean;
}

export interface ExportJobDto {
  id: string;
  serverId: string;
  source: 'server' | 'backup';
  status: ExportStatus;
  options: ExportOptionsDto;
  // name the browser saves the download under
  fileName: string;
  sizeBytes: number | null;
  error: string | null;
  // key and params for `error`; warningRefs is parallel to `warnings`
  errorRef: MessageRef | null;
  warnings: string[];
  warningRefs: Array<MessageRef | null>;
  createdAt: number;
  expiresAt: number | null;
}

export type NoticeLevel = 'info' | 'warn' | 'error';

export interface ImportNotice {
  // `params` are the dynamic parts of `text`. The message key is `code`, unless `key` is set (two texts share a code).
  code: string;
  key?: string;
  params?: MessageParams;
  level: NoticeLevel;
  text: string;
  // a warning the user has to acknowledge before the import is carried out
  needsConfirm: boolean;
}

export type ModSideDto = 'both' | 'server' | 'client' | 'unknown';
export type ModLoaderDto = 'fabric' | 'quilt' | 'forge' | 'neoforge' | 'paper';

export interface DetectedModDto {
  // stable identity within one import; sent back when choosing what to install
  key: string;
  modId: string | null;
  name: string;
  version: string | null;
  fileName: string | null;
  enabled: boolean;
  sha1: string | null;
  sha512: string | null;
  sizeBytes: number;
  loaders: ModLoaderDto[];
  side: ModSideDto;
  origin: 'jar' | 'manifest' | 'level.dat';
  projectId: string | null;
  versionId: string | null;
  dir: 'mods' | 'plugins';
}

export interface ImportAnalysisDto {
  archive: { format: 'zip' | 'tar.gz'; sizeBytes: number; entries: number; uncompressedBytes: number };
  source: 'cm-export' | 'server' | 'world';
  world: {
    folderName: string;
    levelName: string | null;
    layout: 'inside' | 'split' | 'unified';
    hasNether: boolean;
    hasEnd: boolean;
    otherWorlds: string[];
    gameType: number | null;
    hardcore: boolean | null;
    lastPlayed: number | null;
    singleplayerPlayer: boolean;
  };
  version: {
    mcVersion: string | null;
    approximate: boolean;
    dataVersion: number | null;
    preOneNine: boolean;
  };
  proposal: {
    loader: Loader;
    loaderVersion: string | null;
    mcVersion: string | null;
    evidence: string[];
    // parallel to `evidence`
    evidenceRefs: Array<MessageRef | null>;
  };
  modded: boolean;
  config: { properties: boolean; items: string[] };
  mods: DetectedModDto[];
  hasJars: boolean;
  manifest: { appVersion: string; createdAt: string; mcVersion: string; loader: Loader; loaderVersion: string | null } | null;
  notices: ImportNotice[];
}

export type ImportStatus = 'uploading' | 'analyzing' | 'staged' | 'applying' | 'done' | 'failed';

export interface ImportResultDto {
  serverId: string;
  // folders that were put in place
  folders: string[];
  jarsPlaced: string[];
  modsInstalled: string[];
  modsFailed: Array<{ name: string; reason: string; reasonRef: MessageRef | null }>;
  safetyBackupId: string | null;
  warnings: string[];
  // parallel to `warnings`
  warningRefs: Array<MessageRef | null>;
}

export interface ImportJobDto {
  id: string;
  // 'new': becomes a new server; 'replace': replaces the world of serverId
  mode: 'new' | 'replace';
  serverId: string | null;
  status: ImportStatus;
  phase: string | null;
  message: string | null;
  messageRef: MessageRef | null;
  error: string | null;
  errorRef: MessageRef | null;
  analysis: ImportAnalysisDto | null;
  result: ImportResultDto | null;
  createdAt: number;
  expiresAt: number;
}

export type ModMatchState =
  // the jar from the archive is used; known: Modrinth recognised its hash, so it stays updatable
  | 'jar-known'
  | 'jar'
  | 'wrong-loader'
  // not in the archive, found on Modrinth for the target version
  | 'found'
  | 'ambiguous'
  | 'incompatible'
  | 'not-found'
  | 'client-only';

export interface ModCandidateDto {
  projectId: string;
  slug: string;
  title: string;
}

export interface ModMatchDto {
  key: string;
  state: ModMatchState;
  projectId: string | null;
  projectTitle: string | null;
  versionId: string | null;
  versionNumber: string | null;
  candidates: ModCandidateDto[];
  // what the dialog preselects
  selected: boolean;
}

export interface ImportReviewDto {
  notices: ImportNotice[];
  matches: ModMatchDto[];
  modrinthAvailable: boolean;
}

export interface ImportLimitsDto {
  maxUploadBytes: number;
}
