import { index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import { GAME_IDS } from '../games/types.js';
import { BACKUP_KINDS, SELF_UPDATE_RESULTS, BACKUP_STATUSES, DEPENDENCY_TYPES, INSTALL_STATES, LOADERS, MOD_SOURCES, UPDATE_STATUSES } from './enums.js';

export const servers = sqliteTable(
  'servers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    // which game adapter owns this server; rows from before the column existed are Minecraft servers
    game: text('game', { enum: GAME_IDS }).notNull().default('minecraft'),
    loader: text('loader', { enum: LOADERS }).notNull(),
    mcVersion: text('mc_version').notNull(),
    loaderVersion: text('loader_version'),
    installState: text('install_state', { enum: INSTALL_STATES }).notNull().default('pending'),
    installError: text('install_error'),
    // JSON of the MessageRef belonging to installError; null for rows written before references existed
    installErrorRef: text('install_error_ref'),
    launchSpec: text('launch_spec'),
    requiredJavaMajor: integer('required_java_major'),
    port: integer('port').notNull().default(25565),
    javaPath: text('java_path'),
    minRamMb: integer('min_ram_mb').notNull().default(1024),
    maxRamMb: integer('max_ram_mb').notNull().default(2048),
    useAikarFlags: integer('use_aikar_flags', { mode: 'boolean' }).notNull().default(false),
    extraJvmArgs: text('extra_jvm_args').notNull().default(''),
    eulaAccepted: integer('eula_accepted', { mode: 'boolean' }).notNull().default(false),
    autoStart: integer('auto_start', { mode: 'boolean' }).notNull().default(false),
    backupIntervalHours: integer('backup_interval_hours'),
    backupKeepLast: integer('backup_keep_last').notNull().default(7),
    backupIncludeConfig: integer('backup_include_config', { mode: 'boolean' }).notNull().default(false),
    backupScheduleSince: integer('backup_schedule_since', { mode: 'timestamp_ms' }),
    lastStartedAt: integer('last_started_at', { mode: 'timestamp_ms' }),
    lastExitCode: integer('last_exit_code'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('servers_port_idx').on(t.port)],
);

export const mods = sqliteTable(
  'mods',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    source: text('source', { enum: MOD_SOURCES }).notNull(),
    projectId: text('project_id'),
    versionId: text('version_id'),
    versionNumber: text('version_number'),
    name: text('name').notNull(),
    fileName: text('file_name').notNull(),
    sha512: text('sha512').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    isDependency: integer('is_dependency', { mode: 'boolean' }).notNull().default(false),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    installedAt: integer('installed_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    unique('mods_server_file_name_uq').on(t.serverId, t.fileName),
    unique('mods_server_sha512_uq').on(t.serverId, t.sha512),
    unique('mods_server_project_uq').on(t.serverId, t.projectId),
  ],
);

export const modDependencies = sqliteTable(
  'mod_dependencies',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    modId: text('mod_id')
      .notNull()
      .references(() => mods.id, { onDelete: 'cascade' }),
    dependencyType: text('dependency_type', { enum: DEPENDENCY_TYPES }).notNull(),
    projectId: text('project_id'),
    versionId: text('version_id'),
    fileName: text('file_name'),
    dependsOnModId: text('depends_on_mod_id').references(() => mods.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('mod_dependencies_mod_id_idx').on(t.modId),
    index('mod_dependencies_depends_on_mod_id_idx').on(t.dependsOnModId),
  ],
);

export const modUpdateLog = sqliteTable(
  'mod_update_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    modId: text('mod_id').references(() => mods.id, { onDelete: 'set null' }),
    modName: text('mod_name').notNull(),
    fromVersionId: text('from_version_id'),
    toVersionId: text('to_version_id'),
    fromFileName: text('from_file_name'),
    toFileName: text('to_file_name'),
    backupPath: text('backup_path'),
    status: text('status', { enum: UPDATE_STATUSES }).notNull(),
    error: text('error'),
    errorRef: text('error_ref'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('mod_update_log_server_created_idx').on(t.serverId, t.createdAt)],
);

export const backups = sqliteTable(
  'backups',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: BACKUP_KINDS }).notNull(),
    status: text('status', { enum: BACKUP_STATUSES }).notNull(),
    fileName: text('file_name').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    rawBytes: integer('raw_bytes').notNull().default(0),
    includesConfig: integer('includes_config', { mode: 'boolean' }).notNull().default(false),
    levelName: text('level_name').notNull(),
    worlds: text('worlds').notNull().default('[]'),
    note: text('note'),
    noteRef: text('note_ref'),
    error: text('error'),
    errorRef: text('error_ref'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('backups_server_created_idx').on(t.serverId, t.createdAt)],
);

// Small key/value store for settings of the application itself (self-update switches, the running update job, ...)
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

// One row per finished update of WorldFoundry itself
export const updateHistory = sqliteTable(
  'update_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    fromVersion: text('from_version').notNull(),
    toVersion: text('to_version').notNull(),
    result: text('result', { enum: SELF_UPDATE_RESULTS }).notNull(),
    message: text('message'),
    messageRef: text('message_ref'),
    stoppedServers: integer('stopped_servers').notNull().default(0),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('update_history_finished_idx').on(t.finishedAt)],
);

export type Server = typeof servers.$inferSelect;
export type NewServer = typeof servers.$inferInsert;
export type Mod = typeof mods.$inferSelect;
export type NewMod = typeof mods.$inferInsert;
export type ModDependency = typeof modDependencies.$inferSelect;
export type NewModDependency = typeof modDependencies.$inferInsert;
export type ModUpdateLogEntry = typeof modUpdateLog.$inferSelect;
export type NewModUpdateLogEntry = typeof modUpdateLog.$inferInsert;
export type Backup = typeof backups.$inferSelect;
export type NewBackup = typeof backups.$inferInsert;
export type UpdateHistoryRow = typeof updateHistory.$inferSelect;
export type NewUpdateHistoryRow = typeof updateHistory.$inferInsert;
