// Text for a backend error `code`. A function receives the error's params and details (params win). Every known code
// has a text here; the backend's own message is only the fallback for codes that are not listed.
// Reading rule: a required param is read directly, so a reference with a missing param falls back to the backend's
// text; an optional param is read with `opt`, which never counts as missing.
import type { ErrorParamsMap } from '@worldfoundry/backend/contract';

type Details = Record<string, unknown>;

const opt = (values: Details, key: string): unknown => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

// disk sizes arrive in MB; a 50 GB world is easier to read as GB
const sizeMb = (mb: number): string => (mb >= 1024 ? `${(mb / 1024).toLocaleString('en-US', { maximumFractionDigits: 1 })} GB` : `${mb.toLocaleString('en-US')} MB`);

const named = (details: Details): string | undefined => text(opt(details, 'name'));
const levelOf = (details: Details): number | undefined => num(opt(details, 'level'));

const seconds = (details: Details): number => num(details.seconds) ?? num(opt(details, 'retryAfterSeconds')) ?? 0;

// names of a list of { name } objects, e.g. the dependents of a mod or the servers that use a Java runtime
const namesOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((entry: unknown) => {
        const name = typeof entry === 'object' && entry !== null ? (entry as { name?: unknown }).name : undefined;
        return typeof name === 'string' && name !== '' ? [name] : [];
      })
    : [];
// the servers of a Java runtime: the params carry the names as text, the details as a list of { name } objects
const serverNames = (details: Details): string => (typeof details.servers === 'string' ? details.servers : namesOf(details.servers).join(', '));
// "21", "21 to 22" or "21 or newer" (requiredMax null), or undefined when the details carry no requirement
const javaRange = (details: Details): string | undefined => {
  const min = num(opt(details, 'required'));
  if (min === undefined) return undefined;
  if (opt(details, 'requiredMax') === null) return `${min} or newer`;
  const max = num(opt(details, 'requiredMax'));
  return max !== undefined && max !== min ? `${min} to ${max}` : `${min}`;
};

export const errors = {
  unknown: 'Unknown error.',
  unexpectedStatus: (status: number) => `The server responded unexpectedly (status ${status}).`,
  // replaces the text of a validation detail; the path of the detail is shown in front of it
  invalidDetail: 'invalid value',
  codes: {
    GAME_NOT_FOUND: 'This game is not known to WorldFoundry.',
    GAME_SETTINGS_INVALID: 'The stored settings of this server are damaged.',
    GAME_FEATURE_UNSUPPORTED: (p: Details) => (text(p.game) === undefined ? 'This part of WorldFoundry is not available for this game yet.' : `This part of WorldFoundry is not available for ${p.game} servers yet.`),
    STEAMCMD_FAILED: (p: Details) => (opt(p, 'reason') === 'lib32' ? 'SteamCMD needs 32-bit libraries on Linux. On Debian or Ubuntu install them with: sudo apt install lib32gcc-s1' : 'SteamCMD did not confirm the installation. The details are in the installation log.'),
    GAME_NOT_AVAILABLE: (p: Details) => (text(p.game) === undefined ? 'Servers for this game cannot be created yet.' : `Servers for ${p.game} cannot be created yet.`),
    NETWORK_ERROR: 'The server cannot be reached. Please check the network connection.',
    INVALID_RESPONSE: 'The response of the server is unreadable.',
    UNAUTHORIZED: 'Sign-in required. Please sign in.',
    INVALID_TOKEN: 'The password or access token is invalid.',
    TOO_MANY_ATTEMPTS: (p: Details) => `Too many failed sign-in attempts. Please try again in ${seconds(p)} seconds.`,
    CURRENT_PASSWORD_WRONG: 'The current password is wrong.',
    PASSWORD_UNCHANGED: 'The new password must differ from the current one.',
    PASSWORD_TOO_WEAK: 'The new password does not meet the requirements (length and at least four different characters).',
    ORIGIN_FORBIDDEN: 'The request comes from an origin that is not allowed and was rejected.',
    HOST_FORBIDDEN: 'The host of the request is not allowed. More names can be allowed via ALLOWED_HOSTS or in the web interface under System > Network & access.',
    FORBIDDEN: 'Access to this address is not allowed.',
    VALIDATION_ERROR: 'The request contains invalid data.',
    PAYLOAD_TOO_LARGE: 'The request is too large.',
    UNSUPPORTED_MEDIA_TYPE: 'The content type of the request is not supported.',
    NOT_FOUND: 'The requested resource was not found.',
    INTERNAL_ERROR: 'An internal error occurred.',
    SHUTTING_DOWN: 'The application is shutting down.',
    DATABASE_UNAVAILABLE: 'The database is not reachable.',
    SERVER_NOT_FOUND: 'The server was not found.',
    SERVER_ALREADY_RUNNING: 'The server is already running or starting.',
    SERVER_NOT_RUNNING: 'The server is not running.',
    SERVER_NOT_INSTALLED: 'The server is not installed yet, its installation is still running, or the installation has failed. Please install it first.',
    SERVER_RUNNING: 'The server is running. Please stop it before restoring a backup.',
    SERVER_FILES_MISSING: 'The start file of the server is missing. Please run the installation again.',
    ALREADY_INSTALLED: 'The server is already installed.',
    INSTALL_IN_PROGRESS: 'The installation is already running.',
    INSTALL_ABORTED: 'The installation was interrupted (the application is shutting down).',
    INSTALLER_FAILED: (p: Details): string => {
      if (opt(p, 'reason') !== 'exit') return 'The installer could not be started. Is the Java file valid?';
      const code = opt(p, 'exitCode');
      const output = text(opt(p, 'output'));
      return `The installer failed with exit code ${typeof code === 'number' || typeof code === 'string' ? code : 'unknown'}.${output === undefined ? '' : `\nLast output:\n${output}`}`;
    },
    INSTALLER_TIMEOUT: (p: Details) =>
      num(p.minutes) === undefined ? 'The installer was cancelled because it took too long.' : `The installer was cancelled after ${p.minutes} minutes because it took too long.`,
    INSTALL_LOG_UNSAFE: 'The log file is not a regular file and will not be read.',
    LAUNCH_TARGET_NOT_FOUND: 'No startable file was found after the installation. The details are in the file install.log in the server folder.',
    START_CANCELLED: 'The start was cancelled.',
    START_FAILED: (p: Details): string => {
      const reason = text(opt(p, 'reason'));
      if (reason === 'java-not-found') return 'The server could not be started: the matching Java installation is missing.';
      if (reason === 'java-denied') return 'The server could not be started: the Java program may not be executed.';
      if (reason === 'spawn-failed') return 'The server could not be started: the server process could not be launched.';
      return 'The server could not be started.';
    },
    CONFIRMATION_REQUIRED: 'The parameter confirm=true is required to delete.',
    INVALID_COMMAND: 'The command must not be empty.',
    INVALID_MESSAGE: 'The message is invalid.',
    RAM_INVALID: 'The minimum memory must not be greater than the maximum.',
    RAM_EXCEEDS_SYSTEM: (details: Details) =>
      num(opt(details, 'maxRamMb')) === undefined || num(opt(details, 'totalRamMb')) === undefined
        ? 'The maximum memory exceeds the memory of this computer.'
        : `The maximum memory (${details.maxRamMb} MB) exceeds the memory of this computer (${details.totalRamMb} MB).`,
    INVALID_JVM_ARGS: 'The additional JVM arguments are invalid.',
    EULA_NOT_ACCEPTED: 'The Minecraft EULA has not been accepted for this server yet. It must be accepted before the server can start.',
    PORT_IN_USE: (details: Details) =>
      num(opt(details, 'port')) === undefined
        ? 'The port is already in use or may not be used. Please set another port in the server properties.'
        : text(opt(details, 'serverName')) === undefined
          ? `Port ${details.port} is already in use by another program or may not be used. Please stop that program or set another port in the server properties.`
          : `Port ${details.port} is already used by the running server "${details.serverName}". Please set another port in the server properties.`,
    JAVA_INVALID: 'The Java path must point to a file named java or java.exe.',
    JAVA_INSTALL_ABORTED: 'The Java installation was cancelled.',
    JAVA_INSTALL_INVALID: (p: Details) =>
      num(p.major) === undefined
        ? 'The downloaded archive does not contain a Java installation.'
        : `The downloaded archive for Java ${p.major} does not contain a Java installation.`,
    JAVA_INSTALL_UNAVAILABLE: 'Java installation is not available in this configuration.',
    JAVA_INSTALL_RUNNING: (p: Details) => (num(p.major) === undefined ? 'Java is being installed right now and cannot be removed.' : `Java ${p.major} is being installed right now and cannot be removed.`),
    JAVA_IN_USE: (p: Details) =>
      serverNames(p) === ''
        ? 'This Java runtime is used by servers. Please stop those servers first.'
        : `This Java runtime is used by these servers: ${serverNames(p)}. Please stop them first.`,
    JAVA_RUNTIME_NOT_FOUND: (p: Details) =>
      num(p.major) === undefined
        ? 'No Java runtime installed by WorldFoundry exists for this version.'
        : `No Java runtime installed by WorldFoundry exists for Java ${p.major}.`,
    JAVA_NOT_AVAILABLE: (details: Details) =>
      num(opt(details, 'major')) === undefined || text(opt(details, 'platform')) === undefined
        ? 'Eclipse Temurin does not offer this Java version for this platform. Please install Java manually and enter its path in the server.'
        : `Eclipse Temurin does not offer Java ${details.major} for ${details.platform}. Please install Java ${details.major} manually and enter its path in the server.`,
    JAVA_NOT_FOUND: (details: Details) => {
      if (text(opt(details, 'javaPath')) !== undefined) return `The configured Java installation was not found or does not start: ${details.javaPath}`;
      const range = num(opt(details, 'major')) !== undefined ? `${details.major}` : javaRange(details);
      return range === undefined
        ? 'No suitable Java installation was found. Please install Java or enter the Java path in the server.'
        : `No Java installation was found. Java ${range} is needed. Please install it or enter the Java path in the server.`;
    },
    JAVA_VERSION_INCOMPATIBLE: (details: Details) => {
      const range = javaRange(details);
      if (range === undefined) return 'The installed Java version does not fit this server.';
      const found = Array.isArray(opt(details, 'found')) ? (details.found as unknown[]).filter((version): version is number => typeof version === 'number') : [];
      return found.length === 0 ? `This server needs Java ${range}.` : `This server needs Java ${range}, found Java ${[...new Set(found)].join(', ')}.`;
    },
    JAVA_PLATFORM_UNSUPPORTED: 'Eclipse Temurin does not provide a Java runtime for this platform. Please install Java manually and enter its path in the server.',
    BACKUP_NOT_FOUND: 'The backup was not found.',
    BACKUP_IN_PROGRESS: 'A backup is already running for this server.',
    BACKUP_FILE_MISSING: 'The backup file is missing from the data folder.',
    BACKUP_INVALID: 'The backup has no valid description (worldfoundry-backup.json) and cannot be restored.',
    BACKUP_NOT_READY: 'This backup is not finished and cannot be downloaded.',
    BACKUP_PATH_UNSAFE: 'The file name of the backup is invalid.',
    BACKUP_SERVER_BUSY: 'The server is starting or stopping. Please wait until it is running or stopped.',
    BACKUP_INTERRUPTED: 'The server was stopped during the backup. The incomplete backup was discarded.',
    BACKUP_SAVE_FAILED: 'The server could not save the world (save-all). Is there enough free disk space?',
    BACKUP_SAVE_TIMEOUT: 'The server did not confirm saving the world in time.',
    BACKUP_NOTHING_TO_SAVE: 'There is no world data to back up yet. The server must have been started once.',
    BACKUP_LEVEL_INVALID: (p: Details) =>
      text(p.levelName) === undefined
        ? 'The world name (level-name) in server.properties is invalid and cannot be backed up.'
        : `The world name "${p.levelName}" (level-name in server.properties) is invalid and cannot be backed up.`,
    BACKUP_TOO_DEEP: 'The folder structure of the world is nested too deeply.',
    BACKUPS_DECISION_REQUIRED: 'This server has backups. Please decide whether they are deleted with the server or kept.',
    ARCHIVE_BOMB: 'The archive is unreasonably large when unpacked compared to its file size, so it was rejected for safety reasons.',
    ARCHIVE_PATH_TOO_LONG: (p: Details) => (text(p.path) === undefined ? 'A file path in the archive is too long for a ZIP archive.' : `The file path "${p.path}" in the archive is too long for a ZIP archive.`),
    ARCHIVE_SOURCE_CHANGED: (p: Details) =>
      text(p.file) === undefined
        ? 'A file changed while the backup was being created. Please try again.'
        : `The file "${p.file}" changed while the backup was being created. Please try again.`,
    ARCHIVE_TOO_LARGE: 'The archive is larger than allowed (too many entries or too much data when unpacked).',
    ARCHIVE_UNSAFE: (p: Details) =>
      text(p.entry) === undefined
        ? 'The archive contains an unsafe entry, so the operation was cancelled.'
        : `The archive contains the unsafe entry "${p.entry}", so the operation was cancelled.`,
    EXPORT_MANIFEST_INVALID: 'The manifest file of the export is invalid. It may come from a newer version of WorldFoundry.',
    EXPORT_NOTHING: 'There is no world data to export, or the backup contains no world.',
    CHECKSUM_UNAVAILABLE: 'No checksum is published for the installer. The download was cancelled for safety reasons.',
    FILE_EXISTS: (p: Details) => (text(p.file) === undefined ? 'A file with this name already exists in the server folder.' : `The file "${p.file}" already exists in the server folder.`),
    FILE_LOCKED: (details: Details) =>
      text(details.fileName) === undefined
        ? 'The file is used by another program or is read-only. Please stop that program (e.g. the Minecraft server) and try again.'
        : `The file "${details.fileName}" is used by another program or is read-only. Please stop that program (e.g. the Minecraft server) and try again.`,
    DOWNLOAD_FAILED: (p: Details) => (num(p.status) === undefined ? 'The download could not be started.' : `The download could not be started (status ${p.status}).`),
    DOWNLOAD_HASH_MISMATCH: 'The downloaded file does not match the expected checksum.',
    DOWNLOAD_INVALID_FILE: 'The downloaded file is not a valid Java archive.',
    DOWNLOAD_TIMEOUT: 'The download took too long.',
    DOWNLOAD_URL_REJECTED: (p: Details) => (text(p.host) === undefined ? 'The download address is invalid.' : `The download address ("${p.host}") is invalid.`),
    DEPENDENCY_UNRESOLVABLE: 'The version contains no downloadable .jar file.',
    MODRINTH_BAD_RESPONSE: 'Modrinth sent an unexpected response.',
    MODRINTH_RATE_LIMITED: 'Modrinth is currently limiting requests. Please try again later.',
    MODRINTH_TIMEOUT: 'Modrinth did not respond in time.',
    MODRINTH_UNREACHABLE: 'Modrinth cannot be reached.',
    MODS_NOT_SUPPORTED: 'Vanilla servers do not support mods or plugins.',
    MOD_NOT_FOUND: 'The project or version was not found on Modrinth.',
    MOD_ALREADY_INSTALLED: (p: Details) => (text(p.name) === undefined ? 'This mod is already installed.' : `The mod "${p.name}" is already installed.`),
    MOD_DISABLED: (p: Details) =>
      text(p.name) === undefined
        ? 'This mod is installed but disabled. Please enable it in the mod list.'
        : `The mod "${p.name}" is installed but disabled. Please enable it in the mod list.`,
    MOD_FILE_MISSING: (p: Details) =>
      text(p.file) === undefined || text(p.name) === undefined
        ? 'The file of this mod is missing from the server folder. Please reload the mod list.'
        : `The file "${p.file}" of the mod "${p.name}" is missing from the server folder. Please reload the mod list.`,
    MOD_INCOMPATIBLE: (p: Details) => {
      const mods = Array.isArray(opt(p, 'mods')) ? (p.mods as unknown[]).filter((mod): mod is string => typeof mod === 'string') : [];
      if (text(opt(p, 'first')) !== undefined && text(opt(p, 'second')) !== undefined) return `"${p.first}" is not compatible with "${p.second}".`;
      return mods.length === 2 ? `"${mods[0]}" is not compatible with "${mods[1]}".` : 'These two mods are not compatible with each other.';
    },
    MOD_REQUIRED_BY_OTHERS: (p: Details) => {
      const names = typeof opt(p, 'dependents') === 'string' ? (p.dependents as string) : namesOf(opt(p, 'dependents')).join(', ');
      return names === '' ? 'This mod is required by other mods.' : `This mod is required by other mods: ${names}.`;
    },
    MOD_VERSION_DIFFERS: 'A different version of this mod is already installed. Please use the update function.',
    PLAN_TOO_LARGE: (p: Details) =>
      num(p.max) === undefined
        ? 'The dependencies would add more mods than allowed. The installation was cancelled.'
        : `The dependencies would add more than ${p.max} mods. The installation was cancelled.`,
    NO_COMPATIBLE_VERSION: 'There is no compatible version for this Minecraft version and loader.',
    VERSION_INCOMPATIBLE: 'The selected version is not compatible with this Minecraft version and loader.',
    VERSION_NOT_FOUND: 'The requested version was not found.',
    NO_SERVER_DOWNLOAD: 'Mojang does not provide a server download for this Minecraft version. Please choose another version.',
    UNSAFE_FILENAME: 'The source provided an invalid file name. The download was cancelled.',
    NBT_INVALID: 'The NBT file is damaged.',
    IMPORT_BEDROCK: 'The archive contains a Bedrock world. WorldFoundry only supports Java Edition worlds.',
    IMPORT_BUSY: 'Several imports are already running. Please wait until one has finished.',
    IMPORT_IN_PROGRESS: 'The import is running and cannot be cancelled.',
    IMPORT_MODE: 'This upload is meant for replacing a world.',
    IMPORT_NOT_FOUND: 'The import was not found or has expired. Please upload the archive again.',
    IMPORT_NOT_READY: (p: Details) =>
      text(opt(p, 'reason')) === undefined ? 'The import is not ready yet, or it has failed.' : `The import is not ready yet, or it has failed: ${p.reason}`,
    IMPORT_NO_WORLD: 'No Minecraft world was found in the archive (no level.dat file). Expected is a packed world folder, a server folder with a world, or a WorldFoundry export.',
    IMPORT_FORMAT_UNSUPPORTED: 'The archive has an unsupported format. .zip and .tar.gz (.tgz) are supported. For .rar or .7z, please repack it as .zip first.',
    IMPORT_TOO_LARGE: (p: Details) =>
      text(opt(p, 'max')) === undefined
        ? 'The file is too large. The limit can be changed with IMPORT_MAX_MB.'
        : `The file is too large (at most ${p.max}). The limit can be changed with IMPORT_MAX_MB.`,
    IMPORT_TOO_MANY_MODS: 'The archive contains too many mod files and will not be imported.',
    IMPORT_SELECTION_INVALID: 'The selection contains a mod file that is not in the archive.',
    IMPORT_FAILED: 'The world could not be imported completely. The server was created; the world can be imported again with "Replace world".',
    LEVEL_DAT_INVALID: 'The file level.dat could not be read.',
    ARCHIVE_CORRUPT: 'The archive is damaged or incomplete.',
    ARCHIVE_UNSUPPORTED: 'The archive uses an unsupported compression method.',
    DISK_FULL: (p: Details) => {
      const needed = num(p.neededMb);
      const free = num(p.freeMb);
      return needed === undefined || free === undefined ? 'There is not enough free space on the disk.' : `There is not enough free space on the disk (needed ${sizeMb(needed)}, free ${sizeMb(free)}).`;
    },
    EXPORT_INTERRUPTED: 'The server was stopped during the export. The incomplete export was discarded.',
    EXPORT_IN_PROGRESS: 'The export is still running.',
    EXPORT_NOT_FOUND: 'The export was not found or has expired.',
    EXPORT_NOT_READY: 'The export is not finished yet.',
    EXPORT_SERVER_BUSY: 'The server is starting or stopping. Please wait until it is running or stopped.',
    NETWORK_PORT_INVALID: 'The port must be a whole number between 1 and 65535.',
    NETWORK_PUBLIC_INVALID: 'The public address is invalid. Examples: minecraft.fritz.box or http://192.168.178.20:3000',
    NETWORK_ADDRESS_INVALID: 'The address is not a valid IPv4 address. Allowed are 0.0.0.0 (all adapters), 127.0.0.1 (this computer only), or an address of this computer.',
    NETWORK_ADDRESS_UNKNOWN: 'The address does not belong to a network adapter of this computer. WorldFoundry would not be reachable with a non-existent address.',
    NETWORK_HOST_INVALID: 'A host name is invalid. Names like minecraft.fritz.box are allowed (without http:// and without a path). There is also a limit on the number of additional names.',
    NETWORK_PORT_DENIED: 'The permission for this port is missing (ports below 1024 are blocked for normal user accounts). Please choose a higher port.',
    NETWORK_PORT_IN_USE: (p: Details) =>
      text(opt(p, 'server')) === undefined
        ? 'The port is already in use, by another program or by a Minecraft server. Please choose a free port.'
        : `The port is already used by the server "${p.server}". Please choose a free port.`,
    RESTART_CONFIRM_REQUIRED: 'The restart must be confirmed explicitly: all running Minecraft servers will be stopped and started again afterwards.',
    RESTART_IN_PROGRESS: 'WorldFoundry is already restarting.',
    RESTART_UNSUPPORTED: 'Restarting from the interface is not possible in this mode of operation.',
    UPDATE_ABORTED: 'The operation was cancelled.',
    UPDATE_BLOCKED: (p: Details) => (text(p.reason) === undefined ? 'The update is blocked at the moment. Please try again later.' : `The update is blocked at the moment: ${p.reason}`),
    UPDATE_BUSY: 'An update is running. A new check is possible afterwards.',
    UPDATE_CANCELLED: 'The update was cancelled.',
    UPDATE_CHECK_FAILED: 'The check for updates failed.',
    UPDATE_CONFIRM_REQUIRED: 'The update must be confirmed explicitly: all running Minecraft servers will be stopped.',
    UPDATE_DISABLED: 'Update checks are disabled in the configuration (UPDATE_CHECK=false).',
    UPDATE_DOWNLOAD_FAILED: (p: Details) => (num(p.status) === undefined ? 'The update download failed.' : `The update download failed (status ${p.status}).`),
    UPDATE_HASH_MISMATCH: 'The downloaded file does not match the signed checksum. The update was rejected.',
    UPDATE_IN_PROGRESS: (p: Details) =>
      text(opt(p, 'reason')) === undefined
        ? 'WorldFoundry is being updated. Servers can only be started, installed, or changed again afterwards.'
        : `${p.reason}`,
    UPDATE_NOT_APPLIED: 'The update service reports success, but WorldFoundry is still running the old version.',
    UPDATE_NOT_CANCELABLE: 'The update can no longer be cancelled at this step.',
    UPDATE_NOT_POSSIBLE: (p: Details) => (text(opt(p, 'reason')) === undefined ? 'The update service is not set up.' : `The update service is not set up: ${p.reason}`),
    UPDATE_NO_UPDATER: 'The update service did not accept the request. Is the service "worldfoundry-update" or "worldfoundry-updater" running?',
    UPDATE_RESPONSE_INVALID: 'GitHub sent an unexpected response.',
    UPDATE_SIGNATURE_INVALID: 'The release signature is invalid. The update was rejected for security reasons.',
    UPDATE_SIZE_MISMATCH: 'The downloaded file does not have the announced size.',
    UPDATE_STOP_TIMEOUT: 'Not all servers could be stopped in time. The update was not applied.',
    UPDATE_SUMS_INVALID: (p: Details) => (text(p.asset) === undefined ? 'The checksum file of the release is invalid.' : `The checksum file of the release is invalid (${p.asset}).`),
    UPDATE_TIMEOUT: 'The connection to GitHub took too long.',
    UPDATE_TOO_LARGE: 'The response or update file is larger than allowed and was rejected.',
    UPDATE_UNREACHABLE: 'GitHub cannot be reached. Please check the internet connection.',
    UPDATE_URL_REJECTED: (p: Details) =>
      text(p.host) === undefined ? 'The download address for the update is not allowed.' : `The download address for the update ("${p.host}") is not allowed.`,
    UPLOAD_ABORTED: 'The upload was cancelled.',
    UPLOAD_EMPTY: 'No file was transferred.',
    UPSTREAM_ERROR: (p: Details) =>
      text(p.host) === undefined ? 'An external service responded with an error.' : `The service "${p.host}" responded with an error.`,
    UPSTREAM_INVALID: (p: Details) =>
      text(p.host) === undefined ? 'An external service returned data in an unexpected format.' : `The service "${p.host}" returned data in an unexpected format.`,
    UPSTREAM_TIMEOUT: (p: Details) => (text(p.host) === undefined ? 'An external service did not respond in time.' : `The service "${p.host}" did not respond in time.`),
    UPSTREAM_UNREACHABLE: (p: Details) =>
      text(p.host) === undefined
        ? 'An external service cannot be reached. Please check the internet connection.'
        : `The service "${p.host}" cannot be reached. Please check the internet connection.`,
    UNSAFE_SERVER_PATH: 'The server folder is in an unexpected location and is not deleted for safety reasons.',
    PLAYERS_BUSY: 'The server is starting or stopping. Please wait until it is running or stopped.',
    PLAYERS_UNSUPPORTED: 'The player lists only exist as JSON files from Minecraft 1.7.6 on and cannot be managed for this version.',
    PLAYER_LIST_CORRUPT: 'A player list is damaged and will not be overwritten. Please repair or delete the file.',
    PLAYER_NAME_NEEDS_RUNNING_SERVER: (details: Details) =>
      named(details) === undefined
        ? 'This is a Bedrock name (Floodgate/Geyser) without a Mojang account, so its UUID cannot be found while the server is stopped. Please start the server and add the player there.'
        : `"${named(details)}" is a Bedrock name (Floodgate/Geyser) without a Mojang account, so its UUID cannot be found while the server is stopped. Please start the server and add the player there.`,
    OP_LEVEL_LIVE: (details: Details) =>
      levelOf(details) === undefined
        ? 'While the server runs, only the default level is assigned. Set a different level or "Bypass player limit" while the server is stopped.'
        : `While the server runs, only the default level (${levelOf(details)}) is assigned. Set a different level or "Bypass player limit" while the server is stopped.`,
    PLAYER_NOT_FOUND: (details: Details) =>
      text(details.name) === undefined ? 'Player not found: this name does not exist at Mojang.' : `Player not found: the name "${details.name}" does not exist at Mojang.`,
    PLAYER_NOT_LISTED: (details: Details) => (text(details.name) === undefined ? 'This entry is not in the list.' : `"${details.name}" is not in this list.`),
    PLAYER_LOOKUP_FAILED: (p: Details): string => {
      const reason = opt(p, 'reason');
      const status = num(opt(p, 'status'));
      const detail =
        reason === 'timeout'
          ? 'Mojang did not respond in time.'
          : reason === 'rate-limited'
            ? 'Mojang is currently rate limiting requests.'
            : reason === 'http' && status !== undefined
              ? `Mojang did not answer the request (HTTP ${status}).`
              : reason === 'unreachable'
                ? 'Mojang is not reachable.'
                : reason === 'unexpected'
                  ? 'Mojang returned an unexpected response.'
                  : 'The player name could not be looked up at Mojang.';
      return `${detail} Alternatively start the server and add the player there live.`;
    },
    PROPERTY_NOT_REMOVABLE: 'The server port (server-port) cannot be removed. Please set a new port instead.',
    REASON_NOT_ASCII: 'The reason may only contain plain letters (A–Z) while the server is running; umlauts are converted automatically.',
    WORLD_NEWER:
      'The world was last saved with a newer Minecraft version than the selected one. Resetting a world to an older version damages it. Please select a version at least as new as the world.',
  },
};

// Compile-time check: every code with params in the backend's ErrorParamsMap has a text above (an uncovered code is
// the type of this constant, which is not `true`).
type UncoveredParamCodes = Exclude<keyof ErrorParamsMap, keyof typeof errors.codes>;
export const paramCodesCovered: [UncoveredParamCodes] extends [never] ? true : UncoveredParamCodes = true;
