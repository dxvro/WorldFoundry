import type { BackupLayout } from '../backups/world.js';
import type { Server } from '../db/schema.js';
import type { AppError } from '../http/errors.js';
import type { Msg, Text } from '../messages.js';
import type { LineEvent } from '../process/patterns.js';

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
  // true while the source is being built: listed, but not usable in the interface yet
  inProgress?: boolean;
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
  // one line on what the game is, shown where a game is chosen; written by WorldFoundry, not the publisher's text
  summary: string;
  // rough size of the server files after installation and the memory a small server should get, to plan the machine
  diskGb: number;
  ramGb: number;
}

// ---- The adapter: everything the core needs from a game ----
//
// The core owns what is the same for every game: the install queue, its state and log, the process (spawn, console,
// metrics, clean stop), ports, locks and the HTTP API. A game adapter supplies what differs. Backups, import/export,
// player lists and mods are still Minecraft code paths; they move behind this interface when a second game needs them.


export type { LineEvent };

export interface InstallContext {
  dir: string;
  signal: AbortSignal;
  // one line of install.log
  log: (line: string) => void;
  // live progress for the interface
  progress: (phase: string, percent: number | null, message: Text) => void;
}

// Work that has to finish before the process can be started (Minecraft: a missing Java runtime is downloaded).
// It runs in the background without the server lock; the core then asks for the start plan again.
export interface PreparationTask {
  // the Java major for the Java runtime list ("in use by"), null for other kinds of preparation
  javaMajor: number | null;
  // console line when the preparation begins, and status text while it runs
  notice: Msg;
  status: (percent: number | null) => Msg;
  run: (signal: AbortSignal, onProgress: (step: { phase: string; percent: number | null; text: Text }) => void) => Promise<void>;
  done: Msg;
  cancelled: Msg;
  failed: Msg;
  // when the start plan asks for the same preparation again right after it succeeded
  stillMissing: () => AppError;
}

export interface LaunchPlan {
  command: string;
  args: string[];
  port: number;
  // the first console line of the run
  startLine: Msg;
  // console notes shown after it, and returned as warnings of the start request
  notes: Msg[];
  // runs after the port check, right before the process is spawned (Minecraft: eula.txt)
  beforeSpawn: () => Promise<void>;
  // remembered while the process runs, for the Java runtime list
  javaPath: string | null;
  // working folder of the process; the server folder when absent
  cwd?: string;
  // secrets in the command line that must never show up in the console
  redact?: string[];
  // extra environment variables (a separate home folder, so the save games of two servers stay apart)
  env?: Record<string, string>;
  // asked every few seconds while the server starts; true means players can join (for games whose log has no clear line)
  readiness?: () => Promise<boolean>;
}

export type StartPlan =
  | { kind: 'prepare'; task: PreparationTask; port: number; notes: Msg[] }
  | { kind: 'launch'; plan: LaunchPlan };

export interface GameAdapter {
  readonly definition: GameDefinition;

  // Columns of a new server row from the create request. Minecraft keeps its own create path (loader catalog) and has none.
  createColumns?(input: unknown, others: Server[]): Promise<Partial<Server>>;

  // First line of install.log
  installTitle(server: Server): string;
  // Checks before an installation is queued; throws AppError when it cannot work.
  validateInstall(server: Server, options: { checkJava: boolean }): Promise<void>;
  // Puts the server files into ctx.dir. Returns the columns of the server row that the installation sets.
  install(server: Server, ctx: InstallContext): Promise<Partial<Server>>;

  // Everything the start needs, or the preparation that has to run first. `resumed` is true right after a preparation.
  planStart(server: Server, dir: string, options: { resumed: boolean }): Promise<StartPlan>;
  // Readiness and players from one console line
  classifyLine(line: string): LineEvent | null;
  // The console line that saves and exits; null when the game has none and the process gets `stopSignal`
  readonly stopCommand: string | null;
  // SIGTERM when absent; on Windows a signal ends the process at once
  readonly stopSignal?: NodeJS.Signals;

  // The folders a backup holds
  backupLayout(server: Server, dir: string): Promise<BackupLayout>;
  // Taking over a world from an uploaded file (worldio/game-world.ts); absent: the game has no world import of its own
  readonly worldImport?: WorldImportSupport;
  // Mods the user uploads as files (games/custom-mods.ts); absent: the game takes none
  readonly customMods?: CustomModSupport;

  // For games that read no console input (ARK: RCON): sends one command and returns the answer as lines
  sendCommand?(server: Server, dir: string, command: string): Promise<string[]>;
  // A clean stop through the game's own channel; when it fails the core falls back to stopCommand / stopSignal
  stop?(server: Server, dir: string): Promise<void>;
  // Asked every few seconds while the server is online, for games whose log does not show players
  playerList?(server: Server, dir: string): Promise<{ names: string[] | null; count: number | null }>;
  // What the Players tab offers for one player; the core sends the command
  readonly playerActions?: readonly PlayerAction[];
  // turns what the user typed into what the commands need (ARK: the Steam id of a player)
  resolvePlayer?(serverId: string, nameOrId: string): string;

  // Settings files the interface offers as text; none for Minecraft, which has its own editors
  configFiles?(server: Server, dir: string): ConfigFile[];
  // Checks a new text of a file before it is written; returns columns of the server row that change with it
  checkConfig?(server: Server, file: ConfigFile, text: string, others: Server[]): Promise<Partial<Server>>;
}

export interface ConfigFile {
  key: string;
  label: string;
  description: string;
  // absolute path
  file: string;
  // relative to the server folder, for display
  display: string;
  format: 'ini' | 'lua' | 'json' | 'text';
}

export interface PlayerAction {
  id: string;
  label: string;
  // asked again before the command is sent
  confirm: boolean;
  // the console command; `name` is already checked against `nameRule`
  command: (name: string) => string;
}

// ---- world import of a game other than Minecraft ----

export interface WorldImportContext {
  server: Server;
  // the server folder
  dir: string;
  layout: BackupLayout;
}

// A world laid out like a backup of this server: `worlds` and `configItems` are names directly in the output folder
export interface PreparedWorld {
  worlds: string[];
  configItems: string[];
  warnings: Msg[];
}

export interface WorldImportSupport {
  // an uploaded file that is a save game itself rather than an archive (a Satisfactory .sav)
  singleFile?: (fileName: string) => boolean;
  // a WorldFoundry export or backup of another server of this game: renames what carries that server's names
  adopt?: (out: string, sourceLevel: string, ctx: WorldImportContext) => Promise<void>;
  // a world in the game's own format, wherever it sits in the upload; moves it into `out`
  native: (staged: string, out: string, ctx: WorldImportContext) => Promise<PreparedWorld>;
  // after the world is in place; what the server row decides (ports) is written again
  after?: (ctx: WorldImportContext) => Promise<Msg[]>;
}

// ---- mods uploaded as a file (games/custom-mods.ts) ----

// A mod the user brought as a file: made by themselves, or from a site WorldFoundry does not search.
export interface CustomMod {
  id: string;
  name: string;
  // where it lives, relative to the server folder
  location: string;
  sizeBytes: number;
  // whether the game loads it (Zomboid: in Mods=, ARK: in ActiveMods); null when the game loads every mod it finds
  active: boolean | null;
}

export interface CustomModsView {
  supported: boolean;
  // what an upload may be, for the file picker
  accept: string;
  mods: CustomMod[];
}

// Per game: where uploaded mods go and how the game is told to load them. `staged` is the unpacked upload.
export interface CustomModSupport {
  accept: string;
  list(server: Server, dir: string): Promise<CustomMod[]>;
  install(server: Server, dir: string, staged: string): Promise<CustomMod[]>;
  remove(server: Server, dir: string, id: string): Promise<void>;
}
