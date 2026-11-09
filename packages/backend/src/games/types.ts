import type { MessageRef } from '../messages.js';

// Every game WorldFoundry knows. A game with availability 'planned' is listed with its disclaimer and facts, but no
// server can be created for it yet.
export const GAME_IDS = ['minecraft', 'zomboid', 'satisfactory', 'ark'] as const;
export type GameId = (typeof GAME_IDS)[number];

export type GameAvailability = 'available' | 'planned';
export type HostPlatform = 'win32' | 'linux';

// Where a game takes its mods from. `requiresKey` means the user has to enter an own API key for that source:
// WorldFoundry is open source and never ships one.
export interface ModSourceInfo {
  id: string;
  name: string;
  url: string;
  requiresKey: boolean;
  // what works without a key, when `requiresKey` only limits the source instead of blocking it
  note?: string;
}

export interface GamePort {
  purpose: string;
  port: number;
  protocol: 'tcp' | 'udp' | 'tcp+udp';
}

// The static facts of a game: what the interface shows before a server exists, and what the legal pages print.
export interface GameDefinition {
  id: GameId;
  name: string;
  availability: GameAvailability;
  // owners of the game and its trademarks, as named in the disclaimer
  rightsHolders: string[];
  // The sentence shown wherever the game appears. WorldFoundry is not a product of any of the rights holders.
  disclaimer: string;
  // the license or EULA a user accepts for the server software, and who accepts it (always the user, never WorldFoundry)
  eula: { name: string; url: string } | null;
  // how the server files get onto the machine; WorldFoundry never ships game files
  delivery: { kind: 'vendor-download' } | { kind: 'steamcmd'; appId: number; anonymous: boolean };
  platforms: HostPlatform[];
  ports: GamePort[];
  modSources: ModSourceInfo[];
}

// ---- The adapter: everything the core needs from a game ----
//
// The core owns what is the same for every game: the process (spawn, console, metrics, clean stop), ports, locks,
// backups and their schedule, archives, import/export, the event bus and the HTTP API. A game adapter supplies the
// parts that differ. The Minecraft code predates this interface and is moved behind it step by step; a new game is
// written against it from the start.

export interface ServerRef {
  id: string;
  // absolute folder of this server: <serversDir>/<id>
  dir: string;
  // game-specific settings of the server (version, branch, memory, ...), validated by the adapter
  settings: Record<string, unknown>;
}

export interface InstallProgress {
  phase: string;
  percent: number | null;
  message: string;
  messageRef?: MessageRef;
}

export interface LaunchPlan {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface ConfigFile {
  // path relative to the server folder
  path: string;
  label: string;
  format: 'properties' | 'ini' | 'lua' | 'json' | 'text';
}

export interface GameAdapter {
  readonly definition: GameDefinition;

  // Check and normalise the game-specific part of a create or update request; throws AppError for invalid input.
  parseSettings(input: unknown): Promise<Record<string, unknown>>;

  // Put the server files into `server.dir` (download or SteamCMD) and report progress. Runs under the server lock.
  install(server: ServerRef, report: (progress: InstallProgress) => void, signal: AbortSignal): Promise<void>;

  // The process to start. The core spawns it without a shell.
  launch(server: ServerRef): Promise<LaunchPlan>;

  // True for the output line that means "players can join now".
  isReady(line: string): boolean;

  // The console line that asks the server to save and exit; null when the game has none and the process gets a signal.
  stopCommand(): string | null;

  // Files and folders, relative to the server folder, that make up the world. A backup contains exactly these.
  worldPaths(server: ServerRef): Promise<string[]>;

  // Files and folders that hold the configuration, offered as an optional part of a backup or export.
  configPaths(server: ServerRef): Promise<string[]>;

  // The configuration files the interface offers an editor for.
  configFiles(server: ServerRef): Promise<ConfigFile[]>;

  // Whether a backup may run while the server is up. Games without a safe "pause saving" command return false,
  // and the core then stops the server for the backup.
  readonly supportsLiveBackup: boolean;
}
