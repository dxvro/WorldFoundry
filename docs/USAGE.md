# WorldFoundry: Using the web interface

> **WorldFoundry is not an official product of any game publisher.** The disclaimer of each game is in [TRADEMARKS.md](../TRADEMARKS.md).
> NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.

This page describes the web interface and how servers are created, installed and started. Installation of WorldFoundry itself is in [INSTALL.md](INSTALL.md), settings are in [CONFIGURATION.md](CONFIGURATION.md), and the HTTP interface is in [API.md](API.md).

> **Language note:** the web interface is available in German and English. The language can be switched in the interface. Button and menu names in this documentation are given as they appear in the German interface.

**Contents**

- [Web interface](#web-interface)
- [Creating, installing and starting servers](#creating-installing-and-starting-servers)
  - [Supported loaders](#supported-loaders)
  - [Java detection](#java-detection)
  - [Automatic Java installation](#automatic-java-installation)
- [Worlds, backups and mods](#worlds-backups-and-mods)

## Web interface

The interface is a dark operations dashboard for phone, tablet and desktop. It offers:

- **Overview** with status, CPU, memory, players, port, and start/stop/restart/force-stop per server, live through `/api/events`, plus the LAN addresses and the memory of the computer.
- **Wizard** for new servers: loader, version with a snapshot switch, loader version, port, a memory slider up to the real maximum of the computer, a Java warning and an EULA checkbox that is empty by default. A live installation log and a retry option for failures follow.
- **Mods:** a switch per entry (switched-off entries are dimmed, filter All/Active/Disabled), dialogs for "disable anyway" and a message listing the dependencies that were enabled along with a mod, "Disabled" with "Enable" in the store, and the view "Update backups" with "Clean up".
- **Backups:** a separate area per server with list, create, download, restore with confirmation, delete and schedule; when a server with backups is deleted, you choose whether to delete or keep them.
- **Java:** progress in the wizard, in the installation area and on the server page, a list of runtimes with their origin in the configuration including "Install Java N" and "Remove"; instead of the dead end "set Java runtime", a start error offers "Install Java N". The warning about missing Java in the wizard now appears only with `JAVA_AUTO_INSTALL=false`.
- **Server page** with the areas Console (history, live lines, command history, filter, reconnecting without gaps or duplicates), Configuration (`server.properties`, Java, memory, EULA, rename, delete with name confirmation), Mods or Plugins (Paper), and Mod store or Plugin store.
- **System** with the version, **Network & access** (addresses on the home network, bind address, port, host names, restart), **Password**, updates and history.
- **Notice** "Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft." on every page (sidebar or footer, also at 360 px) and on the login page.
- **Login**, as soon as `AUTH_TOKEN` or a password is set; a `401` anywhere leads back to the login.

The interface needs no internet access: fonts are bundled and there are no CDN scripts. The only external images are the icons from Modrinth (`cdn.modrinth.com`); if they are missing, a letter tile is shown. It uses no browser features that are available only over HTTPS or localhost, so it also works over `http://<LAN IP>`. All texts from servers and Modrinth are rendered as text, never as HTML. HTML responses carry `Content-Security-Policy` (own sources only, images additionally from `cdn.modrinth.com`), `X-Frame-Options: DENY` and `X-Content-Type-Options: nosniff`. The host, origin and login checks apply unchanged; the interface itself (HTML, scripts, fonts) can be fetched without logging in, every path below `/api` cannot (see [Security](CONFIGURATION.md#security)).

## Creating, installing and starting servers

1. `POST /api/servers` creates the record and answers immediately with `201` and `installState: "pending"`. The installation then runs in the background (`installing`, then `installed` or `failed` with `installError`). Progress and log arrive as events through `/api/events` and are stored in `<SERVERS_DIR>/<server ID>/install.log`. A failed installation is restarted with `POST /api/servers/:id/install`. When the program starts, installations that were left hanging are marked as failed ("interrupted").
2. **EULA:** The server starts only if it was explicitly accepted for it (`eulaAccepted: true` on creation or by `PATCH`). The application never accepts by itself. Only then does it write `eula.txt` with `eula=true` at start. If the acceptance is withdrawn, `eula=false` is written. The EULA is at https://aka.ms/MinecraftEULA.
3. **Start** checks in this order: installed, EULA, matching Java version (`422 JAVA_NOT_FOUND` / `JAVA_VERSION_INCOMPATIBLE`), port, port conflict with other running servers, and a real bind test on `0.0.0.0` and `127.0.0.1` (`409 PORT_IN_USE`). The port in `server.properties` is authoritative; the database is adjusted to it. States (`offline`, `starting`, `online`, `stopping`, `crashed`) exist only in memory. A crash is not restarted automatically.
4. At start, a mod update check is triggered in the background (not for Vanilla). The result arrives as the event `mods.updates` and never blocks the start.

### Supported loaders

| Loader   | Source                                                             | Download verification                  | Installation                                |
| -------- | ------------------------------------------------------------------ | -------------------------------------- | ------------------------------------------- |
| Vanilla  | Mojang (`piston-meta.mojang.com`)                                  | SHA-1 and size                         | `server.jar`                                |
| Fabric   | `meta.fabricmc.net`                                                | no checksum published: host and ZIP format | `fabric-server-launch.jar`              |
| Paper    | PaperMC Fill v3 (`fill.papermc.io`), stable builds preferred       | SHA-256 and size                       | `paper-<version>-<build>.jar`               |
| NeoForge | `maven.neoforged.net` (not for Minecraft 1.20.1, use Forge there)  | SHA-512/256/1 from the published file  | installer with `--install-server`           |
| Forge    | `files.minecraftforge.net`, installer from `maven.minecraftforge.net` (from Minecraft 1.7.2) | SHA-512/256/1 from the published file | installer with `--installServer` |

The required Java version comes from the Mojang version data of the respective Minecraft version (for Paper, additionally the value from PaperMC). Forge up to Minecraft 1.12.2 runs only with Java 8 and is rejected with higher versions. Downloads are restricted to these hosts (redirects included): `piston-data.mojang.com`, `launcher.mojang.com`, `meta.fabricmc.net`, `fill-data.papermc.io`, `maven.neoforged.net`, `maven.minecraftforge.net` (mods as before only `cdn.modrinth.com`). Version lists are cached for five minutes. Modern Forge and NeoForge installations are started through `@libraries/.../win_args.txt` or `unix_args.txt` (depending on the operating system), older Forge versions through the generated `forge-*.jar`.

### Java detection

`GET /api/system` lists the Java installations found (`JAVA_HOME`, `PATH`, `Program Files\Java`, Eclipse Adoptium, Microsoft, Zulu, BellSoft, Amazon Corretto, Semeru, `/usr/lib/jvm`, `/Library/Java/JavaVirtualMachines`, and the runtimes installed by WorldFoundry itself) with their major version. Runtimes installed by WorldFoundry have `source: "managed"` and an explanation of their origin in `origin`; `managedJava` gives size, checksum and which servers currently use them, `javaInstalls` the running installations, and `javaAutoInstall` the value of `JAVA_AUTO_INSTALL`. `?rescan=true` forces a new search; otherwise a short cache applies. Without a configured `javaPath`, the lowest matching version is chosen (for Forge up to 1.12.2 exactly Java 8). A configured `javaPath` is never replaced automatically.

Which version a server needs is shown in the server response (`requiredJavaMajor`), for example Java 21 for Minecraft 1.21.1 and Java 25 for 26.x.

### Automatic Java installation

If the matching Java version is missing for a server, WorldFoundry installs it itself, both for the Forge/NeoForge installers and at start (`JAVA_AUTO_INSTALL=false` restores the earlier errors `JAVA_NOT_FOUND`/`JAVA_VERSION_INCOMPATIBLE`; manual installation in the interface remains possible).

- **Source:** Eclipse Temurin through the Adoptium API (`https://api.adoptium.net/v3/assets/latest/<version>/hotspot`). The metadata provides download link, size and SHA-256. Only the three hosts that a download actually touches are allowed (checked on 5 Nov 2026, also for Java 8, 17, 21 and 25): `api.adoptium.net`, `github.com` (redirect to the release) and `release-assets.githubusercontent.com`. Every redirect is checked individually against this list.
- **Target:** `<DATA_DIR>/runtimes/temurin-<major version>/`, for WorldFoundry only. There is no system-wide installation and no change to PATH or the registry.
- **Procedure:** download to `.tmp-*`, check size and SHA-256, extract safely (zip on Windows, tar.gz on Linux/macOS; paths outside the target folder, absolute paths, `..`, symlinks pointing out of the folder and oversized archives are rejected), run `java -version` and check the major version, then write a marker and move the folder into place with a rename. Aborted or failed runs leave nothing usable; leftovers (`.tmp-*`, `.removing-*`, folders without a marker) are deleted at start. Free disk space is checked before the download.
- **Platforms:** win32/linux/darwin with x64/arm64. If a combination does not exist at Adoptium (for example Java 8 on Windows arm64), `422 JAVA_NOT_AVAILABLE` is returned with an explanation in German; for unknown platforms, `JAVA_PLATFORM_UNSUPPORTED`.
- **Which version:** The lowest long-term-supported version that satisfies the server is installed (8, 11, 17, 21, 25; Minecraft's Java 16 becomes 17); above that, the exact minimum version. Upper limits are respected: Forge up to 1.12.2 gets exactly Java 8.
- **JRE instead of JDK:** The JRE image is downloaded (about 40 to 60 MB instead of 100 to 200 MB). Server jars and the installers need only the runtime, not a compiler. Verified: the JRE 21 and 25 contain all runtime modules (among them `jdk.unsupported`, `jdk.zipfs`, `jdk.crypto.ec`, `jdk.management`, `jdk.jfr`, `java.sql`); only developer tools such as `jdk.compiler` are missing. The real Forge 1.12.2 installer ran through without errors with the JRE 8. Not checked by hand: modern Forge and NeoForge installers, and a real server start with the JRE. If no JRE image exists for a version and platform, WorldFoundry automatically takes the JDK.
- **One installation per version:** If several servers or jobs request the same version at the same time, they share one download including its progress. It is cancelled only when the last waiting party has given up (or the application ends).

**Procedure at start (without waiting inside the request):** `POST /api/servers/:id/start` answers immediately. If Java is missing, the server enters the new state `preparing` (interface: "Bereitet vor", preparing) with the message "Java 21 wird installiert ..." (installing Java 21). Progress and steps appear in the server's console (system lines), in the status (`message`) and as the event `java.install`. The installation runs in the background **without** holding the server lock (otherwise it would block, for example, saving properties); the server still counts as running, which is why deleting, mod changes, installation and a second start are rejected with `409`. Once the runtime is there, the normal start path runs again under the lock (port, EULA and files are checked again) and the state goes through `starting` to `online`. An error (download, checksum, port in use ...) ends as `crashed` with a readable message and console line. **Stop, force-stop and restart** cancel the preparation (state `offline`, no process); the download continues for other servers. **When the application shuts down**, preparations are cancelled and the running installation including its `.tmp` folder is cleaned up. In the interface, the stop button is called "Abbrechen" (cancel) during this phase.

The list of runtimes with origin, "Install Java N" and "Remove" (only if no running server uses it, otherwise `409 JAVA_IN_USE`) is in a server's configuration.

## Worlds, backups and mods

Mod management (enabling and disabling mods, update backups), world backups, world import and export, the installation log and autostart are described together with their API routes in [API.md](API.md):

- [Mod management](API.md#mod-management), including [enabling and disabling mods](API.md#enabling-and-disabling-mods) and [update backups](API.md#update-backups)
- [World backups](API.md#world-backups)
- [Importing and exporting worlds](API.md#importing-and-exporting-worlds)
- [Installation log](API.md#installation-log) and [autostart](API.md#autostart)
