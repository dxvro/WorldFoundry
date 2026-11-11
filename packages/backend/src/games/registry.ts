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
  {
    id: 'asa',
    name: 'ARK: Survival Ascended',
    summary: 'The Unreal Engine 5 remake of ARK. Windows server; on Linux it runs through Proton.',
    diskGb: 14,
    ramGb: 16,
    availability: 'available',
    rightsHolders: ['Studio Wildcard', 'Snail Games USA'],
    disclaimer: notA('ARK: Survival Ascended', 'Studio Wildcard or Snail Games'),
    eula: { name: 'Steam Subscriber Agreement', url: 'https://store.steampowered.com/subscriber_agreement/' },
    delivery: { kind: 'steamcmd', appId: 2430930, anonymous: true },
    platforms: ['win32', 'linux'],
    ports: [
      { purpose: 'Game', port: 7777, protocol: 'udp' },
      { purpose: 'RCON', port: 27020, protocol: 'tcp' },
    ],
    modSources: [
      {
        id: 'curseforge',
        name: 'CurseForge',
        url: 'https://www.curseforge.com/ark-survival-ascended',
        requiresKey: false,
        note: 'Add mods by their CurseForge project id; the server downloads them itself when it starts.',
      },
    ],
  },
  {
    id: 'valheim',
    name: 'Valheim',
    summary: 'Viking survival and building in a procedural world for up to 10 players.',
    diskGb: 2,
    ramGb: 4,
    availability: 'available',
    rightsHolders: ['Iron Gate AB', 'Coffee Stain Publishing AB'],
    disclaimer: notA('Valheim', 'Iron Gate or Coffee Stain Publishing'),
    eula: { name: 'Steam Subscriber Agreement', url: 'https://store.steampowered.com/subscriber_agreement/' },
    delivery: { kind: 'steamcmd', appId: 896660, anonymous: true },
    platforms: ['win32', 'linux'],
    ports: [
      { purpose: 'Game', port: 2456, protocol: 'udp' },
      { purpose: 'Steam query', port: 2457, protocol: 'udp' },
    ],
    modSources: [
      {
        id: 'thunderstore',
        name: 'Thunderstore (BepInEx)',
        url: 'https://thunderstore.io/c/valheim/',
        requiresKey: false,
        inProgress: true,
        note: 'In progress. Server mods need the BepInEx mod loader, which WorldFoundry does not set up yet.',
      },
    ],
  },
  {
    id: 'sevendays',
    name: '7 Days to Die',
    summary: 'Zombie survival with crafting and base building; every seventh night a horde attacks.',
    diskGb: 18,
    ramGb: 8,
    availability: 'available',
    rightsHolders: ['The Fun Pimps Entertainment LLC'],
    disclaimer: notA('7 Days to Die', 'The Fun Pimps'),
    eula: { name: 'Steam Subscriber Agreement', url: 'https://store.steampowered.com/subscriber_agreement/' },
    delivery: { kind: 'steamcmd', appId: 294420, anonymous: true },
    platforms: ['win32', 'linux'],
    ports: [
      { purpose: 'Game', port: 26900, protocol: 'tcp+udp' },
      { purpose: 'Game', port: 26901, protocol: 'udp' },
      { purpose: 'Game', port: 26902, protocol: 'udp' },
    ],
    modSources: [{ id: 'upload', name: 'Own mods (Mods folder)', url: 'https://7daystodie.com', requiresKey: false, note: 'Server-side mods are uploaded as .zip with their ModInfo.xml.' }],
  },
  {
    id: 'palworld',
    name: 'Palworld',
    summary: 'Open-world survival with creatures that fight, build and work for you.',
    diskGb: 5,
    ramGb: 16,
    availability: 'available',
    rightsHolders: ['Pocketpair, Inc.'],
    disclaimer: notA('Palworld', 'Pocketpair'),
    eula: { name: 'Steam Subscriber Agreement', url: 'https://store.steampowered.com/subscriber_agreement/' },
    delivery: { kind: 'steamcmd', appId: 2394010, anonymous: true },
    platforms: ['win32', 'linux'],
    ports: [
      { purpose: 'Game', port: 8211, protocol: 'udp' },
      { purpose: 'Steam query', port: 27015, protocol: 'udp' },
    ],
    modSources: [{ id: 'upload', name: 'Own mods (.pak)', url: 'https://www.pocketpair.jp/palworld', requiresKey: false, note: 'Pak mods are uploaded as .zip and go into Pal/Content/Paks/~mods.' }],
  },
  {
    id: 'terraria',
    name: 'Terraria',
    summary: '2D sandbox of digging, building and boss fights, with the dedicated server from terraria.org.',
    diskGb: 1,
    ramGb: 2,
    availability: 'available',
    rightsHolders: ['Re-Logic'],
    disclaimer: notA('Terraria', 'Re-Logic'),
    eula: { name: 'Terraria dedicated server (terraria.org)', url: 'https://terraria.org' },
    delivery: { kind: 'vendor-download' },
    platforms: ['win32', 'linux'],
    ports: [{ purpose: 'Game', port: 7777, protocol: 'tcp' }],
    modSources: [
      {
        id: 'tmodloader',
        name: 'tModLoader',
        url: 'https://www.tmodloader.net',
        requiresKey: false,
        inProgress: true,
        note: 'In progress. The official server runs without mods; modded servers need tModLoader, which WorldFoundry does not set up yet.',
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
