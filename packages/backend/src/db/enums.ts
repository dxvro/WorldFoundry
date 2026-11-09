export const LOADERS = ['vanilla', 'fabric', 'neoforge', 'forge', 'paper'] as const;
export const INSTALL_STATES = ['pending', 'installing', 'installed', 'failed'] as const;
export const MOD_SOURCES = ['modrinth', 'curseforge', 'manual'] as const;
export const DEPENDENCY_TYPES = ['required', 'optional', 'incompatible', 'embedded'] as const;
export const UPDATE_STATUSES = ['success', 'failed', 'rolled_back'] as const;
export const BACKUP_KINDS = ['manual', 'auto', 'safety'] as const;
export const BACKUP_STATUSES = ['running', 'ok', 'failed'] as const;

export type Loader = (typeof LOADERS)[number];
export type InstallState = (typeof INSTALL_STATES)[number];
export type ModSource = (typeof MOD_SOURCES)[number];
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];
export type UpdateStatus = (typeof UPDATE_STATUSES)[number];
export type BackupKind = (typeof BACKUP_KINDS)[number];
export type BackupStatus = (typeof BACKUP_STATUSES)[number];

// outcome of an update of WorldFoundry itself
export const SELF_UPDATE_RESULTS = ['success', 'failed', 'rolled_back', 'cancelled'] as const;
export type SelfUpdateResult = (typeof SELF_UPDATE_RESULTS)[number];
