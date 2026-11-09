# WorldFoundry

> **WorldFoundry is an independent, free and open-source project. It is not an official product of any game publisher and is not approved by or associated with Mojang, Microsoft, The Indie Stone, Coffee Stain, Studio Wildcard, Snail Games or Valve.** The disclaimer of each game is in [TRADEMARKS.md](TRADEMARKS.md).

WorldFoundry runs dedicated game servers on one of your own computers and is operated in the browser, from a PC, tablet or phone on your network. Creating, starting, monitoring, backing up, importing and exporting servers works without a command line.

**Status: early development.** No release has been published yet. Minecraft works; the other games are being built. To try WorldFoundry, run it from source (see below).

## Games

| Game | Status | Server files | Mods |
| --- | --- | --- | --- |
| Minecraft: Java Edition | Works | Downloaded from the official source of the loader (Vanilla, Fabric, Paper, NeoForge, Forge) | Modrinth; CurseForge planned (needs your own API key) |
| Project Zomboid | Planned | SteamCMD, anonymous login | Steam Workshop |
| Satisfactory | Planned | SteamCMD, anonymous login | ficsit.app |
| ARK: Survival Evolved | Planned | SteamCMD, anonymous login | Steam Workshop |

- **Minecraft:** NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.
- **Project Zomboid:** Not an official Project Zomboid product. Not approved by or associated with The Indie Stone.
- **Satisfactory:** Not an official Satisfactory product. Not approved by or associated with Coffee Stain Studios or Coffee Stain Publishing.
- **ARK:** Not an official ARK product. Not approved by or associated with Studio Wildcard or Snail Games.

WorldFoundry ships no game files, logos or artwork. Every server is downloaded on your machine at installation, and you accept the license of each game yourself. WorldFoundry never accepts one for you.

## What it does today

- **Several servers** side by side, grouped by game
- **Live console** with command input and history
- **Mods and plugins** from Modrinth: install, enable and disable, update, with dependencies
- **Players:** whitelist, operators and ban lists
- **World settings:** all values of `server.properties` in an editor
- **Backups** by hand or on a schedule, with restore
- **Import and export** of worlds, with or without mods
- **Automatic Java installation** when the matching version is missing (Eclipse Temurin)
- **Autostart** of individual servers

## How it works

WorldFoundry is one program with a web interface. It runs on the computer that hosts the servers; you open `http://<IP address>:3000` from any device on your network and sign in with the password. Servers, worlds and data stay on that computer. Game servers run as ordinary processes of that computer, without containers.

> **Security notice:** The web interface can start programs and is unencrypted (HTTP). Run it only on a home network or another trusted network, and never expose the web port to the internet.

## Running from source

Needs Node.js 22 or newer.

```
git clone https://github.com/dxvro/WorldFoundry.git
cd WorldFoundry
npm install
npm run build
npm start
```

Then open `http://localhost:3000`. On the first start WorldFoundry creates a password, prints it once in the terminal and writes it to `initial-password.txt` in the data folder (`data/` in the checkout). Sign in with it and set your own under **System > Password**; the file is deleted then. If you set `AUTH_TOKEN` in a `.env` file (see [.env.example](.env.example)), that token is the first sign-in instead and no password is created.

## Documentation

The pages below were written for the Minecraft part and are being extended as games are added.

- [docs/USAGE.md](docs/USAGE.md): the web interface, creating and starting servers, loaders, Java
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): environment variables, network access, password, security
- [docs/API.md](docs/API.md): HTTP API, backups, world import and export, WebSockets
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): running from source, tests and building packages
- [docs/INSTALL.md](docs/INSTALL.md) and [docs/UPDATES.md](docs/UPDATES.md): the installation packages and self-update. These describe packages that are not published yet.

## Adding a game

A game is an adapter behind one interface, [`packages/backend/src/games/types.ts`](packages/backend/src/games/types.ts). The core owns what is the same for every game (process, console, ports, backups, import and export, sign-in); the adapter supplies installation, the start command, readiness detection, configuration files and mod sources. The facts and the disclaimer of each game are in [`packages/backend/src/games/registry.ts`](packages/backend/src/games/registry.ts).

## License

WorldFoundry is free software, licensed under the **GNU General Public License, version 3** (GPL-3.0-only). See [LICENSE](LICENSE) for the full text. It is free of charge and has no commercial offer.

## Contact

Contact: <worldfoundry0@gmail.com>, or the issue tracker of this repository. For security problems, please use the private reporting described in [SECURITY.md](SECURITY.md).

Contributors: commits must use a no-reply address (for example your GitHub `…@users.noreply.github.com` address). `npm test` and CI reject any other email address in a file or a commit.
