import { AppError } from '../http/errors.js';
import { GAME_IDS, type GameDefinition, type GameId } from './types.js';

const notA = (product: string, owners: string): string => `Not an official ${product} product. Not approved by or associated with ${owners}.`;

// The order is the order of the interface.
export const GAMES: readonly GameDefinition[] = [
  {
    id: 'minecraft',
    name: 'Minecraft: Java Edition',
    summary: 'Block-building sandbox. Java Edition server with Vanilla, Paper, Fabric, Forge or NeoForge.',
    diskGb: 1,
    ramGb: 4,
    availability: 'available',
    rightsHolders: ['Mojang AB', 'Microsoft Corporation'],
    disclaimer: notA('Minecraft', 'Mojang or Microsoft'),
    eula: { name: 'Minecraft End User License Agreement', url: 'https://aka.ms/MinecraftEULA' },
    delivery: { kind: 'vendor-download' },
    platforms: ['win32', 'linux'],
    ports: [{ purpose: 'Game', port: 25565, protocol: 'tcp' }],
    modSources: [
      { id: 'modrinth', name: 'Modrinth', url: 'https://modrinth.com', requiresKey: false },
      {
        id: 'curseforge',
        name: 'CurseForge',
        url: 'https://www.curseforge.com/minecraft',
        requiresKey: true,
        inProgress: true,
        note: 'In progress. Will need your own free CurseForge API key. Projects whose authors disallow third-party downloads can only be opened on the website.',
      },
    ],
  },
  {
    id: 'zomboid',
    name: 'Project Zomboid',
    summary: 'Open-world zombie survival for small groups, with Steam Workshop mods.',
    diskGb: 5,
    ramGb: 4,
    availability: 'available',
    rightsHolders: ['The Indie Stone'],
    disclaimer: notA('Project Zomboid', 'The Indie Stone'),
    eula: { name: 'Steam Subscriber Agreement', url: 'https://store.steampowered.com/subscriber_agreement/' },
    delivery: { kind: 'steamcmd', appId: 380870, anonymous: true },
    platforms: ['win32', 'linux'],
    ports: [
      { purpose: 'Game', port: 16261, protocol: 'udp' },
      { purpose: 'Direct connection', port: 16262, protocol: 'udp' },
    ],
    modSources: [
      {
        id: 'steam-workshop',
        name: 'Steam Workshop',
        url: 'https://steamcommunity.com/app/108600/workshop/',
        requiresKey: false,
        note: 'Adding by Workshop ID or link works without a key. Searching the Workshop needs your own Steam Web API key.',
      },
    ],
  },
  {
    id: 'satisfactory',
    name: 'Satisfactory',
    summary: 'Co-op factory building on an alien planet, with mods from ficsit.app.',
    diskGb: 9,
    ramGb: 12,
    availability: 'available',
    rightsHolders: ['Coffee Stain Studios AB', 'Coffee Stain Publishing AB'],
    disclaimer: notA('Satisfactory', 'Coffee Stain Studios or Coffee Stain Publishing'),
    eula: { name: 'Steam Subscriber Agreement', url: 'https://store.steampowered.com/subscriber_agreement/' },
    delivery: { kind: 'steamcmd', appId: 1690800, anonymous: true },
    platforms: ['win32', 'linux'],
    ports: [
      { purpose: 'Game', port: 7777, protocol: 'tcp+udp' },
      { purpose: 'Reliable messaging', port: 8888, protocol: 'tcp' },
    ],
    modSources: [{ id: 'ficsit', name: 'ficsit.app (Satisfactory Mod Repository)', url: 'https://ficsit.app', requiresKey: false }],
  },
  {
    id: 'ark',
    name: 'ARK: Survival Evolved',
    summary: 'Survival with dinosaurs on large maps, with Steam Workshop mods.',
    diskGb: 20,
    ramGb: 8,
    availability: 'available',
    rightsHolders: ['Studio Wildcard', 'Snail Games USA'],
    disclaimer: notA('ARK', 'Studio Wildcard or Snail Games'),
    eula: { name: 'Steam Subscriber Agreement', url: 'https://store.steampowered.com/subscriber_agreement/' },
    delivery: { kind: 'steamcmd', appId: 376030, anonymous: true },
    platforms: ['win32', 'linux'],
    ports: [
      { purpose: 'Game', port: 7777, protocol: 'udp' },
      { purpose: 'Raw socket', port: 7778, protocol: 'udp' },
      { purpose: 'Steam query', port: 27015, protocol: 'udp' },
    ],
    modSources: [
      {
        id: 'steam-workshop',
        name: 'Steam Workshop',
        url: 'https://steamcommunity.com/app/346110/workshop/',
        requiresKey: false,
        note: 'Adding by Workshop ID or link works without a key. Searching the Workshop needs your own Steam Web API key.',
      },
    ],
  },
];

const BY_ID = new Map<GameId, GameDefinition>(GAMES.map((game) => [game.id, game]));

export const isGameId = (value: unknown): value is GameId => (GAME_IDS as readonly unknown[]).includes(value);

export function gameDefinition(id: GameId): GameDefinition {
  const game = BY_ID.get(id);
  if (game === undefined) throw new AppError(404, 'GAME_NOT_FOUND', 'The game was not found.');
  return game;
}

// A server can only be created for a game whose adapter exists.
export function assertGameAvailable(id: GameId): GameDefinition {
  const game = gameDefinition(id);
  if (game.availability !== 'available') {
    throw new AppError(422, 'GAME_NOT_AVAILABLE', `Servers for ${game.name} cannot be created yet.`, undefined, { game: game.name });
  }
  return game;
}
