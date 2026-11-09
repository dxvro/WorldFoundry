import { AppError } from '../http/errors.js';
import { mcVersionFromDataVersion } from './data-versions.js';
import { asList, asNumber, asString, child, childInsensitive, parseNbtFile, type NbtCompound, type NbtTag } from './nbt.js';

export interface ForgeModEntry {
  id: string;
  version: string | null;
}

export interface LevelInfo {
  levelName: string | null;
  // "1.20.1" from Data.Version.Name; null for worlds saved before 1.9 or without the tag
  versionName: string | null;
  versionId: number | null;
  dataVersion: number | null;
  snapshot: boolean | null;
  // the best statement about the Minecraft version: the name if present, else guessed from the DataVersion
  mcVersion: string | null;
  mcVersionApprox: boolean;
  // no Version tag and no DataVersion: saved by Minecraft before 1.9 (or by a tool that dropped them)
  preOneNine: boolean;
  gameType: number | null;
  hardcore: boolean | null;
  lastPlayed: number | null;
  serverBrands: string[];
  wasModded: boolean | null;
  // an FML/fml section exists (Forge and NeoForge store their mod list there)
  fml: boolean;
  forgeMods: ForgeModEntry[];
  forgeVersion: string | null;
  neoforgeVersion: string | null;
  // UUID of the singleplayer player stored in Data.Player, as a dashed string
  playerUuid: string | null;
}

const BUILT_IN = new Set(['minecraft', 'mcp', 'fml', 'forge', 'neoforge']);

function modEntries(fml: NbtTag | undefined): ForgeModEntry[] {
  const found = new Map<string, ForgeModEntry>();
  const consider = (tag: NbtTag | undefined): void => {
    for (const entry of asList(tag)) {
      if (entry.type !== 'compound') continue;
      const id = asString(childInsensitive(entry, 'ModId')) ?? asString(childInsensitive(entry, 'modid'));
      if (id === null || id === '') continue;
      const version = asString(childInsensitive(entry, 'ModVersion')) ?? asString(childInsensitive(entry, 'version'));
      if (!found.has(id.toLowerCase())) found.set(id.toLowerCase(), { id, version });
    }
  };
  consider(childInsensitive(fml, 'ModList'));
  consider(childInsensitive(fml, 'loadingModList'));
  return [...found.values()];
}

function uuidFrom(player: NbtTag | undefined): string | null {
  const modern = child(player, 'UUID');
  let hex: string | null = null;
  if (modern?.type === 'intArray' && modern.value.length === 4) {
    hex = modern.value.map((part) => (part >>> 0).toString(16).padStart(8, '0')).join('');
  } else {
    const most = child(player, 'UUIDMost');
    const least = child(player, 'UUIDLeast');
    if (most?.type === 'long' && least?.type === 'long') {
      hex = BigInt.asUintN(64, most.value).toString(16).padStart(16, '0') + BigInt.asUintN(64, least.value).toString(16).padStart(16, '0');
    }
  }
  return hex === null ? null : `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function levelInfoFromNbt(root: NbtCompound): LevelInfo {
  const data = child(root, 'Data');
  if (data?.type !== 'compound') {
    throw new AppError(422, 'LEVEL_DAT_INVALID', 'The level.dat file is not a valid Java Edition world (the "Data" section is missing).');
  }
  const versionName = asString(child(data, 'Version', 'Name'));
  const versionId = asNumber(child(data, 'Version', 'Id'));
  const dataVersion = asNumber(child(data, 'DataVersion'));
  const snapshotFlag = asNumber(child(data, 'Version', 'Snapshot'));
  let mcVersion = versionName;
  let mcVersionApprox = false;
  if (mcVersion === null && dataVersion !== null) {
    const guess = mcVersionFromDataVersion(dataVersion);
    if (guess !== null) {
      mcVersion = guess.version;
      mcVersionApprox = guess.approximate;
    }
  }
  const fmlTag = childInsensitive(root, 'fml') ?? childInsensitive(data, 'fml');
  const entries = modEntries(fmlTag);
  const versionOf = (id: string): string | null => entries.find((entry) => entry.id.toLowerCase() === id)?.version ?? null;
  const brands = asList(child(data, 'ServerBrands'))
    .map((tag) => asString(tag))
    .filter((brand): brand is string => brand !== null);
  const wasModded = asNumber(child(data, 'WasModded'));
  const hardcore = asNumber(child(data, 'hardcore'));
  const lastPlayed = asNumber(child(data, 'LastPlayed'));
  return {
    levelName: asString(child(data, 'LevelName')),
    versionName,
    versionId,
    dataVersion,
    snapshot: snapshotFlag === null ? null : snapshotFlag !== 0,
    mcVersion,
    mcVersionApprox,
    preOneNine: versionName === null && dataVersion === null,
    gameType: asNumber(child(data, 'GameType')),
    hardcore: hardcore === null ? null : hardcore !== 0,
    lastPlayed,
    serverBrands: brands,
    wasModded: wasModded === null ? null : wasModded !== 0,
    fml: fmlTag !== undefined,
    forgeMods: entries.filter((entry) => !BUILT_IN.has(entry.id.toLowerCase())),
    forgeVersion: versionOf('forge'),
    neoforgeVersion: versionOf('neoforge'),
    playerUuid: uuidFrom(child(data, 'Player')),
  };
}

// level.dat as it lies on disk: gzipped NBT
export function parseLevelDat(file: Buffer): LevelInfo {
  let parsed;
  try {
    parsed = parseNbtFile(file);
  } catch (error) {
    if (error instanceof AppError) {
      throw new AppError(422, 'LEVEL_DAT_INVALID', 'The level.dat file is corrupt or not a Minecraft Java Edition world. Bedrock worlds are not supported.');
    }
    throw error;
  }
  return levelInfoFromNbt(parsed.root);
}

export const GAME_TYPE_LABEL: Record<number, string> = { 0: 'Survival', 1: 'Creative', 2: 'Adventure', 3: 'Spectator' };
