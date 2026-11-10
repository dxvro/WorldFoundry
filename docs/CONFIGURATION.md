# WorldFoundry: Configuration, network and security

> **WorldFoundry is not an official product of any game publisher.** The disclaimer of each game is in [TRADEMARKS.md](../TRADEMARKS.md).
> NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.

> **Security notice:** The API can start processes and run console commands. There is always a sign-in: the first start without `AUTH_TOKEN` creates a password (see [Password](#web-interface-password)). Even so, run it only in trusted networks and never expose it to the internet.

**Contents**

- [Configuration](#configuration)
  - [Running without the project folder](#running-without-the-project-folder)
- [Access on the home network](#access-on-the-home-network)
- [Ports and network](#ports-and-network)
- [Web interface password](#web-interface-password)
- [Security](#security)

Installation steps are in [INSTALL.md](INSTALL.md) (its section 8 lists the same variables for the installed packages), the interface is described in [USAGE.md](USAGE.md).

## Configuration

Optional, through environment variables or a configuration file (template: `.env.example`). Real environment variables take precedence over the file. The file is called `.env` in the project root by default and can be placed anywhere with the environment variable `CONFIG_FILE`. If you name `CONFIG_FILE`, the file must exist (otherwise start aborts with a message), and relative paths in the file then apply relative to it; without `CONFIG_FILE`, a missing file is normal.

| Variable               | Default                          | Meaning                                                                                   |
| ---------------------- | -------------------------------- | ----------------------------------------------------------------------------------------- |
| `HOST`                 | `0.0.0.0`                        | Address the server binds to. A setting under **System > Netzwerk & Zugriff** (Network & access) takes precedence (see [Access on the home network](#access-on-the-home-network)) |
| `PORT`                 | `3000`                           | HTTP port, can also be changed in the web interface                                       |
| `CONFIG_FILE`          | `<project>/.env`                 | Path of the configuration file (only as a real environment variable, not inside the file itself) |
| `DATA_DIR`             | `<project>/data`                 | Database, Java runtimes (`runtimes/`) and backups (`backups/`)                            |
| `SERVERS_DIR`          | `<project>/servers`              | Folder of the Minecraft server instances (`<SERVERS_DIR>/<server ID>/`)                   |
| `LOG_LEVEL`            | `info`                           | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`                              |
| `MODRINTH_USER_AGENT`  | `WorldFoundry/<version>`        | User agent for Modrinth and loader requests (do not enter personal data)                  |
| `AUTH_TOKEN`           | (empty = a password is created)  | Access token, at least 8 characters. Enables the login for the whole API. At the same time the first password of the web interface and the machine access (`Authorization: Bearer`) for scripts and the update service, see [Password](#web-interface-password) |
| `STEAMCMD_PATH`        | (empty = download into data)     | Existing SteamCMD for Steam game servers (Project Zomboid). Without it SteamCMD is downloaded from Valve into `<DATA_DIR>/steamcmd` |
| `ALLOWED_ORIGINS`      | (empty)                          | Comma-separated additional origins (the Vite dev proxy needs no entry)                    |
| `ALLOWED_HOSTS`        | (empty)                          | Comma-separated additional host names without port, e.g. `craft.example.lan` (see [Security](#security)). More can be added in the web interface |
| `FRONTEND_DIR`         | `<code>/../frontend/dist`        | Folder with the built web interface                                                       |
| `JAVA_AUTO_INSTALL`    | `true`                           | Install a missing Java version automatically (`true`/`false`, also `1`/`0`, `ja`/`nein`)  |
| `MOD_BACKUP_KEEP`      | `3`                              | Backups per mod in `mods_backup/` or `plugins_backup/` that remain after updates (1 to 100) |
| `UPDATE_CHECK`         | `true`                           | Look for new releases (`false` switches off checking and updating completely, see [Updates](UPDATES.md)) |
| `UPDATE_REPO`          | `dxvro/WorldFoundry`            | GitHub repository (`owner/name`) whose releases are checked                               |
| `UPDATE_CHANNEL`       | `stable`                         | `stable` or `prerelease` (then also pre-release versions such as `1.0.0-rc.1`)            |
| `UPDATE_COUNTDOWN_SECONDS` | `60`                         | Countdown before the servers are stopped for an update (0 to 600)                         |
| `IMPORT_MAX_MB`        | `262144`                         | Largest archive file allowed for a world import, in MB (16 to 1048576; the default is 256 GB); unpacked, at most four times that is allowed. The real limit is the free disk space: an import needs room for the upload, the unpacked world and, when replacing a world, the safety backup (see [World import and disk space](
| `STOP_TIMEOUT_SECONDS` | `120`                            | Wait time after `stop` before a server is killed (5 to 3600); do not choose it too tight for large worlds, otherwise data can be lost while saving |

Development only (Vite): `FRONTEND_PORT` (default 5173), `FRONTEND_HOST` (default `localhost`) and `BACKEND_PORT` (default `PORT`, otherwise 3000). See [DEVELOPMENT.md](DEVELOPMENT.md).

The folders `data/` and `servers/` are created at start and are not part of the repository.

### World import and disk space

A world of 50 GB or more can be imported and exported; the default  of 262144 (256 GB) only keeps absurd uploads out. What really limits an import is the free disk space and the time, and the space is checked before anything large is written (error  with the amount needed and the amount free):

- **Upload:** needs about twice the archive size in the  folder of the data directory (the archive and then the unpacked world, which are both there for a while). The check uses the size announced by the browser, so a too small disk is reported before the first byte arrives.
- **Unpacking:** for a ZIP the exact unpacked size is read from the archive first and checked against the free space (plus 128 MB). For a  the size inside is unknown; at least twice the archive size is checked, and a full disk during unpacking is still reported as . The unpacked size may be at most four times , and a ZIP that unpacks to more than 200 times its size is refused as a zip bomb. Entries and archives above 4 GiB (ZIP64, and tar sizes above 8 GiB) are supported.
- **Replacing a world:** needs room for the safety backup of the old world (barely compressible, so assume about 90 percent of its size; it is stored with the backups) and, if the server folder is on another drive than the data directory, a full copy of the new world. Altogether a 50 GB world can need roughly three times its size (150 GB) free on one drive: the staged new world, the old world until the swap, and the safety backup.
- **Export and backup:** write the archive to a temporary file first; about 90 percent of the world size must be free (Minecraft region files hardly compress).
- **Time:** the upload is a single request without time limit. At 100 Mbit/s a 50 GB archive takes about 70 to 80 minutes, at 1 Gbit/s about 7 to 9 minutes, plus a few minutes for unpacking (the speed of the disk decides). Keep the browser tab open until the check is finished. A backup or export of 50 GB takes a quarter of an hour or more because of the compression.

### World import and disk space

A world of 50 GB or more can be imported, exported and backed up. The default `IMPORT_MAX_MB` of 262144 (256 GB) only keeps absurd uploads out. What really limits an import is the free disk space and the time. The space is checked before anything large is written, and the error `DISK_FULL` names the amount needed and the amount free:

- **Upload:** needs about twice the archive size in the `tmp` folder of the data directory (the archive and, for a while, the unpacked world next to it). The check uses the size the browser announces, so a disk that is too small is reported before the first byte arrives.
- **Unpacking:** for a ZIP the exact unpacked size is read from the archive first and checked against the free space (plus 128 MB). For a `.tar.gz` the size inside is unknown; at least twice the archive size is checked, and a disk that fills up during unpacking is still reported as `DISK_FULL`. The unpacked size may be at most four times `IMPORT_MAX_MB`, and a ZIP that unpacks to more than 200 times its own size is refused as a zip bomb. Archives and entries above 4 GiB are supported (ZIP64; tar sizes above 8 GiB).
- **Replacing a world:** needs room for the safety backup of the old world (Minecraft region files hardly compress, so assume about 90 percent of its size) and, if the server folder is on another drive than the data directory, a full copy of the new world. A 50 GB world can therefore need roughly three times its size (150 GB) on one drive: the staged new world, the old world until the swap, and the safety backup.
- **Export and backup:** are written to a temporary file first; about 90 percent of the world size must be free.
- **Time:** the upload is a single request without a time limit. At 100 Mbit/s a 50 GB archive takes about 70 to 80 minutes, at 1 Gbit/s about 7 to 9 minutes, plus a few minutes for unpacking (the speed of the disk decides). Keep the browser tab open until the check has finished. A backup or export of 50 GB takes a quarter of an hour or more because of the compression.

### Running without the project folder

The application does not require a repository. Migrations (`drizzle/`) live in the code folder and are found relative to it, and the web interface by default as `<backend>/../frontend/dist`, both independent of the working directory. If the code does not run from a checkout (`<project>/packages/backend`), data and servers are by default stored in a user folder (Windows `%LOCALAPPDATA%\WorldFoundry`, macOS `~/Library/Application Support/WorldFoundry`, Linux `$XDG_DATA_HOME/worldfoundry` or `~/.local/share/worldfoundry`). `DATA_DIR`, `SERVERS_DIR`, `FRONTEND_DIR` and `CONFIG_FILE` each override that completely; a `.env` in the project is not needed. At start, the log states which configuration file and which folders are used. The ready-made installation packages (Windows service, Linux systemd) use exactly this mechanism with `CONFIG_FILE`; see [INSTALL.md](INSTALL.md).

## Access on the home network

At start, WorldFoundry names the addresses in the log, for example:

```
Weboberfläche erreichbar unter: http://192.168.178.20:3000 (Rechnername: http://MCPC:3000; VPN/virtuell: http://172.28.16.1:3000 [vEthernet (WSL (Hyper-V firewall))])
```

(The log line is in German: "Web interface reachable at ... (computer name: ...; VPN/virtual: ...)".)

The same addresses are shown under **System > Netzwerk & Zugriff**, at the end of the installation (Windows installer, `install.sh`), in `credentials.txt` (credentials file) and in `GET /api/health` (`lanUrls`, only when logged in). Only IPv4 addresses of real network adapters are shown, private ranges (192.168/16, 10/8, 172.16/12) first, without loopback and without link-local addresses (169.254/16). Adapters of WSL, Hyper-V, Docker, VirtualBox, VMware, Tailscale, ZeroTier, WireGuard and other VPNs appear separately as "VPN/virtual", so that the address for the devices on the home network comes first. If WorldFoundry binds to a single address, only that one is named; for `127.0.0.1`, only "this computer".

**Settings in the web interface** (System > Netzwerk & Zugriff, stored in the database, taking precedence over `HOST`, `PORT` and `ALLOWED_HOSTS` of the configuration file, which remains as a fallback):

| Setting | Meaning |
| --- | --- |
| Lauschen auf (Listen on) | all network adapters (`0.0.0.0`), one of the detected addresses of this computer, or `127.0.0.1` (this computer only). An address that does not belong to the computer is rejected. |
| Web-Port | 1 to 65535; must be free (a real bind test like when starting a Minecraft server) and must not belong to a Minecraft server. The port WorldFoundry is currently listening on does not count as occupied. |
| Weitere erlaubte Rechnernamen (Further allowed host names) | e.g. `minecraft.fritz.box`; extends the host check (see [Security](#security)) in addition to `ALLOWED_HOSTS`. |
| Öffentliche Adresse (Public address) | optional, shown to everyone as the address (`minecraft.fritz.box:3000` or a full `http://` address); its host name is allowed automatically. |

Changes apply only after a restart. **Jetzt neu starten** (Restart now) first shows the new address, stops all running Minecraft servers with the normal stop logic (the world is saved), remembers which ones were running, ends WorldFoundry with exit code 75 and starts the servers again after the restart. The browser switches to the new address by itself as soon as it answers. Who starts WorldFoundry again afterwards?

| Installation | Restart after exit code 75 |
| --- | --- |
| Linux (systemd) | automatic: `Restart=on-failure` (and `RestartForceExitStatus=75`), after about 5 seconds |
| Windows service (WinSW) | automatic: recovery action "Restart" (`onfailure`), after 10 to 60 seconds |
| Portable ZIP | `start-portable.cmd` restarts itself on code 75 |
| Source (`npm start`, `npm run dev`) | start again by hand; the interface points this out |

**Safety net against lock-out:** If the saved address does not exist at start (adapter disconnected, address changed by the router), WorldFoundry listens on `0.0.0.0` instead, writes a warning to the log and shows it as a notice on the system page. If the saved port is in use, WorldFoundry takes the port from the configuration file. Only if that one is also in use does start abort with the usual message. The address actually used is stored in `<DATA_DIR>/network.json`; the installer and the update service check there whether the application answers.

**Fixed address:** So that the computer's IP address does not change, assign a fixed address in the router (DHCP reservation). FRITZ!Box: **Heimnetz > Netzwerk >** **edit** the device in the list and enable **"Diesem Netzwerkgerät immer die gleiche IPv4-Adresse zuweisen"** (always assign the same IPv4 address to this network device). Alternatively, use a name such as `minecraft.fritz.box` in the router and enter it in the interface under "Weitere erlaubte Rechnernamen".

**Firewall:** If other devices cannot reach the page, the firewall is probably blocking the web port. On Windows (administrator PowerShell, adjust the port if needed):

```
New-NetFirewallRule -DisplayName "WorldFoundry" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
```

On Linux with ufw `sudo ufw allow 3000/tcp`, with firewalld `sudo firewall-cmd --permanent --add-port=3000/tcp && sudo firewall-cmd --reload`. If the web port is changed in the interface, the rule must be created for the new port; the rule of the Windows installer ("WorldFoundry - Web") is aligned to the current port by the installer on a repeated run (also during an update). For the Minecraft servers themselves, the respective server port (default 25565) must also be opened.

If the port is already in use at start (and no fallback is possible), start aborts with a message. In that case change `PORT` in the `.env`.

## Ports and network

| Port                      | Purpose                                         | Who must reach it                 |
| ------------------------- | ----------------------------------------------- | --------------------------------- |
| TCP 3000 (`PORT`)         | Web interface and API                           | Devices on the LAN that should manage servers |
| TCP 25565 (per server)    | Minecraft server; further servers need further ports (default of the installation: 25565-25575) | Players |

- **LAN access:** By default WorldFoundry listens on `0.0.0.0` and is therefore reachable in the whole network as soon as the firewall allows the port. The address is `http://<computer name>:3000` or `http://<IP address>:3000`; at start the reachable addresses are named in the log. If the interface should be reachable under a name of your own, enter the name in `ALLOWED_HOSTS` of the configuration file (see [Security](#security)). Local only: `HOST=127.0.0.1` (or "Nur dieser Rechner" in the web interface). Details and settings: [Access on the home network](#access-on-the-home-network).
- **VM:** The VM needs a network bridge (bridged) or port forwards of the hypervisor for TCP 3000 and the Minecraft ports; in the default "NAT" mode it cannot be reached from outside.
- **Players from the internet:** Forward only the Minecraft ports (e.g. TCP 25565) on the router to the computer. **Never expose the web port 3000 to the internet:** the interface is unencrypted (HTTP) and can start programs. Anyone who wants to use it from outside should use a VPN.
- The login by token or password is the only protective layer, so do not pass it on. If you suspect it has leaked, change the password (System > Passwort), change the token in the configuration file (at least 8 characters) and restart the service.

## Web interface password

`AUTH_TOKEN` enables a login. The token from the configuration (generated randomly by the installer) is the **first password**. Under **System > Passwort** (Password) you can set your own (at least 10 characters, strength indicator):

- **Stored** is only a scrypt hash (N=2^15, r=8, p=1, random salt per password, compared with `timingSafeEqual`) in the database (`app_settings`), never the password itself.
- **Applies to the login in the browser.** Once a password is set, only it opens the web interface, no longer the token.
- **The token (`AUTH_TOKEN`) remains the machine access** for scripts and the API (`Authorization: Bearer <token>`), also for the update service (health check) and the CI tests. A password change does not touch it; it changes only in the configuration file. The password itself is not a bearer token.
- **Changing** requires the current password (before the first change, the token); wrong entries count like wrong logins (5 in 5 minutes, then `429`, per IP address). Afterwards **all other sessions are invalid** (the session value follows the password) and open WebSockets are disconnected; the browser that made the change gets a new cookie and stays logged in.
- **Without `AUTH_TOKEN` and without a password**, the first start creates a random password. It is printed once on the console (not into the log) and written to `initial-password.txt` in the data folder, readable only by the owner of that folder. Sign in with it and set your own under **System > Password**; the file is deleted as soon as another password is set.
- **Forgotten?** Only on the computer itself, never over the network: Linux `sudo worldfoundry reset-password`, Windows Start menu **Reset Password** (German installer: "Passwort zurücksetzen"; asks for administrator rights), in general `node app/backend/dist/cli.js reset-password` with the rights of the service. The command writes a new random password to the database and displays it (`--password-stdin` reads your own from standard input). The running service does not need to be stopped for this: it re-reads the hash at every login and at least once per second, so all old sessions end immediately.

## Security

- **Host check (DNS rebinding):** Every request, also `GET` and WebSocket setup, needs a `Host` header with an IP address (IPv4/IPv6), `localhost`, `*.localhost`, the computer name (case-insensitive, also with `.local`, `.lan`, `.home`, `.home.arpa` or `.fritz.box`) or an entry from `ALLOWED_HOSTS`. Otherwise the API answers `403 HOST_FORBIDDEN`, likewise for a missing `Host`. This prevents a web page with redirected DNS resolution from reaching the API in the browser of a LAN user. The Vite dev proxy over `localhost` is allowed. Anyone who reaches the interface under a name of their own enters it in `ALLOWED_HOSTS`.
- **Origin check:** For all requests except `GET`/`HEAD` and for every WebSocket setup, an existing `Origin` header must match the `Host` of the request, otherwise `403 ORIGIN_FORBIDDEN`. This prevents a foreign web page from controlling the server in the browser of a LAN user. Requests without `Origin` (curl, scripts) are allowed.
- **Login (optional):** With `AUTH_TOKEN`, every route except `GET /api/health`, `GET /api/auth/status`, `POST /api/auth/login` and `POST /api/auth/logout` requires a login through `Authorization: Bearer <token>` or through an HttpOnly/SameSite=Strict cookie. `POST /api/auth/login` with `{ "token": "..." }` sets the cookie, `POST /api/auth/logout` deletes it. WebSockets use the same cookie or the bearer header. The token is compared in constant time. If a password is set in the web interface, it applies instead of the token for `POST /api/auth/login` (hash: scrypt, see [Password](#web-interface-password)); the bearer access with the token remains. After 5 wrong logins within 5 minutes, the IP address is blocked with `429 TOO_MANY_ATTEMPTS`. Without HTTPS the token is transmitted unencrypted on the LAN; the login protects against random access, not against eavesdroppers on the network. Without a login, `/api/health` returns only `status` and `database`.
- The Java path of a server must point to a file named `java` or `java.exe` and answer `-version` (`422 JAVA_INVALID`), but it is executed. Anyone who is signed in can therefore start programs.
