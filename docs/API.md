# WorldFoundry: API reference

> **WorldFoundry is not an official product of any game publisher.** The disclaimer of each game is in [TRADEMARKS.md](../TRADEMARKS.md).
> NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.

Errors always have the form `{ "error": { "code", "message", "details?" } }`. `POST` requests without a body are also allowed with `Content-Type: application/json`.

Login, host and origin checks are described in [CONFIGURATION.md](CONFIGURATION.md#security). Behavior of creating, installing and starting servers and of Java handling is described in [USAGE.md](USAGE.md).

**Contents**

- [System and loaders](#system-and-loaders)
- [Servers](#servers)
- [Mod management](#mod-management)
  - [Enabling and disabling mods](#enabling-and-disabling-mods)
  - [Update backups](#update-backups)
- [World backups](#world-backups)
- [Importing and exporting worlds](#importing-and-exporting-worlds)
- [Installation log](#installation-log)
- [Autostart](#autostart)
- [Authentication](#authentication)
- [WebSockets](#websockets)

## System and loaders

- `GET /api/java/runtimes` (list, `?rescan=true`), `POST /api/java/runtimes/:major/install` (waits until finished, idempotent), `DELETE /api/java/runtimes/:major`: Java runtimes installed by WorldFoundry
- `GET /api/health`: status, version, runtime, database, LAN addresses
- `GET /api/system/network` (addresses: `lan`, `virtual`, `hostnameUrl`; `active`, `settings`, `defaults`, `pending`, `restartRequired`, `warnings`), `PUT /api/system/network` with `{ bindHost?, port?, allowedHosts?, publicAddress? }` (`null` = value of the configuration file; errors `422 NETWORK_ADDRESS_UNKNOWN | NETWORK_PORT_IN_USE | NETWORK_PORT_DENIED | NETWORK_HOST_INVALID | NETWORK_PUBLIC_INVALID`), `POST /api/system/restart` with `{ "confirm": true }` (`422` without), answers `202` and ends WorldFoundry with exit code 75
- `GET /api/system/update`, `POST /api/system/update/check | apply | cancel | dismiss`, `PATCH /api/system/update/settings`: self-update, see [Updates](UPDATES.md#api)
- `GET /api/system?rescan`: memory, CPU count, platform, Java installations
- `GET /api/loaders`: available loaders
- `GET /api/loaders/:loader/mc-versions?snapshots=true`: Minecraft versions of the loader
- `GET /api/loaders/:loader/versions?mcVersion=`: loader versions (with `stable` and `recommended`)

## Servers

- `GET /api/servers`, `GET /api/servers/:id`: servers with runtime status (`status`: state, PID, players, CPU in percent of the whole machine, memory)
- `POST /api/servers` with `{ name, loader, mcVersion, loaderVersion?, port?, minRamMb?, maxRamMb?, eulaAccepted? }`
- `PATCH /api/servers/:id` with `{ name, minRamMb, maxRamMb, javaPath, useAikarFlags, extraJvmArgs, eulaAccepted }` (all optional; the response contains `restartRequired`)
- `DELETE /api/servers/:id?confirm=true`: not while the server is running or being installed; removes only `<SERVERS_DIR>/<UUID>`
- `POST /api/servers/:id/install | start | stop | restart | kill`: `start` answers immediately even if the Java version is missing (state `preparing`)
- `POST /api/servers/:id/command` with `{ command }` (at most 1024 characters, no line breaks)
- `GET /api/servers/:id/console/history?limit=`: last console lines (buffer: 2000 lines)
- `GET /api/servers/:id/properties`, `PATCH /api/servers/:id/properties`: `server.properties` (port, game mode, difficulty, whitelist, player count, view distance, online mode, MOTD). Comments, order and unknown entries remain unchanged; after writing, the port is also updated in the database.

## Mod management

Per server under `/api/servers/:serverId`; Fabric, Forge and NeoForge use `mods/`, Paper uses `plugins/`, Vanilla is rejected with `409 MODS_NOT_SUPPORTED`:

- `GET /mods`: installed mods
- `GET /mods/search?query&categories&limit&offset&index`: Modrinth search, fixed to the Minecraft version, loader and server-side mods
- `POST /mods` with `{ projectId, versionId? }`: installs including all required dependencies (all or nothing)
- `DELETE /mods/:modId?force=true`: removes a mod; without `force`, error `MOD_REQUIRED_BY_OTHERS` if other mods need it
- `POST /mods/scan`: compares the folder (SHA-512) with the database and recognizes manual files through Modrinth
- `POST /mods/updates/check` and `POST /mods/updates/apply` with `{ projectIds? }`: check for updates and apply them safely (backup in `mods_backup/` or `plugins_backup/`)
- `GET /mods/update-log?limit`: update log
- `GET /api/modrinth/categories`: Modrinth categories

- `PATCH /mods/:modId` with `{ enabled, force? }`: switches a mod or plugin on or off (see below)
- `GET /mods/backups`: backups that updates left behind (size, associated mod, what would be cleaned up), `POST /mods/backups/cleanup` cleans up

Installing, updating, deleting and enabling/disabling mods are locked while the server is running (`409 SERVER_RUNNING`). Start, installation, deletion and mod changes of a server share one lock and never run at the same time.

### Enabling and disabling mods

A disabled mod is named `<name>.jar.disabled` in the same folder; loaders ignore it. In the database the name stays without `.disabled` and the column `enabled` (default `true`) holds the state. The scan recognizes `.jar.disabled` through the hash as the same mod: files renamed by hand toggle the state (`toggled` in the scan report), renaming and replacing work as before. If `a.jar` and `a.jar.disabled` lie side by side, the active file wins and the other is ignored with a warning; no duplicates arise and no entries are lost.

- Disabling a mod that active other mods need: `409 MOD_REQUIRED_BY_OTHERS` with the dependents, unless `force` is used. Disabled dependents do not count.
- Enabling a mod with disabled required dependencies: enables them recursively as well and reports them in `dependencies` and `warnings`; `409 MOD_INCOMPATIBLE` if it collides with an active mod (nothing is changed).
- Installing a mod whose dependency exists in a disabled state enables it again (`reenabled`, note in `warnings`). Incompatibilities count only between active mods. An already present but disabled mod results in `409 MOD_DISABLED` when installing.
- Updates also work for disabled mods: the new file stays `.jar.disabled`, backup and undo preserve the state. Deleting removes both spellings. On any error everything is reset (files and database). Locked files result in `409 FILE_LOCKED`.

### Update backups

After every update, only the newest `MOD_BACKUP_KEEP` (default 3) files per mod remain in `mods_backup/` or `plugins_backup/`; the one just created is never deleted. Files that are not assigned to an update are left untouched. The interface shows the size and "Aufräumen" (clean up).

## World backups

Per server under `/api/servers/:serverId`:

- `GET /backups`: list with kind (`manual`, `auto`, `safety`), status (`running`, `ok`, `failed`), size, schedule and free disk space
- `POST /backups` with `{ includeConfig? }`: starts a backup and answers immediately with `202`; the result arrives through the event `backup.changed`
- `GET /backups/:backupId/download`: the archive (with login if `AUTH_TOKEN` is set; the file name never comes from the request)
- `POST /backups/:backupId/restore`: only while the server is stopped (`409 SERVER_RUNNING`)
- `DELETE /backups/:backupId`, `PATCH /backups/schedule` with `{ intervalHours (1 to 720 or null), keepLast (1 to 100), includeConfig }`
- `DELETE /api/servers/:id?confirm=true&backups=delete|keep`: if the server has backups, `backups` must be given (otherwise `409 BACKUPS_DECISION_REQUIRED`); `keep` leaves the archives in the folder together with a `server.json`

The archives are stored as `.tar.gz` in `<DATA_DIR>/backups/<server ID>/`. What is backed up is the world from `level-name` in `server.properties` (default `world`) with `<name>_nether` and `<name>_the_end`, without `session.lock`; symlinks are skipped. With `includeConfig`, `server.properties`, `ops.json`, `whitelist.json`, `banned-players.json`, `banned-ips.json`, `bukkit.yml`, `spigot.yml`, `paper.yml`, `commands.yml`, `permissions.yml`, `help.yml` and the folders `config` and `defaultconfigs` are added. The archive contains `worldfoundry-backup.json`.

- **Running server:** `save-off`, then `save-all flush`, then waiting for the real confirmation in the console (the texts of Vanilla, Paper, Forge and older versions are recognized, such as "Automatic saving is now disabled", "Saved the game"/"Saved the world", also inside `[Server: ...]`; chat lines trigger nothing; time limits 30 s, 5 min and 30 s), archiving, and **always** `save-on` afterwards, also on errors and timeouts. A backup never blocks or ends the server; if it is stopped meanwhile, the incomplete backup is discarded. If a very old server does not know `flush`, a plain `save-all` follows.
- **Stopped server:** plain archive under the server lock.
- **Restoring:** first unpacks into a folder inside the server folder (zip-slip protection, size limit, contents must match the description), then creates a safety backup of the current state (if that fails, the restore aborts) and swaps the folders last; on an error everything is reset, the old world is preserved.
- **Schedule and retention:** every N hours, also while the server is running; a stopped server with an unchanged world is skipped. The schedule is stored in the database and survives restarts. After an automatic backup, only older **automatic** ones beyond `keepLast` are deleted, never hand-made and safety backups.
- A failed backup is logged, stored as a record with an error text, reported as an event and shown in the server console. Free disk space is checked before writing (a `507 DISK_FULL` message in the record). Interrupted backups are marked as failed at start, partial files are deleted.

## Importing and exporting worlds

An existing world (with or without mods) can be brought in and out as an archive. In the interface: wizard "Neuer Server" (new server) → "Aus vorhandener Welt" (from an existing world, `/new/world`) as well as, on a server's page under "Backups", the sections "Welt exportieren" (export world) and "Welt ersetzen" (replace world; only while the server is stopped); each backup can additionally be exported as a world archive.

**Export** (per server, paths below `/api`):

- `POST /servers/:serverId/exports` with `{ format: "zip"|"tar.gz", mods: "none"|"manifest"|"jars", includeConfig }` starts the export (`202`, `{ export }`). `GET /exports/:exportId` shows `status` (`running`, `ready`, `failed`), `GET /exports/:exportId/download` delivers the file as a stream with `Content-Length`, `DELETE /exports/:exportId` cleans up. Finished exports stay for about 30 minutes in `<DATA_DIR>/tmp/exports`.
- `POST /servers/:serverId/backups/:backupId/export` with `{ format }` exports a backup as a world archive.
- The archive contains the world (`level-name`, `_nether`, `_the_end`) and `worldfoundry-export.json` (format, app version, Minecraft version, loader and loader version, mods with name, file name, SHA-1/SHA-512, Modrinth project/version, active/disabled, side, export time); with `includeConfig` the configuration files, with `mods: "jars"` the jar files in `mods/` or `plugins/`. If the server is running, as with backups `save-off`, `save-all flush`, archiving, always `save-on` applies. The archive is first written to `<DATA_DIR>/tmp` (free disk space is checked); this way the server's saving does not depend on the download speed.

**Import:**

- `POST /imports[?serverId=<id>]`: The upload is the raw request body (`Content-Type: application/octet-stream`, not multipart), is written to disk in chunks and is limited by `IMPORT_MAX_MB` (default 262144, i.e. 256 GB; `413 IMPORT_TOO_LARGE`). There is no time limit for the request, so archives of 50 GB and more work; the free disk space is checked up front for the upload and the unpacked world (`507 DISK_FULL`, with `neededMb` and `freeMb` in the params; see [World import and disk space](CONFIGURATION.md#world-import-and-disk-space)). With `serverId` it is meant for replacing the world of that stopped server. Answers `202`; the check runs in the background, `GET /imports/:importId` returns `status` (`analyzing`, `staged`, `applying`, `done`, `failed`) and the analysis. Also `GET /imports/limits` and `DELETE /imports/:importId`.
- `.zip` and `.tar.gz` are accepted: a WorldFoundry export, a single-player world (`level.dat` in the root folder or one level deeper, also with `DIM-1`/`DIM1`) or a whole server folder with `server.properties`, world and `mods/`. Rejected are zip-slip, symlinks, too many entries, too much unpacked data, a conspicuous ratio of unpacked to packed size (`ARCHIVE_UNSAFE`, `ARCHIVE_TOO_LARGE`, `ARCHIVE_BOMB`) and Bedrock worlds. Intermediate states are in `<DATA_DIR>/tmp/imports` and are deleted after errors, cancellation, timeout (2 hours) and at start.
- Analysis: `level.dat` is read with a custom NBT reader (`Version.Name`, `DataVersion`, name, game mode, hardcore, Forge mod list from `FML`/`fml`, `ServerBrands`). If the version name is missing, the version is estimated from the `DataVersion`; with neither ("older than 1.9"), the version must be chosen yourself. Mods are recognized from `fabric.mod.json`, `quilt.mod.json`, `META-INF/mods.toml`, `neoforge.mods.toml`, `mcmod.info`, `plugin.yml` and the manifest. Loader, loader version (the recommended one) and Minecraft version are suggested.
- `POST /imports/:importId/review` with `{ loader, mcVersion }` returns hints about the chosen target (a world newer than the server blocks with `WORLD_NEWER`; an older world, mods without a matching loader, a switch between Fabric/Forge and others need a confirmation) and the mod comparison: jar files are recognized on Modrinth through their SHA-512 (then they are updatable), mods without a file are found through project ID, slug or search; `not-found` means missing.
- `POST /imports/:importId/create-server` with `{ server: <as POST /servers>, importConfig, selection: { jars, install }, acknowledged }` creates the server (EULA as given, free port), puts the world in place, places the chosen jar files (the scan makes them manageable as manual mods and links them to Modrinth through the hash) and installs chosen Modrinth mods including dependencies after the server installation.
- `POST /servers/:serverId/world/replace` with `{ importId, acknowledged }` only while the server is stopped: safety backup, then swapping the folders; on an error everything is reset.
- Dimensions: Vanilla, Fabric, Forge and NeoForge store Nether and End in the world folder (`DIM-1`, `DIM1`), Paper next to it (`<name>_nether/DIM-1`, `<name>_the_end/DIM1`). On import, the data is rearranged into the format of the target server; the single-player save from `level.dat` is taken over as `playerdata/<UUID>.dat`.

## Installation log

`GET /api/servers/:id/install-log?tail=500` (1 to 5000) returns `{ lines: [{ seq, time, text }], totalLines, truncated }` from `install.log` (the file is read only if it is a regular file; control characters are removed). `seq` is the line number in the file and is also in every `install.log` event; this is how the interface merges file and live lines without duplicates and gaps.

## Autostart

`PATCH /api/servers/:id` with `{ autoStart: true }`. After the application starts (after the recovery of interrupted installations and backups), these servers are started one after another and without blocking the web server, in the order of creation, only with an accepted EULA and a finished installation. If Java is missing, it is installed first, before the next server follows. An error is logged and shown as the status (`crashed` with a message) of the affected server; the others start anyway. Starting WorldFoundry together with the computer is handled by the Windows service or the systemd service of the installation packages.

## Authentication

`GET /api/auth/status` (`authRequired`, `authenticated`, `credential` = `none | token | password`), `POST /api/auth/login` with `{ "token": "…" }` (also `{ "password": "…" }`), `POST /api/auth/logout`, `POST /api/auth/password` with `{ currentPassword?, newPassword }` (`403 CURRENT_PASSWORD_WRONG`, `422 PASSWORD_TOO_WEAK | PASSWORD_UNCHANGED`, `429`). Details: [CONFIGURATION.md](CONFIGURATION.md#web-interface-password).

## WebSockets

Both endpoints send JSON messages. Slow clients (more than 1 MiB of unsent data) are disconnected.

- `ws://<host>/api/servers/:id/console?history=1000`: on connect `{type:"status",status}` and `{type:"history",lines}`, afterwards `{type:"line",line}` and `{type:"status",status}`. The client sends `{type:"command",command,id?}` and receives `{type:"ack",id?}` or `{type:"error",code,message,id?}`; `{type:"ping"}` is also answered. Errors and invalid JSON do not close the connection. A line has `seq`, `time`, `stream` (`stdout`, `stderr`, `system`, `input`) and `text`.
- `ws://<host>/api/events`: first `{type:"snapshot",servers}`, afterwards `server.status`, `server.metrics`, `server.crashed`, `server.changed`, `install.state`, `install.progress`, `install.log` (with `seq` and `time`), `java.install` (`major`, `state`, `phase`, `percent`, `message`), `backup.changed` and `mods.updates`. The state `preparing` arrives as `server.status`. The self-update additionally sends `update.state`.
