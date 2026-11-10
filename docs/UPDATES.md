# WorldFoundry: Updates

> **WorldFoundry is not an official product of any game publisher.** The disclaimer of each game is in [TRADEMARKS.md](../TRADEMARKS.md).
> NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.

Installed clients update themselves when the owner publishes a new GitHub release. **Nothing is installed automatically:** WorldFoundry reports the new version with its release notes in a banner on every page, and the update runs only after an administrator has clicked **Update now** (Update now) in the interface and confirmed.

A shorter, user-oriented summary is in [INSTALL.md, section 6](INSTALL.md#6-updates). The settings mentioned here (`UPDATE_CHECK`, `UPDATE_REPO`, `UPDATE_CHANNEL`, `UPDATE_COUNTDOWN_SECONDS`) are listed in [CONFIGURATION.md](CONFIGURATION.md#configuration).

**Contents**

- [Procedure for administrators](#procedure-for-administrators)
- [Where it works](#where-it-works)
- [Chain of trust](#chain-of-trust-why-this-is-safe)
- [How the owner publishes an update](#how-the-owner-publishes-an-update)
- [API](#api)
- [Test packages (CI only)](#test-packages-ci-only)

## Procedure for administrators

1. WorldFoundry queries the releases of `dxvro/WorldFoundry` every 6 hours (randomly offset by about 10 %), shortly after start, and on demand ("Check now", check now, under **System**). Requests go only to `api.github.com`, `github.com` and the GitHub download servers (`release-assets.githubusercontent.com`, `objects.githubusercontent.com`); every redirect is checked individually. No personal data is sent (the user agent is `WorldFoundry/<version>`), and the repository is public, so no token is needed.
2. The banner shows the version and release notes (as text, with a few safe Markdown elements: headings, lists, **bold**, `code`, https links; never as HTML). Only strictly newer versions count; pre-releases and drafts are ignored, except with `UPDATE_CHANNEL=prerelease`.
3. **Update now** opens a confirmation: all running Minecraft servers will be stopped. The countdown can be chosen (default 60 s, `UPDATE_COUNTDOWN_SECONDS`).
4. The update downloads the package for the own system, verifies signature and checksum (the servers keep running meanwhile), warns the players with `say` messages in chat (at 60, 30, 10, 5, 4, 3, 2, 1 seconds), stops the servers with the normal stop logic (the world is saved), hands over to the update service, installs, checks whether the new version answers, and **restarts the servers that were running before**. Progress (download, verification, waiting for servers, installation, restart, result) is shown in the banner and under **System**; the history (version from/to, time, result) is there too. The update can be cancelled until the countdown ends.
5. During the update, starting, installing, deleting and changing servers is locked (`409 UPDATE_IN_PROGRESS`); stopping and console commands remain possible. A running server installation, a backup, a Java installation, a world export or a running world import prevents the update from starting. During the update, new world exports, uploads, imports and replacing a world are also rejected with `409 UPDATE_IN_PROGRESS`.
6. If the installation fails or the new version does not answer, the update service restores the previous version; the history names the reason, and the servers are started again. Before the update, a copy of the database is additionally placed in `<DATA_DIR>/updates/db-before-update.db` (a newer database cannot be rolled back by a rollback).

## Where it works

| Installation | Behavior |
| --- | --- |
| Windows installer (`…-setup.exe`) | full: update service `worldfoundry-updater` (LocalSystem) |
| Linux (`install.sh`) | full: `worldfoundry-update.path` and `worldfoundry-update.service` (root) |
| Portable ZIP, source, installations without an update service (from before the update feature) | only a notice with a link to the download page, no self-update; the interface explains why. An existing installation without an update service is raised to the new package once by hand, after that it works by itself. |

To turn it off: `UPDATE_CHECK=false` in the configuration file (no more requests, no banner, update locked). To turn off only the background check: the switch **Automatisch nach Updates suchen** (Check for updates automatically) under **System** (stored in the database). A different source: `UPDATE_REPO=owner/name`.

## Chain of trust (why this is safe)

A self-update is code execution from the network, so the following applies:

- **Signed releases:** `release.yml` signs `SHA256SUMS.txt` with Ed25519 (Node `crypto`, private key in the Actions secret `UPDATE_SIGNING_KEY`) and uploads `SHA256SUMS.txt.sig` as well. The public keys are in the source code (`packages/backend/src/update/keys.ts`). The client downloads package, checksums and signature, verifies **the signature first** (all bytes of `SHA256SUMS.txt`), then the SHA-256 of the package, and rejects any deviation. The package file name contains the version and is part of the signed checksums; an old signed version therefore cannot be passed off as a new one. Size and time limits apply, and temporary files are in `<DATA_DIR>/updates`.
- **Privilege separation:** The application runs without privileges (Windows: `NT SERVICE\worldfoundry`, Linux: user `worldfoundry`, `NoNewPrivileges`, `ProtectSystem=strict`) and cannot install itself. It can only **request** an update: it places the verified package and `request.json` (last, atomically) in the request folder (Linux `/var/lib/worldfoundry-update/request`, Windows `C:\ProgramData\WorldFoundry Update\request`). The status folder above it is written only by root or SYSTEM; the application may read it.
- **The privileged updater** (`tools/updater.mjs`, Node built-ins only) trusts nothing from the request folder: it copies the files **once** (no symlinks, size limit) into a folder the application cannot write to (no TOCTOU), verifies signature (with the keys of the *installed* version, `tools/update-keys.json`) and hash **again there**, derives file names and target system from the installation itself, demands a strictly newer version and compares the version inside the unpacked package. Then it backs up the previous version, installs, checks `/api/health` for the new version, and rolls back on errors.
- **Linux:** The root updater is started by systemd (`.path` unit) and runs in its own unit without a binding to `worldfoundry.service`; stopping the application does not end it. It unpacks the package and runs its `install.sh --upgrade`.
- **Windows:** The service `worldfoundry-updater` (LocalSystem) checks the request and starts the installation through a one-time Task Scheduler task (SYSTEM) with a *copy* of `node.exe` and `updater.mjs`, because the installer replaces the service and the program files. The setup runs silently (`/VERYSILENT /SUPPRESSMSGBOXES /NORESTART`); configuration, token, data, servers and the existing choice for firewall rules and Start menu are kept.

## How the owner publishes an update

1. Once: make the repository public. Generate a key pair: `node scripts/update-keygen.mjs --out private.pem`. Enter the printed public key in `packages/backend/src/update/keys.ts`, store the contents of `private.pem` as the Actions secret **`UPDATE_SIGNING_KEY`** (Settings > Secrets and variables > Actions) and keep the file safe, never put it in the repository. Without the secret, `release.yml` aborts.
2. Raise the version in `package.json`, `packages/backend/package.json` and `packages/frontend/package.json`, commit, set the tag `vX.Y.Z` and push. The workflow builds all packages, signs `SHA256SUMS.txt` and creates the release. The text of the release is shown to the administrators as release notes.
3. Key change (rotation): enter the new public key **in addition to** the old one in `keys.ts` and sign one more release with the old key. Once the installations have picked it up, sign with the new key and remove the old one later. A lost or exposed key can only be replaced by a manually installed package with a new key.
4. Pre-releases: tag `v1.2.0-rc.1` (marked as a pre-release); only installations with `UPDATE_CHANNEL=prerelease` see them.

Checking without network: `node scripts/sign-release.mjs --sums SHA256SUMS.txt --key-file private.pem` signs and rejects a key that is not in `keys.ts`.

## API

`GET /api/system/update` (state: `currentVersion`, `installMode` `service|portable|dev`, `latest` with release notes, `updateAvailable`, `canApply` with reason, `phase`, `progress`, `lastCheckAt`, `lastCheckError`, `history`), `POST /api/system/update/check`, `POST /api/system/update/apply` with `{ "confirm": true, "countdownSeconds"?: 0-600 }` (`422` without `confirm: true`), `POST …/cancel`, `POST …/dismiss`, `PATCH …/settings` with `{ "autoCheck": boolean }`. Changes arrive as the event `update.state` through `/api/events`. Like the rest of the API, all routes require a login. See also [API.md](API.md).

## Test packages (CI only)

`package.mjs --version-override X.Y.Z --test-update-api <URL> --test-update-key <file.pem>` builds a package with the marker `tools/update-test.json`. Only with it does the application honor `UPDATE_API_BASE` (also `http://`) and an additional test key; the file is in the program folder (only root or administrators can create it), and packages from `release.yml` do not contain it. In CI, `scripts/ci/update-e2e-linux.sh` (Ubuntu) and `scripts/ci/update-e2e-windows.ps1` (windows-latest) test the whole procedure with a fake GitHub (`scripts/ci/fake-github.mjs`) and a throwaway key, including a tampered package, a forged request and the rollback of a broken version.
