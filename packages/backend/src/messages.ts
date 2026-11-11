// Translatable messages. Every human-readable text the backend sends outside of an AppError (status messages, job
// progress and errors, warnings, notices, console "system" lines) is created from a template in this table. The wire
// format carries the English text unchanged plus a sibling reference { key, params }, so a client can render its own
// wording and fall back to the English text for unknown keys or for rows stored before the reference existed.
//
// Convention: for a text field `x` the sibling is `xRef` (`messageRef`, `errorRef`, `noteRef`, `textRef`), for a
// list `xs: string[]` the sibling is the parallel list `xRefs` (same length and order). A reference is null/absent
// where the text has no key (for example text that comes from outside, like a server's own console output).
// A reference whose key is an AppError code (for example UPSTREAM_UNREACHABLE) stands for the message of that
// error; its params are the `params` of the AppError. Param values are strings, numbers, or a nested reference
// (for example the `reason` of a failed job).
//
// This file must stay free of Node imports: the frontend imports its types through contract.ts.

export type MessageParamValue = string | number | MessageRef;
export type MessageParams = Record<string, MessageParamValue>;

export interface MessageRef {
  key: string;
  params?: MessageParams;
}

// A text together with its reference. Internal: DTOs carry the two parts as separate fields.
export interface Msg {
  text: string;
  ref: MessageRef;
}

// how a process ended: by a signal, with an exit code, or unknown
const exitText = (p: { code?: number; signal?: string }): string => (p.signal !== undefined ? `Signal ${p.signal}` : `exit code ${p.code ?? 'unknown'}`);

// names joined by comma, with the number of further names that were left out
const nameList = (p: { names: string; more: number }): string => (p.more > 0 ? `${p.names} and ${p.more} more` : p.names);

const worldLabel = (p: { worldVersion: string; estimated: 'yes' | 'no' }): string =>
  p.worldVersion === '' ? 'an unknown version' : `Minecraft ${p.worldVersion}${p.estimated === 'yes' ? ' (estimated)' : ''}`;

const TEMPLATES = {
  // ---- console lines and runtime status (process manager) ----
  SERVER_STOPPING: () => 'Stopping the server ...',
  SERVER_RESTARTING: () => 'Restarting the server ...',
  SERVER_KILLING: () => 'Killing the server immediately ...',
  SERVER_STOPPING_APP_SHUTDOWN: () => 'The application is shutting down, stopping the server ...',
  SERVER_STARTING: (p: { major: number; port: number }) => `Starting the server (Java ${p.major}, port ${p.port}) ...`,
  SERVER_STARTING_GAME: (p: { game: string; port: number }) => `Starting the ${p.game} server (port ${p.port}) ...`,
  START_NOTE: (p: { note: Msg }) => `Note: ${p.note.text}`,
  START_FAILED_REASON: (p: { reason: Msg }) => `The server could not be started: ${p.reason.text}`,
  JAVA_AUTO_INSTALL_NOTICE: (p: { major: number }) =>
    `Java ${p.major} is not installed and will now be installed automatically (Eclipse Temurin, for WorldFoundry only) ...`,
  JAVA_INSTALLING: (p: { major: number }) => `Installing Java ${p.major} ...`,
  JAVA_INSTALLING_PERCENT: (p: { major: number; percent: number }) => `Installing Java ${p.major} (${p.percent} %) ...`,
  JAVA_INSTALLED_STARTING: (p: { major: number }) => `Java ${p.major} is installed. Starting the server ...`,
  JAVA_INSTALL_FAILED_GENERIC: () => 'The Java installation failed.',
  START_CANCELLED_JAVA: () => 'Start cancelled. The Java installation is being stopped.',
  SERVER_EXITED_UNEXPECTEDLY: (p: { code?: number; signal?: string }) => `The server exited unexpectedly (${exitText(p)}).`,
  SERVER_STOPPED: (p: { code?: number; signal?: string }) => `Server stopped (${exitText(p)}).`,
  SERVER_STOP_TIMEOUT: (p: { seconds: number }) => `The server did not stop within ${p.seconds} seconds and is being killed.`,
  SERVER_NOT_REPORTED_STARTED: () =>
    'The server has not reported being started yet. Large modpacks often need several minutes; it is not being stopped.',
  START_UNEXPECTED_ERROR: () => 'Unexpected error while starting.',
  JAVA_FORGE_OLD_NOTE: () => 'Forge for Minecraft up to 1.16.5 often does not run with Java versions newer than 11. Java 8 is recommended.',
  MODS_UPDATE_CHECK_FAILED: () => 'The update check failed.',
  // ---- self-update ----
  UPDATE_CHECKS_DISABLED: () => 'Update checks are turned off in the configuration (UPDATE_CHECK=false).',
  UPDATE_ALREADY_RUNNING: () => 'An update is already running.',
  UPDATE_NO_NEWER: () => 'There is no newer release.',
  UPDATE_RESTART_BLOCKED: () => 'An update is currently running. A restart is possible afterwards.',
  UPDATE_CHECK_FAILED_GENERIC: () => 'The update check failed.',
  UPDATE_NOTE_PORTABLE: () =>
    'This installation runs without an update service (portable ZIP or an older installation). New versions are shown but not installed automatically: please download the new package and install it as described in the README (Installation section).',
  UPDATE_NOTE_DEV: () => 'WorldFoundry is running from source code. Please apply updates with git pull, npm install and npm run build.',
  UPDATE_NO_PACKAGES: (p: { platform: string; arch: string }) => `There are no ready-made update packages for ${p.platform}/${p.arch}.`,
  UPDATE_NO_ASSET: (p: { version: string; asset: string }) => `The release ${p.version} does not contain a package for this system (${p.asset}).`,
  UPDATE_UNSIGNED_RELEASE: () =>
    'The release does not contain signed checksums (SHA256SUMS.txt and SHA256SUMS.txt.sig). It is not installed automatically.',
  UPDATE_WAIT_INSTALL: () => 'A server installation is currently running. The update is possible afterwards.',
  UPDATE_WAIT_BACKUP: () => 'A backup is currently being written. The update is possible afterwards.',
  UPDATE_WAIT_JAVA: () => 'A Java runtime is currently being installed. The update is possible afterwards.',
  UPDATE_WAIT_EXPORT: () => 'A world is currently being exported. The update is possible afterwards.',
  UPDATE_WAIT_IMPORT: () => 'A world import is currently running. The update is possible afterwards.',
  UPDATE_PROGRESS_DOWNLOADING: (p: { version: string }) => `Downloading update to ${p.version} …`,
  UPDATE_PROGRESS_VERIFYING: () => 'Verifying signature and checksum …',
  UPDATE_PROGRESS_NO_SERVERS: () => 'No servers are running. Handing over the update …',
  UPDATE_PROGRESS_COUNTDOWN: (p: { seconds: number }) => `Servers will be stopped in ${p.seconds} s (players were warned).`,
  UPDATE_PROGRESS_STOPPING: (p: { count: number }) => `Stopping ${p.count} ${p.count === 1 ? 'server' : 'servers'} …`,
  UPDATE_PROGRESS_DB_BACKUP: () => 'Backing up the database …',
  UPDATE_PROGRESS_HANDOVER: () => 'Handing the update over to the update service …',
  UPDATE_PROGRESS_RESTARTING: () => 'WorldFoundry is restarting. This page reconnects automatically.',
  UPDATE_PROGRESS_CHECKING_PACKAGE: () => 'The update service is checking the package …',
  UPDATE_PROGRESS_FINISHING: () => 'Finishing the update …',
  UPDATE_CANCELLED_BY_ADMIN: () => 'Cancelled by the administrator.',
  UPDATE_REJECTED_BY_UPDATER: () => 'The update service rejected the update.',
  UPDATE_FAILED_UNEXPECTED: () => 'The update failed for an unexpected reason.',
  UPDATE_SUCCESS: (p: { version: string }) => `Updated to version ${p.version}.`,
  UPDATE_ROLLED_BACK_DEFAULT: () => 'The update failed, the previous version was restored.',
  UPDATE_FAILED_DEFAULT: () => 'The update failed.',
  UPDATE_NO_REPORT: () => 'The update was not completed: the update service did not report back.',
  UPDATE_INTERRUPTED_BEFORE_HANDOVER: () => 'The update was interrupted before it was handed over. The servers were started again.',
  // ---- network ----
  NETWORK_ADDRESS_MISSING: (p: { host: string }) =>
    `The address ${p.host} does not exist on this machine (network adapter disconnected or address changed). WorldFoundry therefore listens on all adapters (0.0.0.0). Please check the setting under System > Network & Access.`,
  NETWORK_PORT_FALLBACK: (p: { port: number; defaultPort: number }) =>
    `The saved port ${p.port} is already in use. WorldFoundry uses port ${p.defaultPort} from the configuration instead. Please check the setting under System > Network & Access.`,
  NETWORK_RESTART_AUTOMATIC: () => 'The service restarts WorldFoundry by itself after it exits (takes about 5 to 15 seconds).',
  NETWORK_RESTART_MANUAL: () => 'This installation runs without a service: WorldFoundry exits and has to be started again by hand.',
  // ---- players ----
  PLAYERS_PENDING: () => 'The server has not written the change to the file yet. It will become visible shortly, as soon as the server has processed it.',
  // ---- mod updates ----
  MOD_UPDATE_UNEXPECTED: () => 'Unexpected error during the update.',
  MOD_UPDATE_GONE: () => 'Mod no longer exists.',
  MOD_UPDATE_BACKUP_KEPT: (p: { reason: Msg; backup: string }) => `${p.reason.text} The original file is still in the backup folder (${p.backup}).`,
  // ---- mods: scan, toggle and install warnings ----
  MOD_SCAN_UNREADABLE: (p: { file: string }) => `File "${p.file}" could not be read and was skipped.`,
  MOD_SCAN_RENAME_CONFLICT: (p: { file: string }) => `Rename to "${p.file}" could not be applied (conflict in the database).`,
  MOD_SCAN_ENTRY_REMOVED: (p: { file: string }) => `The entry for "${p.file}" was removed and will be recorded again on the next scan.`,
  MOD_SCAN_TWIN_FILES: (p: { kept: string; ignored: string; content: 'identical' | 'different' }) =>
    `Both "${p.kept}" and "${p.ignored}" are in the folder (${p.content} content). The file "${p.ignored}" is ignored; please remove one of them.`,
  MOD_SCAN_IDENTICAL: (p: { ignored: string; preferred: string }) => `File "${p.ignored}" is identical to "${p.preferred}" and is ignored.`,
  MOD_SCAN_CONFLICT: (p: { kind: 'changed' | 'new'; file: string }) =>
    `${p.kind === 'changed' ? 'Changed' : 'New'} file "${p.file}" could not be applied (conflict in the database).`,
  MOD_SCAN_MODRINTH_DOWN: () => 'Modrinth is not reachable, unknown files remain unrecognized for now.',
  MOD_SCAN_PROJECT_INSTALLED: (p: { file: string; project: string }) =>
    `File "${p.file}" belongs to the already installed project "${p.project}" and remains unrecognized.`,
  MOD_DEPENDENCY_ENABLED: (p: { name: string }) => `"${p.name}" was disabled and has also been enabled as a required dependency.`,
  // dependents: the names in quotes, separated by comma
  MOD_DISABLED_ANYWAY: (p: { name: string; dependents: string }) => `"${p.name}" is disabled anyway, although it is required by ${p.dependents}.`,
  MOD_REENABLED: (p: { name: string; by: string }) => `"${p.name}" was disabled and is enabled again because "${p.by}" requires it.`,
  MOD_DEPENDENCY_EXTERNAL: (p: { dependency: string; parent: string }) =>
    `The dependency "${p.dependency}" of "${p.parent}" is hosted outside Modrinth and must be provided manually.`,
  MOD_DEPENDENCY_VERSION_CLASH: (p: { parent: string; mod: string }) =>
    `A dependency of "${p.parent}" requests a different version of "${p.mod}"; the version already chosen is used.`,
  // ---- world import: progress, results and failures ----
  IMPORT_STEP_UPLOAD: () => 'Uploading archive',
  IMPORT_STEP_CHECK: () => 'Checking archive',
  IMPORT_STEP_ANALYZE: () => 'Analyzing world',
  IMPORT_STEP_CREATE: () => 'Creating server',
  IMPORT_STEP_WORLD: () => 'Importing world',
  IMPORT_STEP_MOD_FILES: () => 'Placing mod files',
  IMPORT_STEP_WAIT_INSTALL: () => 'Waiting for the server installation',
  IMPORT_STEP_MOD_INSTALL: (p: { name: string }) => `Installing mod: ${p.name}`,
  IMPORT_STEP_REPLACE: () => 'Replacing world',
  IMPORT_STEP_SAFETY: () => 'Creating a safety backup of the previous world',
  IMPORT_STEP_SWAP: () => 'Placing new world',
  IMPORT_UNEXPECTED: () => 'The import failed for an unexpected reason.',
  IMPORT_FAILED_GENERIC: () => 'The import failed.',
  IMPORT_PARTIAL: (p: { name: string; reason: Msg }) =>
    `The server "${p.name}" was created, but the world could not be imported completely: ${p.reason.text} The world can be imported again via "Replace world".`,
  IMPORT_ANNOUNCE_REPLACING: () => 'Replacing the world with an import ...',
  IMPORT_ANNOUNCE_REPLACED: () => 'The world was replaced by the import.',
  IMPORT_ANNOUNCE_FAILED: (p: { reason: Msg }) => `World import failed, the previous world is kept: ${p.reason.text}`,
  IMPORT_WARN_SINGLEPLAYER: () => 'The singleplayer save was imported as player data of the server.',
  IMPORT_WARN_ITEM: (p: { item: string }) => `"${p.item}" could not be imported.`,
  IMPORT_WARN_PROPERTIES: () => 'server.properties could not be imported.',
  IMPORT_WARN_MODLIST: () => 'The mod list could not be read.',
  IMPORT_WARN_MODLIST_REASON: (p: { reason: Msg }) => `The mod list could not be read: ${p.reason.text}`,
  IMPORT_MOD_FILE_FAILED: () => 'The file could not be saved.',
  IMPORT_MOD_INSTALL_FAILED: () => 'The installation failed.',
  // ---- world import: notices (the key is the notice code unless the notice says otherwise) ----
  WORLD_PRE_1_9_UPLOAD: () => 'This world is older than Minecraft 1.9 (no version information in level.dat). Please choose the Minecraft version yourself.',
  WORLD_PRE_1_9: () =>
    'This world is older than Minecraft 1.9 (level.dat contains no version information). Please choose the matching Minecraft version yourself. On the first start the world is converted to the chosen format, which cannot be undone.',
  VERSION_APPROX: (p: { dataVersion: string; mcVersion: string }) =>
    `The version was estimated as Minecraft ${p.mcVersion} from the data version ${p.dataVersion}.`,
  JARS_UNREADABLE: (p: { names: string }) => `These files are not readable jar files: ${p.names}.`,
  OTHER_WORLDS_UPLOAD: (p: { names: string; more: number }) => `Other worlds in the archive are not imported: ${nameList(p)}.`,
  LOADER_VERSION_UNAVAILABLE: (p: { mcVersion: string; reason: Msg }) =>
    `The loader version for Minecraft ${p.mcVersion} could not be determined (${p.reason.text}). Please choose the loader and version yourself.`,
  WORLD_NEWER: (p: { worldVersion: string; estimated: 'yes' | 'no'; target: string; minimum: string }) =>
    `The world was last saved with ${worldLabel(p)} and is therefore newer than the chosen version ${p.target}. Downgrading a world to an older version damages it. Please choose at least ${p.minimum === '' ? 'the version of the world' : p.minimum}.`,
  WORLD_UPGRADE: (p: { worldVersion: string; estimated: 'yes' | 'no'; target: string }) =>
    `The world comes from ${worldLabel(p)} and is converted to ${p.target} on the first start. This only works in one direction: afterwards it can no longer be opened with the old version. Keep a backup of the source beforehand.`,
  WORLD_PATCH_UPGRADE: (p: { worldVersion: string; estimated: 'yes' | 'no'; target: string }) =>
    `The world comes from ${worldLabel(p)} and is upgraded to ${p.target} on start.`,
  WORLD_VERSION_UNKNOWN: () => 'The Minecraft version of the world could not be determined. If a version that is too old is chosen, the world can be damaged.',
  MODDED_NO_LOADER: (p: { loader: string }) =>
    `The world contains content from mods, but ${p.loader} cannot load them. Modded blocks, items and entities will be lost.`,
  MODDED_PAPER: () => 'Paper does not load mods, only plugins. Modded blocks, items and entities of the world will be lost.',
  LOADER_SWITCH: (p: { from: string; to: string }) =>
    `The world belongs to ${p.from}, but ${p.to} is chosen. Mods are not interchangeable between mod loaders; mod content can be lost or the world may not load.`,
  LAYOUT_CONVERTED: (p: { style: 'split' | 'inside' }) =>
    p.style === 'split'
      ? 'Nether and End are moved into their own folders (_nether, _the_end) for Paper.'
      : 'Nether and End are moved from the Paper folders into the world folder (DIM-1, DIM1).',
  LAYOUT_UNIFIED: () => 'The world uses the new folder format with "dimensions" and is imported unchanged.',
  OTHER_WORLDS: (p: { names: string; more: number }) => `The archive contains other worlds that are not imported: ${nameList(p)}.`,
  SINGLEPLAYER_PLAYER: () =>
    'The singleplayer save (inventory, position) is imported for the server. It applies to the player with the same Mojang account ID, so the server should run in online mode.',
  REPLACE_ONE_WAY: () => 'The current world is replaced by the imported one. A safety backup is created automatically beforehand.',
  MODS_MISSING: (p: { names: string; more: number }) =>
    `These mods of the world are not provided: ${nameList(p)}. If the server starts without them, blocks and items of the mods can disappear from the world.`,
  // ---- world import: loader evidence ----
  LOADER_EVIDENCE_EXPORT: (p: { loader: string; version: string }) => `The export file names ${p.loader}${p.version === '' ? '' : ` ${p.version}`}.`,
  LOADER_EVIDENCE_FILES: (p: { count: number; loader: string }) => `${p.count} file(s) in the archive belong to ${p.loader}.`,
  LOADER_EVIDENCE_NEOFORGE_LIST: () => 'level.dat contains a NeoForge mod list.',
  LOADER_EVIDENCE_FORGE_LIST: () => 'level.dat contains a Forge mod list.',
  LOADER_EVIDENCE_FML: () => 'level.dat contains a Forge section (FML).',
  LOADER_EVIDENCE_BRAND: (p: { brand: string }) => `level.dat names the server brand "${p.brand}".`,
  LOADER_EVIDENCE_PAPER_HINTS: (p: { hints: string }) => `Indication of Bukkit/Paper: ${p.hints}.`,
  LOADER_EVIDENCE_NONE: () => 'No indication of mods or plugins found.',
  // ---- world export ----
  EXPORT_UNEXPECTED: () => 'The export failed for an unexpected reason.',
  EXPORT_FAILED_REASON: (p: { reason: Msg }) => `Export failed: ${p.reason.text}`,
  EXPORT_ANNOUNCE: () => 'Exporting the world ...',
  EXPORT_FINISHED: () => 'World export finished.',
  EXPORT_WARN_SYMLINKS: (p: { count: number }) => `${p.count} symlink(s) were not exported.`,
  // ---- backups ----
  BACKUP_ANNOUNCE_SAFETY: () => 'Creating a safety backup of the world ...',
  BACKUP_ANNOUNCE: () => 'Creating a backup of the world ...',
  BACKUP_FINISHED: () => 'World backup finished.',
  BACKUP_FAILED_REASON: (p: { reason: Msg }) => `Backup failed: ${p.reason.text}`,
  BACKUP_UNEXPECTED: () => 'The backup failed for an unexpected reason.',
  BACKUP_INTERRUPTED_SHUTDOWN: () => 'The backup was interrupted (the application was shut down).',
  BACKUP_NOTE_SYMLINKS: (p: { count: number }) => `${p.count} symlink(s) were not backed up.`,
  SAVE_ON_UNCONFIRMED: () => 'The server did not confirm save-on; please check that automatic saving is active again.',
  BACKUP_NOTE_BEFORE_RESTORE: (p: { fileName: string }) => `Created automatically before restoring ${p.fileName}.`,
  BACKUP_NOTE_BEFORE_IMPORT: () => 'Created automatically before the world was replaced by an import.',
  BACKUP_RESTORING: () => 'Restoring backup ...',
  BACKUP_RESTORED: () => 'Backup restored.',
  RESTORE_FAILED_REASON: (p: { reason: Msg }) => `Restore failed, the previous world is kept: ${p.reason.text}`,
  UNEXPECTED_ERROR: () => 'unexpected error',
  RESTORE_LEVEL_MISMATCH: (p: { restored: string; current: string }) =>
    `The restored world is named "${p.restored}", but the server uses "${p.current}" (level-name in server.properties). Please adjust the world name or use a backup that includes the configuration.`,
  // ---- server installation ----
  INSTALL_INTERRUPTED_SHUTDOWN: () => 'The installation was interrupted (the application was shut down).',
  INSTALL_UNEXPECTED_ERROR: () => 'An unexpected error occurred during the installation.',
  INSTALL_STEP_RESOLVE: () => 'Resolving version',
  INSTALL_STEP_DOWNLOAD: (p: { fileName: string; kib: number }) => `${p.fileName}: ${p.kib} KiB`,
  INSTALL_STEP_INSTALLER: () => 'Installer running',
  // SteamCMD: amounts and speed are already formatted ("1.2 GB", "12.3 MB/s")
  INSTALL_STEP_STEAM_DOWNLOAD: (p: { game: string; done: string; total: string; speed: string }) =>
    `${p.game}: ${p.done} of ${p.total}${p.speed === '' ? '' : ` · ${p.speed}`}`,
  INSTALL_STEP_STEAM_PREALLOCATE: (p: { game: string; total: string }) => `${p.game}: reserving ${p.total} of disk space`,
  INSTALL_STEP_STEAM_VERIFY: (p: { game: string; done: string; total: string }) => `${p.game}: checking files (${p.done} of ${p.total})`,
  INSTALL_STEP_STEAM_COMMIT: (p: { game: string; done: string; total: string }) => `${p.game}: writing files (${p.done} of ${p.total})`,
  INSTALL_DONE: () => 'Installation finished',
  // ---- managed Java runtimes ----
  JAVA_ORIGIN_MANAGED: (p: { date: string; version: string; image: 'JRE' | 'JDK'; sha: string }) =>
    `Installed automatically by WorldFoundry on ${p.date}: Eclipse Temurin ${p.version} (${p.image}), downloaded from api.adoptium.net, SHA-256 ${p.sha} verified. Located in the data folder and not registered in the system, the PATH or the registry.`,
  JAVA_STEP_METADATA: (p: { major: number }) => `Querying Java ${p.major} at Adoptium ...`,
  JAVA_STEP_DOWNLOAD: (p: { major: number; receivedMb: string; totalMb: string }) =>
    `Downloading Java ${p.major} (${p.receivedMb} of ${p.totalMb} MB)`,
  JAVA_STEP_VERIFY: (p: { major: number }) => `Checksum (SHA-256) of Java ${p.major} matches`,
  JAVA_STEP_EXTRACT: (p: { major: number }) => `Extracting Java ${p.major} ...`,
  JAVA_STEP_CHECK: (p: { major: number }) => `Checking Java ${p.major} ...`,
  JAVA_INSTALLED: (p: { major: number }) => `Java ${p.major} is installed.`,
  JAVA_INSTALL_FAILED: (p: { major: number }) => `Java ${p.major} could not be installed.`,
  AUTOSTART_SKIPPED: (p: { name: string; reason: 'not-installed' | 'eula' }) =>
    `Autostart of "${p.name}" skipped: ${p.reason === 'eula' ? 'EULA not accepted' : 'not installed'}`,
  AUTOSTART_FAILED_NAMED: (p: { name: string; reason: Msg }) => `Autostart of "${p.name}" failed: ${p.reason.text}`,
  AUTOSTART_FAILED: (p: { reason: Msg }) => `Autostart failed: ${p.reason.text}`,
  START_LABEL_FAILED: (p: { label: Msg; reason: Msg }) => `${p.label.text} failed: ${p.reason.text}`,
  START_AFTER_RESTART: () => 'Start after the restart',
  START_AFTER_UPDATE_FAILED: (p: { reason: Msg }) => `Start after the update failed: ${p.reason.text}`,
} satisfies Record<string, (p: never) => string>;

type Templates = typeof TEMPLATES;
export type MessageKey = keyof Templates;

// The params of the AppError codes that carry any (error.params in an error body, or the params of a reference whose
// key is the code). Codes that are not listed have none. All values are strings or numbers unless noted.
export interface ErrorParamsMap {
  ARCHIVE_UNSAFE: { entry: string; reason: string; detail: string };
  ARCHIVE_SOURCE_CHANGED: { file: string };
  ARCHIVE_TOO_LARGE: { entry: string } | { maxMb: number };
  ARCHIVE_PATH_TOO_LONG: { path: string };
  BACKUP_LEVEL_INVALID: { levelName: string };
  GAME_NOT_AVAILABLE: { game: string };
  BACKUP_TOO_DEEP: { path: string };
  TOO_MANY_ATTEMPTS: { seconds: number };
  JAVA_RUNTIME_NOT_FOUND: { major: number };
  JAVA_IN_USE: { major: number; servers: string };
  JAVA_INSTALL_RUNNING: { major: number };
  JAVA_INSTALL_INVALID: { major: number; found?: number };
  JAVA_NOT_FOUND: { major: number };
  UPSTREAM_INVALID: { host: string };
  UPSTREAM_TIMEOUT: { host: string };
  UPSTREAM_UNREACHABLE: { host: string };
  UPSTREAM_ERROR: { host: string; status: number };
  MODRINTH_BAD_RESPONSE: { status: number };
  DOWNLOAD_URL_REJECTED: { host: string };
  DOWNLOAD_FAILED: { status: number };
  FILE_EXISTS: { file: string; name?: string };
  FILE_LOCKED: { fileName: string };
  MOD_FILE_MISSING: { file: string; name: string };
  MOD_INCOMPATIBLE: { first: string; second: string };
  MOD_REQUIRED_BY_OTHERS: { name: string; dependents: string };
  MOD_DISABLED: { name: string };
  MOD_ALREADY_INSTALLED: { name: string };
  PLAN_TOO_LARGE: { max: number };
  NETWORK_ADDRESS_INVALID: { value: string };
  NETWORK_PORT_IN_USE: { port: number; server?: string };
  NETWORK_PORT_DENIED: { port: number };
  NETWORK_HOST_INVALID: { hosts: string } | { max: number };
  PLAYER_LOOKUP_FAILED: { reason: 'timeout' | 'unreachable' | 'rate-limited' | 'http' | 'unexpected'; status?: number };
  PLAYER_NOT_FOUND: { name: string };
  PLAYER_NOT_LISTED: { name: string };
  INVALID_COMMAND: { max: number };
  START_FAILED: { reason: 'java-not-found' | 'java-denied' | 'spawn-failed' };
  UPDATE_URL_REJECTED: { host: string };
  UPDATE_DOWNLOAD_FAILED: { status: number };
  UPDATE_SUMS_INVALID: { asset: string };
  // phase: the update phase; reason: the message of what blocks it (a reference)
  UPDATE_IN_PROGRESS: { phase: string } | { reason: MessageRef };
  UPDATE_BLOCKED: { reason: MessageRef };
  UPDATE_NOT_POSSIBLE: { reason?: MessageRef };
  IMPORT_TOO_MANY_MODS: { max: number };
  IMPORT_TOO_LARGE: { max: string };
  IMPORT_NOT_READY: { reason?: MessageRef };
  EXPORT_NOTHING: { levelName: string };
  EXPORT_MANIFEST_INVALID: { file: string; problem: 'too-large' | 'not-json' | 'unrecognized'; where?: string };
  NBT_INVALID: { detail: string };
  DISK_FULL: { purpose: 'backup' | 'restore' | 'export' | 'upload' | 'world-replace' | 'archive-extract' | 'java'; neededMb: number; freeMb: number; major?: number };
  INSTALLER_FAILED: { reason: 'not-started' } | { reason: 'exit'; exitCode: number | string; output: string };
  INSTALLER_TIMEOUT: { minutes: number; output: string };
}
type ParamsOf<K extends MessageKey> = Parameters<Templates[K]>[0];
type Wire<T> = { [P in keyof T]: T[P] extends Msg ? MessageRef : T[P] };

// Every key with the params it carries on the wire (a nested message is a MessageRef). `undefined` = no params.
export type MessageParamsMap = { [K in MessageKey]: Wire<ParamsOf<K>> } & {
  // several messages shown one after the other, joined by a space: params '1', '2', ... are the references in order
  MESSAGE_LIST: Record<string, MessageRef>;
};

export type MessageArgs<K extends MessageKey> = undefined extends ParamsOf<K> ? [params?: ParamsOf<K>] : [params: ParamsOf<K>];

const isMsg = (value: unknown): value is Msg =>
  typeof value === 'object' && value !== null && 'text' in value && 'ref' in value;

export function msg<K extends MessageKey>(key: K, ...args: MessageArgs<K>): Msg {
  const params = args[0] as Record<string, unknown> | undefined;
  const text = (TEMPLATES[key] as (p: unknown) => string)(params);
  if (params === undefined) return { text, ref: { key } };
  const wire: MessageParams = {};
  for (const [name, value] of Object.entries(params)) wire[name] = isMsg(value) ? value.ref : (value as string | number);
  return { text, ref: { key, params: wire } };
}

// Internal helpers: many functions take either a plain string (no key) or a Msg
export type Text = string | Msg;
export const textOf = (value: Text): string => (typeof value === 'string' ? value : value.text);
export const refOf = (value: Text | null): MessageRef | null => (value === null || typeof value === 'string' ? null : value.ref);

// A list of messages as the two parallel wire lists: the texts and their references (null where a text has no key)
export const textsOf = (items: readonly Text[]): string[] => items.map(textOf);
export const refsOf = (items: readonly Text[]): Array<MessageRef | null> => items.map(refOf);

// Persisted references (a JSON text next to the stored text). Old rows have none; unreadable values count as none.
export const serializeRef = (ref: MessageRef | null | undefined): string | null => (ref === null || ref === undefined ? null : JSON.stringify(ref));

export function parseRef(text: string | null | undefined): MessageRef | null {
  if (text === null || text === undefined) return null;
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value === 'object' && value !== null && typeof (value as MessageRef).key === 'string') return value as MessageRef;
  } catch {
    // fall through
  }
  return null;
}

// Several messages as one text (joined by a space). The reference is a MESSAGE_LIST of the parts, or null when one
// part has no reference.
export function joinMsgs(items: readonly Text[]): { text: string; ref: MessageRef | null } | null {
  if (items.length === 0) return null;
  if (items.length === 1) return { text: textOf(items[0] as Text), ref: refOf(items[0] as Text) };
  const refs = items.map(refOf);
  const text = items.map(textOf).join(' ');
  if (refs.some((ref) => ref === null)) return { text, ref: null };
  const params: Record<string, MessageRef> = {};
  refs.forEach((ref, index) => {
    params[String(index + 1)] = ref as MessageRef;
  });
  return { text, ref: { key: 'MESSAGE_LIST', params } };
}

// Messages collected one by one (warnings of a scan, a plan, a toggle); texts and references as parallel lists
export class MsgList {
  private readonly items: Msg[] = [];

  push(...messages: Msg[]): void {
    this.items.push(...messages);
  }

  get texts(): string[] {
    return this.items.map((item) => item.text);
  }

  get refs(): MessageRef[] {
    return this.items.map((item) => item.ref);
  }

  get length(): number {
    return this.items.length;
  }
}
