# Contributing to WorldFoundry

> **WorldFoundry is not an official product of any game publisher.** The disclaimer of each game is in [TRADEMARKS.md](TRADEMARKS.md).

Thank you for helping. WorldFoundry is a free, volunteer project under the GPL-3.0-only license. By contributing you agree that your contribution is licensed under the same license.

## Ways to help

- **Test a game against a real server.** Most games are only tested against simulated servers so far (see the status in the [README](README.md)). A report like "Valheim 0.220 on Ubuntu 24.04: install and start work, the player count stays 0" is very valuable.
- **Report bugs** with the [bug report form](https://github.com/dxvro/WorldFoundry/issues/new/choose).
- **Suggest a game or a feature** with the matching form.
- **Send a pull request** for a fix, a test, documentation or a new game adapter.

Security problems are never reported in public issues. See [SECURITY.md](SECURITY.md).

## Development setup

You need Node.js 22 or newer. The full guide is in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

```
npm install
npm run dev        # backend on port 3000, web interface on http://localhost:5173
npm run typecheck
npm test           # backend, frontend, scripts and the email check
```

Tests run without network, without Java and without real game servers: every game has a small fake server in `packages/backend/test/`.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep the change focused: one fix or feature per pull request.
3. Add or update tests. A bug fix comes with a test that fails without it.
4. Run `npm run typecheck` and `npm test`. Both must pass; CI runs them on Linux and Windows.
5. Update the documentation (`README.md`, `docs/`) when behavior or settings change.
6. Fill in the pull request template.

## Rules for the code and the repository

- **English only:** code, comments, commit messages, documentation and the interface texts.
- **No private email addresses.** Commits must use a no-reply address, for example your GitHub `…@users.noreply.github.com` address (GitHub: Settings → Emails → "Keep my email addresses private"). `npm test` and CI reject any other address in a file or a commit.
- **No game files, logos or artwork** of any game in the repository. Server files are always downloaded on the user's machine from the official source or with SteamCMD (anonymous login).
- **Never accept a license for the user.** For example, the Minecraft EULA is accepted by the user per server.
- **Disclaimers:** every game has its "Not an official … product" text in `packages/backend/src/games/registry.ts`, `README.md` and `TRADEMARKS.md`. A new game adds its text in all three places.
- **Free and open source only:** no paid services, no closed-source dependencies, no tracking.

## Adding a game

A game is an adapter behind the interface in [`packages/backend/src/games/types.ts`](packages/backend/src/games/types.ts). The adapter supplies installation, the start command, readiness detection, configuration files and mod sources; the core handles processes, console, ports, backups, import and export. Look at an existing adapter of a similar game (for example `games/valheim/` for a SteamCMD game) and its fake server in `packages/backend/test/`.

## Questions

Open an issue, or write to <worldfoundry0@gmail.com>.
