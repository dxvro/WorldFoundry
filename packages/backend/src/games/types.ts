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
}

export type StartPlan =
  | { kind: 'prepare'; task: PreparationTask; port: number; notes: Msg[] }
  | { kind: 'launch'; plan: LaunchPlan };

export interface GameAdapter {
  readonly definition: GameDefinition;

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
  // The console line that saves and exits; null when the game has none and the process gets a signal
  readonly stopCommand: string | null;
}
