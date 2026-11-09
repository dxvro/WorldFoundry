import { copyFile, cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIRS, CONFIG_FILES, DEFAULT_LEVEL } from '../backups/world.js';
import { AppError } from '../http/errors.js';
import { renameWithRetry } from '../lib/fs-retry.js';
import { decodeProperties, PropertiesDocument } from '../properties/parser.js';
import { EXPORT_MANIFEST_NAME } from './manifest.js';
import { child, parseNbtFile, writeNbtGzip, nbt } from './nbt.js';
import type { LevelInfo } from './level-dat.js';

export type SourceKind = 'cm-export' | 'server' | 'world';
// inside: DIM-1 and DIM1 below the world folder (singleplayer, vanilla, Fabric, Forge);
// split: <level>_nether/DIM-1 and <level>_the_end/DIM1 next to it (Bukkit, Spigot, Paper);
// unified: the newer format with a dimensions/ folder, copied unchanged
export type DimensionLayout = 'inside' | 'split' | 'unified';

export interface StagedWorld {
  kind: SourceKind;
  // folder the entries of a server or export archive live in (the archive root, minus a single wrapper folder)
  root: string;
  worldName: string;
  worldDir: string;
  layout: DimensionLayout;
  // folders holding region/ etc. of the Nether and the End, wherever they are now
  netherSrc: string | null;
  endSrc: string | null;
  otherWorlds: string[];
  propertiesFile: string | null;
  levelNameFromProperties: string | null;
  manifestFile: string | null;
  configItems: string[];
  modDirs: { mods: string | null; plugins: string | null };
  paperHints: string[];
}

const JUNK = new Set(['__MACOSX', '.DS_Store', 'Thumbs.db', 'desktop.ini']);
const SESSION_LOCK = 'session.lock';
const MAX_WRAPPERS = 3;

const kindOf = (file: string): Promise<'file' | 'dir' | null> =>
  lstat(file).then(
    (info) => (info.isDirectory() ? 'dir' : info.isFile() ? 'file' : null),
    () => null,
  );

async function entries(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => !JUNK.has(name));
}

async function removeJunk(dir: string): Promise<void> {
  for (const name of await readdir(dir)) if (JUNK.has(name)) await rm(path.join(dir, name), { recursive: true, force: true });
}

const PAPER_FILES = ['paper.yml', 'paper-global.yml', 'spigot.yml', 'bukkit.yml', 'purpur.yml'];

// Finds the world in an extracted archive and says where its parts are. Throws a readable error if there is none.
export async function detectStagedWorld(stageRoot: string): Promise<StagedWorld> {
  await removeJunk(stageRoot);
  let root = stageRoot;
  for (let depth = 0; depth < MAX_WRAPPERS; depth++) {
    const names = await entries(root);
    const decisive = ['level.dat', 'server.properties', EXPORT_MANIFEST_NAME];
    if (names.length !== 1 || decisive.includes(names[0] ?? '')) break;
    const only = path.join(root, names[0] ?? '');
    if ((await kindOf(only)) !== 'dir') break;
    root = only;
    await removeJunk(root);
  }

  // Bedrock saves have a db/ folder and no level.dat in Java format
  if ((await kindOf(path.join(root, 'db'))) === 'dir' && (await kindOf(path.join(root, 'levelname.txt'))) === 'file') {
    throw new AppError(422, 'IMPORT_BEDROCK', 'The archive contains a Bedrock world. WorldFoundry only supports Java Edition worlds.');
  }

  const names = await entries(root);
  const manifestFile = names.includes(EXPORT_MANIFEST_NAME) ? path.join(root, EXPORT_MANIFEST_NAME) : null;
  const propertiesFile = names.includes('server.properties') ? path.join(root, 'server.properties') : null;
  let levelFromProps: string | null = null;
  if (propertiesFile !== null) {
    try {
      const { text, encoding } = decodeProperties(await readFile(propertiesFile));
      const value = PropertiesDocument.parse(text, encoding).get('level-name');
      levelFromProps = value === undefined || value.trim() === '' ? null : value.trim();
    } catch {
      levelFromProps = null;
    }
  }

  let kind: SourceKind;
  let worldDir: string;
  let worldName: string;
  let others: string[] = [];
  if (names.includes('level.dat') && (await kindOf(path.join(root, 'level.dat'))) === 'file') {
    kind = 'world';
    worldDir = root;
    worldName = root === stageRoot ? DEFAULT_LEVEL : path.basename(root);
  } else {
    kind = manifestFile !== null ? 'cm-export' : 'server';
    const candidates: string[] = [];
    for (const name of names) {
      if ((await kindOf(path.join(root, name))) === 'dir' && (await kindOf(path.join(root, name, 'level.dat'))) === 'file') candidates.push(name);
    }
    if (candidates.length === 0) {
      throw new AppError(
        422,
        'IMPORT_NO_WORLD',
        'No Minecraft world was found in the archive (no level.dat file). Expected is a packed world folder, a server folder with a world or a WorldFoundry export.',
      );
    }
    // a Paper nether/end copy has its own level.dat; the main world is the one that is nobody's sibling
    const mains = candidates.filter((name) => !/_(nether|the_end)$/.test(name) || !candidates.includes(name.replace(/_(nether|the_end)$/, '')));
    const pick =
      (levelFromProps !== null && mains.includes(levelFromProps) ? levelFromProps : null) ??
      (mains.includes(DEFAULT_LEVEL) ? DEFAULT_LEVEL : null) ??
      [...mains].sort()[0] ??
      candidates[0] ??
      DEFAULT_LEVEL;
    worldName = pick;
    worldDir = path.join(root, pick);
    others = mains.filter((name) => name !== pick);
  }

  const parent = path.dirname(worldDir);
  const unified = (await kindOf(path.join(worldDir, 'dimensions'))) === 'dir';
  const insideNether = path.join(worldDir, 'DIM-1');
  const insideEnd = path.join(worldDir, 'DIM1');
  const splitNether = path.join(parent, `${worldName}_nether`, 'DIM-1');
  const splitEnd = path.join(parent, `${worldName}_the_end`, 'DIM1');
  const has = async (dir: string): Promise<boolean> => (await kindOf(dir)) === 'dir';
  let layout: DimensionLayout = 'inside';
  let netherSrc: string | null = null;
  let endSrc: string | null = null;
  if (unified) {
    layout = 'unified';
  } else if ((await has(insideNether)) || (await has(insideEnd))) {
    netherSrc = (await has(insideNether)) ? insideNether : null;
    endSrc = (await has(insideEnd)) ? insideEnd : null;
  } else if (kind !== 'world' && ((await has(splitNether)) || (await has(splitEnd)))) {
    layout = 'split';
    netherSrc = (await has(splitNether)) ? splitNether : null;
    endSrc = (await has(splitEnd)) ? splitEnd : null;
  }

  const configItems: string[] = [];
  if (kind !== 'world') {
    for (const name of CONFIG_FILES) if ((await kindOf(path.join(root, name))) === 'file') configItems.push(name);
    for (const name of CONFIG_DIRS) if ((await kindOf(path.join(root, name))) === 'dir') configItems.push(name);
  }
  const paperHints: string[] = [];
  if (layout === 'split') paperHints.push('Nether and End are in separate folders (Bukkit/Paper layout)');
  for (const file of PAPER_FILES) {
    if (kind !== 'world' && ((await kindOf(path.join(root, file))) === 'file' || (await kindOf(path.join(root, 'config', file))) === 'file')) paperHints.push(file);
  }
  const dirIfAny = async (name: string): Promise<string | null> => (kind !== 'world' && (await kindOf(path.join(root, name))) === 'dir' ? path.join(root, name) : null);
  return {
    kind,
    root,
    worldName,
    worldDir,
    layout,
    netherSrc,
    endSrc,
    otherWorlds: others,
    propertiesFile,
    levelNameFromProperties: levelFromProps,
    manifestFile,
    configItems,
    modDirs: { mods: await dirIfAny('mods'), plugins: await dirIfAny('plugins') },
    paperHints,
  };
}

export type TargetStyle = 'inside' | 'split';

export const styleForLoader = (loader: string): TargetStyle => (loader === 'paper' ? 'split' : 'inside');

export interface BuiltOutput {
  // names created in outDir: the world folders in the layout the target loader expects
  folders: string[];
  converted: boolean;
  playerDataFor: string | null;
}

// Moves the world apart into the folders the target expects. Only renames inside the staging volume plus
// one small copy of level.dat, so it is quick and leaves nothing half done when it fails: outDir is removed by the caller.
export async function buildOutput(world: StagedWorld, style: TargetStyle, level: string, outDir: string): Promise<BuiltOutput> {
  await mkdir(outDir, { recursive: true });
  const main = path.join(outDir, level);
  const nether = world.netherSrc;
  const end = world.endSrc;
  // detach the dimension folders from their old place first, so the world folder can be moved as a whole
  const holding = path.join(outDir, '.dims');
  const heldNether = nether === null ? null : path.join(holding, 'DIM-1');
  const heldEnd = end === null ? null : path.join(holding, 'DIM1');
  if (nether !== null || end !== null) await mkdir(holding, { recursive: true });
  if (nether !== null && heldNether !== null) await renameWithRetry(nether, heldNether);
  if (end !== null && heldEnd !== null) await renameWithRetry(end, heldEnd);

  await renameWithRetry(world.worldDir, main);
  await rm(path.join(main, SESSION_LOCK), { force: true });
  const folders = [level];
  const targetLayout: DimensionLayout = world.layout === 'unified' ? 'unified' : style;

  if (targetLayout === 'inside') {
    if (heldNether !== null) await renameWithRetry(heldNether, path.join(main, 'DIM-1'));
    if (heldEnd !== null) await renameWithRetry(heldEnd, path.join(main, 'DIM1'));
  } else if (targetLayout === 'split') {
    const pairs: Array<[string | null, string, string]> = [
      [heldNether, `${level}_nether`, 'DIM-1'],
      [heldEnd, `${level}_the_end`, 'DIM1'],
    ];
    for (const [held, folder, dimension] of pairs) {
      if (held === null) continue;
      const target = path.join(outDir, folder);
      await mkdir(target, { recursive: true });
      await renameWithRetry(held, path.join(target, dimension));
      // Bukkit keeps a copy of the level data (seed and settings) in every world folder
      await copyFile(path.join(main, 'level.dat'), path.join(target, 'level.dat')).catch(() => undefined);
      folders.push(folder);
    }
  }
  await rm(holding, { recursive: true, force: true });
  const converted = world.layout !== 'unified' && world.layout !== style && (nether !== null || end !== null);
  return { folders, converted, playerDataFor: null };
}

// A singleplayer save keeps the owner's inventory in level.dat (Data.Player); a dedicated server only reads
// playerdata/<uuid>.dat. Copies the tag over unless the world already has that file. Returns the UUID written.
export async function convertSingleplayerPlayer(worldFolder: string, info: Pick<LevelInfo, 'playerUuid'>): Promise<string | null> {
  if (info.playerUuid === null) return null;
  const target = path.join(worldFolder, 'playerdata', `${info.playerUuid}.dat`);
  if ((await kindOf(target)) !== null) return null;
  const parsed = parseNbtFile(await readFile(path.join(worldFolder, 'level.dat')));
  const player = child(parsed.root, 'Data', 'Player');
  if (player?.type !== 'compound') return null;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, writeNbtGzip(nbt.compound(Object.fromEntries(player.value))));
  return info.playerUuid;
}

// Rename, and where that is impossible (another volume) copy and delete.
export async function moveDir(from: string, to: string): Promise<void> {
  try {
    await renameWithRetry(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    try {
      await cp(from, to, { recursive: true, errorOnExist: true, force: false });
    } catch (copyError) {
      await rm(to, { recursive: true, force: true }).catch(() => undefined);
      throw copyError;
    }
    await rm(from, { recursive: true, force: true });
  }
}
