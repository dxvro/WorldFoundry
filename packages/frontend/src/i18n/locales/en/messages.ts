import type { MessageTexts } from '../../types';

// English texts of the backend's message table (contract MessageKey); they mirror the backend templates in
// backend/src/messages.ts with the same params. The typing against MessageParamsMap makes a missing key a compile error.

// names joined by comma, with the number of further names that were left out
const listOf = (p: { names: string; more: number }): string => (p.more > 0 ? `${p.names} and ${p.more} more` : p.names);

// "an unknown version" or "Minecraft 1.20.1 (estimated)"
const worldOf = (p: { worldVersion: string; estimated: 'yes' | 'no' }): string =>
  p.worldVersion === '' ? 'an unknown version' : `Minecraft ${p.worldVersion}${p.estimated === 'yes' ? ' (estimated)' : ''}`;

// how a process ended (params are read with `in`: an absent one is not a missing param)
const exitOf = (p: { code?: number; signal?: string }): string => ('signal' in p ? `Signal ${p.signal}` : 'code' in p ? `exit code ${p.code}` : 'exit code unknown');

export const messages: MessageTexts = {
  // ---- console lines and runtime status (process manager) ----
  SERVER_STOPPING: 'Stopping the server ...',
  SERVER_STARTING_GAME: (p) => `Starting the ${p.game} server (port ${p.port}) ...`,
  SERVER_RESTARTING: 'Restarting the server ...',
  SERVER_KILLING: 'Killing the server immediately ...',
  SERVER_STOPPING_APP_SHUTDOWN: 'The application is shutting down, stopping the server ...',
  SERVER_STARTING: (p) => `Starting the server (Java ${p.major}, port ${p.port}) ...`,
  START_NOTE: (p) => `Note: ${p.note}`,
  START_FAILED_REASON: (p) => `The server could not be started: ${p.reason}`,
  JAVA_AUTO_INSTALL_NOTICE: (p) =>
    `Java ${p.major} is not installed and will now be installed automatically (Eclipse Temurin, for WorldFoundry only) ...`,
  JAVA_INSTALLING: (p) => `Installing Java ${p.major} ...`,
  JAVA_INSTALLING_PERCENT: (p) => `Installing Java ${p.major} (${p.percent} %) ...`,
  JAVA_INSTALLED_STARTING: (p) => `Java ${p.major} is installed. Starting the server ...`,
  JAVA_INSTALL_FAILED_GENERIC: 'The Java installation failed.',
  START_CANCELLED_JAVA: 'Start cancelled. The Java installation is being stopped.',
  SERVER_EXITED_UNEXPECTEDLY: (p) => `The server exited unexpectedly (${exitOf(p)}).`,
  SERVER_STOPPED: (p) => `Server stopped (${exitOf(p)}).`,
  SERVER_STOP_TIMEOUT: (p) => `The server did not stop within ${p.seconds} seconds and is being killed.`,
  SERVER_NOT_REPORTED_STARTED:
    'The server has not reported being started yet. Large modpacks often need several minutes; it is not being stopped.',
  START_UNEXPECTED_ERROR: 'Unexpected error while starting.',
  JAVA_FORGE_OLD_NOTE:
    'Forge for Minecraft up to 1.16.5 often does not run with Java versions newer than 11. Java 8 is recommended.',
  MODS_UPDATE_CHECK_FAILED: 'The update check failed.',
  // ---- self-update ----
  UPDATE_CHECKS_DISABLED: 'Update checks are turned off in the configuration (UPDATE_CHECK=false).',
  UPDATE_ALREADY_RUNNING: 'An update is already running.',
  UPDATE_NO_NEWER: 'There is no newer release.',
  UPDATE_RESTART_BLOCKED: 'An update is currently running. A restart is possible afterwards.',
  UPDATE_CHECK_FAILED_GENERIC: 'The update check failed.',
  UPDATE_NOTE_PORTABLE:
    'This installation runs without an update service (portable ZIP or an older installation). New versions are shown but not installed automatically: please download the new package and install it as described in the README (Installation section).',
  UPDATE_NOTE_DEV: 'WorldFoundry is running from source code. Please apply updates with git pull, npm install and npm run build.',
  UPDATE_NO_PACKAGES: (p) => `There are no ready-made update packages for ${p.platform}/${p.arch}.`,
  UPDATE_NO_ASSET: (p) => `The release ${p.version} does not contain a package for this system (${p.asset}).`,
  UPDATE_UNSIGNED_RELEASE:
    'The release does not contain signed checksums (SHA256SUMS.txt and SHA256SUMS.txt.sig). It is not installed automatically.',
  UPDATE_WAIT_INSTALL: 'A server installation is currently running. The update is possible afterwards.',
  UPDATE_WAIT_BACKUP: 'A backup is currently being written. The update is possible afterwards.',
  UPDATE_WAIT_JAVA: 'A Java runtime is currently being installed. The update is possible afterwards.',
  UPDATE_WAIT_EXPORT: 'A world is currently being exported. The update is possible afterwards.',
  UPDATE_WAIT_IMPORT: 'A world import is currently running. The update is possible afterwards.',
  UPDATE_PROGRESS_DOWNLOADING: (p) => `Downloading update to ${p.version} …`,
  UPDATE_PROGRESS_VERIFYING: 'Verifying signature and checksum …',
  UPDATE_PROGRESS_NO_SERVERS: 'No servers are running. Handing over the update …',
  UPDATE_PROGRESS_COUNTDOWN: (p) => `Servers will be stopped in ${p.seconds} s (players were warned).`,
  UPDATE_PROGRESS_STOPPING: (p) => `Stopping ${p.count} ${p.count === 1 ? 'server' : 'servers'} …`,
  UPDATE_PROGRESS_DB_BACKUP: 'Backing up the database …',
  UPDATE_PROGRESS_HANDOVER: 'Handing the update over to the update service …',
  UPDATE_PROGRESS_RESTARTING: 'WorldFoundry is restarting. This page reconnects automatically.',
  UPDATE_PROGRESS_CHECKING_PACKAGE: 'The update service is checking the package …',
  UPDATE_PROGRESS_FINISHING: 'Finishing the update …',
  UPDATE_CANCELLED_BY_ADMIN: 'Cancelled by the administrator.',
  UPDATE_REJECTED_BY_UPDATER: 'The update service rejected the update.',
  UPDATE_FAILED_UNEXPECTED: 'The update failed for an unexpected reason.',
  UPDATE_SUCCESS: (p) => `Updated to version ${p.version}.`,
  UPDATE_ROLLED_BACK_DEFAULT: 'The update failed, the previous version was restored.',
  UPDATE_FAILED_DEFAULT: 'The update failed.',
  UPDATE_NO_REPORT: 'The update was not completed: the update service did not report back.',
  UPDATE_INTERRUPTED_BEFORE_HANDOVER: 'The update was interrupted before it was handed over. The servers were started again.',
  // ---- network ----
  NETWORK_ADDRESS_MISSING: (p) =>
    `The address ${p.host} does not exist on this machine (network adapter disconnected or address changed). WorldFoundry therefore listens on all adapters (0.0.0.0). Please check the setting under System > Network & Access.`,
  NETWORK_PORT_FALLBACK: (p) =>
    `The saved port ${p.port} is already in use. WorldFoundry uses port ${p.defaultPort} from the configuration instead. Please check the setting under System > Network & Access.`,
  NETWORK_RESTART_AUTOMATIC: 'The service restarts WorldFoundry by itself after it exits (takes about 5 to 15 seconds).',
  NETWORK_RESTART_MANUAL: 'This installation runs without a service: WorldFoundry exits and has to be started again by hand.',
  // ---- players ----
  PLAYERS_PENDING:
    'The server has not written the change to the file yet. It will become visible shortly, as soon as the server has processed it.',
  // ---- mod updates ----
  MOD_UPDATE_UNEXPECTED: 'Unexpected error during the update.',
  MOD_UPDATE_GONE: 'Mod no longer exists.',
  MOD_UPDATE_BACKUP_KEPT: (p) => `${p.reason} The original file is still in the backup folder (${p.backup}).`,
  // ---- mods: scan, toggle and install warnings ----
  MOD_SCAN_UNREADABLE: (p) => `File "${p.file}" could not be read and was skipped.`,
  MOD_SCAN_RENAME_CONFLICT: (p) => `Rename to "${p.file}" could not be applied (conflict in the database).`,
  MOD_SCAN_ENTRY_REMOVED: (p) => `The entry for "${p.file}" was removed and will be recorded again on the next scan.`,
  MOD_SCAN_TWIN_FILES: (p) =>
    `Both "${p.kept}" and "${p.ignored}" are in the folder (${p.content} content). The file "${p.ignored}" is ignored; please remove one of them.`,
  MOD_SCAN_IDENTICAL: (p) => `File "${p.ignored}" is identical to "${p.preferred}" and is ignored.`,
  MOD_SCAN_CONFLICT: (p) =>
    `${p.kind === 'changed' ? 'Changed' : 'New'} file "${p.file}" could not be applied (conflict in the database).`,
  MOD_SCAN_MODRINTH_DOWN: 'Modrinth is not reachable, unknown files remain unrecognized for now.',
  MOD_SCAN_PROJECT_INSTALLED: (p) =>
    `File "${p.file}" belongs to the already installed project "${p.project}" and remains unrecognized.`,
  MOD_DEPENDENCY_ENABLED: (p) => `"${p.name}" was disabled and has also been enabled as a required dependency.`,
  MOD_DISABLED_ANYWAY: (p) => `"${p.name}" is disabled anyway, although it is required by ${p.dependents}.`,
  MOD_REENABLED: (p) => `"${p.name}" was disabled and is enabled again because "${p.by}" requires it.`,
  MOD_DEPENDENCY_EXTERNAL: (p) =>
    `The dependency "${p.dependency}" of "${p.parent}" is hosted outside Modrinth and must be provided manually.`,
  MOD_DEPENDENCY_VERSION_CLASH: (p) =>
    `A dependency of "${p.parent}" requests a different version of "${p.mod}"; the version already chosen is used.`,
  // ---- world import: progress, results and failures ----
  IMPORT_STEP_UPLOAD: 'Uploading archive',
  IMPORT_STEP_CHECK: 'Checking archive',
  IMPORT_STEP_ANALYZE: 'Analyzing world',
  IMPORT_STEP_CREATE: 'Creating server',
  IMPORT_STEP_WORLD: 'Importing world',
  IMPORT_STEP_MOD_FILES: 'Placing mod files',
  IMPORT_STEP_WAIT_INSTALL: 'Waiting for the server installation',
  IMPORT_STEP_MOD_INSTALL: (p) => `Installing mod: ${p.name}`,
  IMPORT_STEP_REPLACE: 'Replacing world',
  IMPORT_STEP_SAFETY: 'Creating a safety backup of the previous world',
  IMPORT_STEP_SWAP: 'Placing new world',
  IMPORT_UNEXPECTED: 'The import failed for an unexpected reason.',
  IMPORT_FAILED_GENERIC: 'The import failed.',
  IMPORT_PARTIAL: (p) =>
    `The server "${p.name}" was created, but the world could not be imported completely: ${p.reason} The world can be imported again via "Replace world".`,
  IMPORT_ANNOUNCE_REPLACING: 'Replacing the world with an import ...',
  IMPORT_ANNOUNCE_REPLACED: 'The world was replaced by the import.',
  IMPORT_ANNOUNCE_FAILED: (p) => `World import failed, the previous world is kept: ${p.reason}`,
  IMPORT_WARN_SINGLEPLAYER: 'The singleplayer save was imported as player data of the server.',
  IMPORT_WARN_ITEM: (p) => `"${p.item}" could not be imported.`,
  IMPORT_WARN_PROPERTIES: 'server.properties could not be imported.',
  IMPORT_WARN_MODLIST: 'The mod list could not be read.',
  IMPORT_WARN_MODLIST_REASON: (p) => `The mod list could not be read: ${p.reason}`,
  IMPORT_MOD_FILE_FAILED: 'The file could not be saved.',
  IMPORT_MOD_INSTALL_FAILED: 'The installation failed.',
  // ---- world import: notices ----
  WORLD_PRE_1_9_UPLOAD:
    'This world is older than Minecraft 1.9 (no version information in level.dat). Please choose the Minecraft version yourself.',
  WORLD_PRE_1_9:
    'This world is older than Minecraft 1.9 (level.dat contains no version information). Please choose the matching Minecraft version yourself. On the first start the world is converted to the chosen format, which cannot be undone.',
  VERSION_APPROX: (p) => `The version was estimated as Minecraft ${p.mcVersion} from the data version ${p.dataVersion}.`,
  JARS_UNREADABLE: (p) => `These files are not readable jar files: ${p.names}.`,
  OTHER_WORLDS_UPLOAD: (p) => `Other worlds in the archive are not imported: ${listOf(p)}.`,
  LOADER_VERSION_UNAVAILABLE: (p) =>
    `The loader version for Minecraft ${p.mcVersion} could not be determined (${p.reason}). Please choose the loader and version yourself.`,
  WORLD_NEWER: (p) =>
    `The world was last saved with ${worldOf(p)} and is therefore newer than the chosen version ${p.target}. Downgrading a world to an older version damages it. Please choose at least ${p.minimum === '' ? 'the version of the world' : p.minimum}.`,
  WORLD_UPGRADE: (p) =>
    `The world comes from ${worldOf(p)} and is converted to ${p.target} on the first start. This only works in one direction: afterwards it can no longer be opened with the old version. Keep a backup of the source beforehand.`,
  WORLD_PATCH_UPGRADE: (p) => `The world comes from ${worldOf(p)} and is upgraded to ${p.target} on start.`,
  WORLD_VERSION_UNKNOWN:
    'The Minecraft version of the world could not be determined. If a version that is too old is chosen, the world can be damaged.',
  MODDED_NO_LOADER: (p) =>
    `The world contains content from mods, but ${p.loader} cannot load them. Modded blocks, items and entities will be lost.`,
  MODDED_PAPER: 'Paper does not load mods, only plugins. Modded blocks, items and entities of the world will be lost.',
  LOADER_SWITCH: (p) =>
    `The world belongs to ${p.from}, but ${p.to} is chosen. Mods are not interchangeable between mod loaders; mod content can be lost or the world may not load.`,
  LAYOUT_CONVERTED: (p) =>
    p.style === 'split'
      ? 'Nether and End are moved into their own folders (_nether, _the_end) for Paper.'
      : 'Nether and End are moved from the Paper folders into the world folder (DIM-1, DIM1).',
  LAYOUT_UNIFIED: 'The world uses the new folder format with "dimensions" and is imported unchanged.',
  OTHER_WORLDS: (p) => `The archive contains other worlds that are not imported: ${listOf(p)}.`,
  SINGLEPLAYER_PLAYER:
    'The singleplayer save (inventory, position) is imported for the server. It applies to the player with the same Mojang account ID, so the server should run in online mode.',
  REPLACE_ONE_WAY: 'The current world is replaced by the imported one. A safety backup is created automatically beforehand.',
  MODS_MISSING: (p) =>
    `These mods of the world are not provided: ${listOf(p)}. If the server starts without them, blocks and items of the mods can disappear from the world.`,
  // ---- world import: loader evidence ----
  LOADER_EVIDENCE_EXPORT: (p) => (p.version === '' ? `The export file names ${p.loader}.` : `The export file names ${p.loader} ${p.version}.`),
  LOADER_EVIDENCE_FILES: (p) => `${p.count} file(s) in the archive belong to ${p.loader}.`,
  LOADER_EVIDENCE_NEOFORGE_LIST: 'level.dat contains a NeoForge mod list.',
  LOADER_EVIDENCE_FORGE_LIST: 'level.dat contains a Forge mod list.',
  LOADER_EVIDENCE_FML: 'level.dat contains a Forge section (FML).',
  LOADER_EVIDENCE_BRAND: (p) => `level.dat names the server brand "${p.brand}".`,
  LOADER_EVIDENCE_PAPER_HINTS: (p) => `Indication of Bukkit/Paper: ${p.hints}.`,
  LOADER_EVIDENCE_NONE: 'No indication of mods or plugins found.',
  // ---- world export ----
  EXPORT_UNEXPECTED: 'The export failed for an unexpected reason.',
  EXPORT_FAILED_REASON: (p) => `Export failed: ${p.reason}`,
  EXPORT_ANNOUNCE: 'Exporting the world ...',
  EXPORT_FINISHED: 'World export finished.',
  EXPORT_WARN_SYMLINKS: (p) => `${p.count} symlink(s) were not exported.`,
  // ---- backups ----
  BACKUP_ANNOUNCE_SAFETY: 'Creating a safety backup of the world ...',
  BACKUP_ANNOUNCE: 'Creating a backup of the world ...',
  BACKUP_FINISHED: 'World backup finished.',
  BACKUP_FAILED_REASON: (p) => `Backup failed: ${p.reason}`,
  BACKUP_UNEXPECTED: 'The backup failed for an unexpected reason.',
  BACKUP_INTERRUPTED_SHUTDOWN: 'The backup was interrupted (the application was shut down).',
  BACKUP_NOTE_SYMLINKS: (p) => `${p.count} symlink(s) were not backed up.`,
  SAVE_ON_UNCONFIRMED: 'The server did not confirm save-on; please check that automatic saving is active again.',
  BACKUP_NOTE_BEFORE_RESTORE: (p) => `Created automatically before restoring ${p.fileName}.`,
  BACKUP_NOTE_BEFORE_IMPORT: 'Created automatically before the world was replaced by an import.',
  BACKUP_RESTORING: 'Restoring backup ...',
  BACKUP_RESTORED: 'Backup restored.',
  RESTORE_FAILED_REASON: (p) => `Restore failed, the previous world is kept: ${p.reason}`,
  UNEXPECTED_ERROR: 'unexpected error',
  RESTORE_LEVEL_MISMATCH: (p) =>
    `The restored world is named "${p.restored}", but the server uses "${p.current}" (level-name in server.properties). Please adjust the world name or use a backup that includes the configuration.`,
  // ---- server installation ----
  INSTALL_INTERRUPTED_SHUTDOWN: 'The installation was interrupted (the application was shut down).',
  INSTALL_UNEXPECTED_ERROR: 'An unexpected error occurred during the installation.',
  INSTALL_STEP_RESOLVE: 'Resolving version',
  INSTALL_STEP_DOWNLOAD: (p) => `${p.fileName}: ${p.kib} KiB`,
  INSTALL_STEP_INSTALLER: 'Installer running',
  INSTALL_DONE: 'Installation finished',
  // ---- managed Java runtimes ----
  JAVA_ORIGIN_MANAGED: (p) =>
    `Installed automatically by WorldFoundry on ${p.date}: Eclipse Temurin ${p.version} (${p.image}), downloaded from api.adoptium.net, SHA-256 ${p.sha} verified. Located in the data folder and not registered in the system, the PATH or the registry.`,
  JAVA_STEP_METADATA: (p) => `Querying Java ${p.major} at Adoptium ...`,
  JAVA_STEP_DOWNLOAD: (p) => `Downloading Java ${p.major} (${p.receivedMb} of ${p.totalMb} MB)`,
  JAVA_STEP_VERIFY: (p) => `Checksum (SHA-256) of Java ${p.major} matches`,
  JAVA_STEP_EXTRACT: (p) => `Extracting Java ${p.major} ...`,
  JAVA_STEP_CHECK: (p) => `Checking Java ${p.major} ...`,
  JAVA_INSTALLED: (p) => `Java ${p.major} is installed.`,
  JAVA_INSTALL_FAILED: (p) => `Java ${p.major} could not be installed.`,
  AUTOSTART_SKIPPED: (p) => `Autostart of "${p.name}" skipped: ${p.reason === 'eula' ? 'EULA not accepted' : 'not installed'}`,
  AUTOSTART_FAILED_NAMED: (p) => `Autostart of "${p.name}" failed: ${p.reason}`,
  AUTOSTART_FAILED: (p) => `Autostart failed: ${p.reason}`,
  START_LABEL_FAILED: (p) => `${p.label} failed: ${p.reason}`,
  START_AFTER_RESTART: 'Start after the restart',
  START_AFTER_UPDATE_FAILED: (p) => `Start after the update failed: ${p.reason}`,
};
