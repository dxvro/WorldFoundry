# WorldFoundry: Development and building

> **WorldFoundry is not an official product of any game publisher.** The disclaimer of each game is in [TRADEMARKS.md](../TRADEMARKS.md).
> NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.

This page is for running WorldFoundry from source, developing it and building the installation packages. To simply use WorldFoundry, see [INSTALL.md](INSTALL.md).

**Contents**

- [Prerequisites](#prerequisites)
- [Installing from source](#installing-from-source)
- [Development](#development)
- [Build and start](#build-and-start)
- [Tests](#tests)
- [Building the packages yourself](#building-the-packages-yourself)

## Prerequisites

- Node.js 22 or newer (tested with 26) and npm
- **Java** to run the Minecraft servers. If the matching version is missing, WorldFoundry installs it itself (Eclipse Temurin, see [Automatic Java installation](USAGE.md#automatic-java-installation)); with `JAVA_AUTO_INSTALL=false` this does not happen and an existing installation is required. Which version a server needs is shown in the server response (`requiredJavaMajor`), e.g. Java 21 for Minecraft 1.21.1 and Java 25 for 26.x.
- No native build tools needed (SQLite runs through `@libsql/client` with precompiled binaries)

## Installing from source

```
npm install
```

## Development

```
npm run dev          # backend (tsx watch, port 3000) and Vite dev server (port 5173) together
npm run typecheck    # TypeScript check of backend and frontend including tests
npm test             # tests of backend and frontend (vitest, without network and without Java)
npm run db:generate  # generate a new migration from src/db/schema.ts
```

During development, open the interface at `http://localhost:5173`. The Vite server forwards `/api` including WebSockets to the backend (`BACKEND_PORT`, default 3000) and leaves the browser's host and origin unchanged; for this reason the backend's host and origin check passes without any additional setting. The dev server becomes reachable over the LAN address with `FRONTEND_HOST=0.0.0.0`. The frontend lives in `packages/frontend` (Vite, React, TypeScript, Tailwind CSS) and includes the backend's API types only as types (`import type` from `@worldfoundry/backend/contract`), so changes to the API show up during the type check.

Migrations are in `packages/backend/drizzle/` and run automatically at start. Migrations that have already been applied are never changed.

All settings are listed in [CONFIGURATION.md](CONFIGURATION.md#configuration).

## Build and start

```
npm run build   # builds the frontend first (packages/frontend/dist), then the backend
npm start       # backend and web interface on one port
```

Afterwards the interface is reachable at `http://localhost:3000`. The backend serves the built frontend itself (`FRONTEND_DIR`, default `packages/frontend/dist`). If the build is missing, the API still runs, and `/` shows a note to run `npm run build`. All paths below `/api` remain a JSON interface (including unknown ones, with `404 NOT_FOUND`); every other address without a file extension delivers the interface, so that direct links such as `/servers/<ID>/mods` work.

Check: `http://localhost:3000/api/health`

Stop with Ctrl+C (or `SIGINT`/`SIGTERM`/`SIGBREAK`/`SIGHUP`): first all running Minecraft servers are stopped cleanly with `stop` (world data is saved), and only after the wait time has passed are leftover processes killed. After that the web server and the database close. A second Ctrl+C during shutdown is deliberately ignored.

## Tests

`npm test` runs the tests of backend and frontend. Among them are archives (zip-slip, symlinks, limits, system tar), the Java installation (fake Adoptium/GitHub, platforms, cancellation, one download per version), the start procedure with `preparing`, mods on/off including dependencies, world backups with real files and the fake server (`save-off` / `save-all flush` / `save-on` also after errors, restoring with rollback), schedule, installation log, cleaning up the update backups, autostart, configuration paths, and an upgrade test that raises a database at the state of the previous migration, with data, to the new state. The frontend checks the API client, console logic (reconnecting, seq reconciliation, batching), autoscroll, the wizard, RAM limits, the deletion flow on `MOD_REQUIRED_BY_OTHERS` and the 401 handling. The backend tests run without network and without Java: a real `node` process (`packages/backend/test/fake-server.mjs`) replaces the Minecraft server, and a fake upstream (`fake-upstream.ts`) replaces Mojang, Fabric, Paper, NeoForge and Forge. In addition there are tests of the packaging (`node --test scripts/test/`, part of `npm test`): target systems, checksums (`SHASUMS256.txt`, npm integrity), selection of the Node LTS, tar.gz and ZIP archives with file permissions, generation of configuration and token, restriction of downloads to allowed hosts, ELF/PE header of the native library and a syntax check of the installation scripts. For the self-update there are: version comparison (SemVer), signature and hash (valid, wrong key, tampered package, tampered checksums), host list and redirects, state machine, request/status protocol, the whole procedure with countdown, stopping, hand-over, the updater's feedback and restart of the servers, the privileged updater (verification, rollback, Windows hand-over), the signing script, and the banner and system page of the interface. For network and password there are: detection of the addresses with test cases shared by the application and the installer (`scripts/test/lan-cases.json`), fallbacks when binding, validation of address/port/host names, restart with restarting the servers, scrypt hash, password change (wrong current password, sessions and sockets invalidated, rate limiting, bearer token untouched, reset from outside) and the command `reset-password`. Everything that requires real Java, real installers or a real Windows/systemd service is not checked automatically.

The tests for huge world archives (`packages/backend/test/big-archives.test.ts`) have a cheap part that always runs: ZIP64 sizes and end records, more than 65535 entries, tar sizes above 8 GiB read from the headers, and the disk-space and size-limit checks, all with archives of a few megabytes. The part that really unpacks entries above 4 GiB (zip) or 8 GiB (tar), exports an entry above 4 GiB and uses offsets above 4 GiB writes up to 8 GB to the temp folder and takes about a minute, so it only runs on request:

```
BIG_ARCHIVE_TESTS=1 npm test -w @worldfoundry/backend -- big-archives
```

(In PowerShell: `$env:BIG_ARCHIVE_TESTS='1'` first.)

## Building the packages yourself

```
npm ci
npm run package -- --target win-x64      # or linux-x64, linux-arm64
```

`scripts/package.mjs` builds the frontend and backend if needed (`--skip-build` uses the existing build), installs the backend's production dependencies from `package-lock.json` for the **target system** (also for cross builds; the matching `@libsql/<platform>` package is checked and, if needed, fetched directly from the npm registry with the SHA-512 integrity from the lock file), downloads the current Node.js LTS runtime from nodejs.org (`--node-version vX.Y.Z` fixes a version) and verifies it against `SHASUMS256.txt`, downloads WinSW 2.12.0 for Windows (SHA-256 pinned in `scripts/lib/pins.mjs`), and writes `release/<target>/` together with the archive `release/worldfoundry-<version>-<target>.(zip|tar.gz)` and `.sha256`. Downloads are restricted to `nodejs.org`, `github.com` and `registry.npmjs.org`. On a machine with the same target system, the script finally starts the bundled Node executable as a probe (libsql and application load). The Windows installer is built from `release/win-x64` with Inno Setup 6:

```
ISCC.exe /DAppVersion=0.1.0 installer\windows\worldfoundry.iss
```

The GitHub workflows (`.github/workflows/ci.yml` and `release.yml`) check every push (typecheck, tests, build, package build, and on Ubuntu additionally a real installation with `install.sh`) and, on a tag `v<version>`, produce all three packages including the installer and create a GitHub release. The tag must match the version in `packages/backend/package.json`. The signing of releases is described in [UPDATES.md](UPDATES.md#how-the-owner-publishes-an-update).
