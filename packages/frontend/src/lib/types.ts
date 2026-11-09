import type {
  AppEvent,
  AuthStatus,
  BackupDto,
  BackupListResponse,
  BackupSchedule,
  Category,
  ConsoleClientCommand,
  ConsoleLine,
  ConsoleServerMessage,
  ChangePasswordInput,
  CreateServerInput,
  EventsServerMessage,
  HealthInfo,
  InstallLogLine,
  InstallLogView,
  InstallResult,
  JavaInstallResponse,
  JavaInstallState,
  JavaRuntime,
  LoaderInfo,
  LoaderVersion,
  ManagedJavaDto,
  McVersion,
  Mod,
  ModBackupEntry,
  ModBackupList,
  ModUpdateLogEntry,
  NetworkInput,
  NetworkState,
  PropertiesPatch,
  PropertiesView,
  RemoveResult,
  RestartPlan,
  RestoreResponse,
  RuntimeStatus,
  ScanReport,
  SearchIndex,
  SearchResponse,
  ServerDto,
  SystemInfo,
  SystemUpdateState,
  ToggleResult,
  TypedProperties,
  UpdateCandidate,
  UpdateResult,
  UpdateServerInput,
} from '@worldfoundry/backend/contract';

export type {
  AppEvent,
  AuthStatus,
  BackupSchedule,
  Category,
  ConsoleClientCommand,
  ConsoleLine,
  ConsoleServerMessage,
  ChangePasswordInput,
  CreateServerInput,
  EventsServerMessage,
  HealthInfo,
  InstallLogLine,
  InstallLogView,
  InstallResult,
  JavaInstallResponse,
  JavaInstallState,
  JavaRuntime,
  LoaderInfo,
  LoaderVersion,
  ManagedJavaDto,
  McVersion,
  NetworkInput,
  NetworkState,
  PropertiesPatch,
  PropertiesView,
  RestartPlan,
  RuntimeStatus,
  ScanReport,
  SearchIndex,
  SearchResponse,
  SystemInfo,
  SystemUpdateState,
  TypedProperties,
  UpdateCandidate,
  UpdateResult,
  UpdateServerInput,
};
export type {
  BanEntry,
  IpBanEntry,
  OpEntry,
  PlayerListKey,
  PlayersView,
  PropertiesEntriesPatch,
  PropertyCatalogEntry,
  PropertyCategory,
  PropertyEntry,
  PropertyType,
  WhitelistEntry,
} from '@worldfoundry/backend/contract';
export type { InstallMode, LatestRelease, SelfUpdateResult, UpdateHistoryEntry, UpdatePhase, UpdateProgress } from '@worldfoundry/backend/contract';
export type { BackupKind, BackupStatus, ConsoleStream, DependencyType, InstallState, Loader, ServerState, UpdateStatus } from '@worldfoundry/backend/contract';
// Translatable texts: a message reference sits next to each English text (see contract.ts)
export type { ErrorParamsMap, MessageKey, MessageParams, MessageParamsMap, MessageRef } from '@worldfoundry/backend/contract';

// What the types of the backend look like after JSON.stringify: dates become ISO strings.
export type Wire<T> = T extends Date
  ? string
  : T extends readonly (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

export type ServerView = Wire<ServerDto>;
export type ModView = Wire<Mod>;
export type BackupView = Wire<BackupDto>;
export type BackupListView = Wire<BackupListResponse>;
export type RestoreView = Wire<RestoreResponse>;
export type ToggleView = Wire<ToggleResult>;
export type ModBackupListView = ModBackupList;
export type ModBackupView = ModBackupEntry;
export type ModLogEntry = Wire<ModUpdateLogEntry>;
export type RemoveResultView = Wire<RemoveResult>;
export type InstallResultView = Wire<InstallResult>;

export interface ScanAndUpdates {
  updates: UpdateCandidate[];
  scan: ScanReport;
}

// PUT /properties/entries answers the file after the write plus two flags
// liveOverwriteRisk: the server runs or starts, so console commands and the next start can overwrite the change
export type PropertiesEntriesResult = PropertiesView & { restartRequired: boolean; levelNameChanged: boolean; liveOverwriteRisk?: boolean };

export interface OpInput {
  name: string;
  level?: number;
  bypassesPlayerLimit?: boolean;
}
