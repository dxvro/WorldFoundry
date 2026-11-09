import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nbt, writeNbtGzip, type NbtTag } from '../src/worldio/nbt.js';
import { buildZip, type ZipEntry } from './archive-builders.js';

export interface LevelOptions {
  name?: string;
  versionName?: string | null;
  versionId?: number;
  dataVersion?: number | null;
  snapshot?: boolean;
  gameType?: number;
  hardcore?: boolean;
  brands?: string[];
  wasModded?: boolean;
  playerUuid?: string;
  // Forge 1.13+: fml.loadingModList; 1.12: FML.ModList
  fml?: { style: 'modern' | 'legacy'; mods: Array<{ id: string; version: string }> };
}

const uuidInts = (uuid: string): number[] => {
  const hex = uuid.replaceAll('-', '');
  return [0, 8, 16, 24].map((at) => Number(BigInt.asIntN(32, BigInt(`0x${hex.slice(at, at + 8)}`))));
};

// A level.dat in the real on-disk format: gzipped, big-endian NBT with the structure Minecraft writes
export function levelDat(options: LevelOptions = {}): Buffer {
  const data: Record<string, NbtTag> = {
    LevelName: nbt.string(options.name ?? 'My World'),
    GameType: nbt.int(options.gameType ?? 0),
    hardcore: nbt.byte(options.hardcore === true ? 1 : 0),
    LastPlayed: nbt.long(1_700_000_000_000n),
    version: nbt.int(19133),
    SpawnX: nbt.int(0),
    RandomSeed: nbt.long(123456789n),
  };
  if (options.dataVersion !== null) data['DataVersion'] = nbt.int(options.dataVersion ?? 3955);
  if (options.versionName !== null) {
    data['Version'] = nbt.compound({
      Id: nbt.int(options.versionId ?? 3955),
      Name: nbt.string(options.versionName ?? '1.21.1'),
      Series: nbt.string('main'),
      Snapshot: nbt.byte(options.snapshot === true ? 1 : 0),
    });
  }
  if (options.brands !== undefined) data['ServerBrands'] = nbt.list('string', options.brands.map((brand) => nbt.string(brand)));
  if (options.wasModded !== undefined) data['WasModded'] = nbt.byte(options.wasModded ? 1 : 0);
  if (options.playerUuid !== undefined) {
    data['Player'] = nbt.compound({
      UUID: nbt.intArray(uuidInts(options.playerUuid)),
      Health: nbt.float(20),
      Inventory: nbt.list('compound', [nbt.compound({ id: nbt.string('minecraft:diamond'), Count: nbt.byte(3), Slot: nbt.byte(0) })]),
    });
  }
  const root: Record<string, NbtTag> = { Data: nbt.compound(data) };
  if (options.fml !== undefined) {
    const entries = options.fml.mods.map((mod) =>
      nbt.compound({ ModId: nbt.string(mod.id), ModVersion: nbt.string(mod.version) }),
    );
    root[options.fml.style === 'legacy' ? 'FML' : 'fml'] = nbt.compound({
      [options.fml.style === 'legacy' ? 'ModList' : 'loadingModList']: nbt.list('compound', entries),
    });
  }
  return writeNbtGzip(nbt.compound(root));
}

export type DimensionShape = 'inside' | 'split' | 'none';

export interface WorldOptions extends LevelOptions {
  dims?: DimensionShape;
}

// Writes a world folder `name` below `parent`; for 'split' the Paper-style siblings are written as well
export async function writeWorld(parent: string, name: string, options: WorldOptions = {}): Promise<void> {
  const world = path.join(parent, name);
  const put = async (relative: string, content: Buffer | string): Promise<void> => {
    const file = path.join(parent, ...relative.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  await put(`${name}/level.dat`, levelDat(options));
  await put(`${name}/region/r.0.0.mca`, 'overworld-region');
  await put(`${name}/playerdata/aaaa.dat`, 'player');
  await put(`${name}/session.lock`, 'lock');
  const dims = options.dims ?? 'inside';
  if (dims === 'inside') {
    await put(`${name}/DIM-1/region/r.0.0.mca`, 'nether-region');
    await put(`${name}/DIM1/region/r.0.0.mca`, 'end-region');
  } else if (dims === 'split') {
    await put(`${name}_nether/DIM-1/region/r.0.0.mca`, 'nether-region');
    await put(`${name}_nether/level.dat`, levelDat(options));
    await put(`${name}_the_end/DIM1/region/r.0.0.mca`, 'end-region');
    await put(`${name}_the_end/level.dat`, levelDat(options));
  }
  void world;
}

// The same world as writeWorld, as zip entries (paths relative to the archive root)
export function worldEntries(name: string, options: WorldOptions = {}, prefix = ''): ZipEntry[] {
  const dims = options.dims ?? 'inside';
  const at = (relative: string, content: Buffer | string): ZipEntry => ({ name: `${prefix}${relative}`, content });
  const out: ZipEntry[] = [at(`${name}/level.dat`, levelDat(options)), at(`${name}/region/r.0.0.mca`, 'overworld-region'), at(`${name}/playerdata/aaaa.dat`, 'player')];
  if (dims === 'inside') {
    out.push(at(`${name}/DIM-1/region/r.0.0.mca`, 'nether-region'), at(`${name}/DIM1/region/r.0.0.mca`, 'end-region'));
  } else if (dims === 'split') {
    out.push(
      at(`${name}_nether/DIM-1/region/r.0.0.mca`, 'nether-region'),
      at(`${name}_nether/level.dat`, levelDat(options)),
      at(`${name}_the_end/DIM1/region/r.0.0.mca`, 'end-region'),
      at(`${name}_the_end/level.dat`, levelDat(options)),
    );
  }
  return out;
}

// A jar with the given descriptor files
export function buildJar(files: Record<string, string>): Buffer {
  const entries: ZipEntry[] = Object.entries(files).map(([name, content]) => ({ name, content }));
  return buildZip(entries);
}

export const fabricJar = (id: string, extra: Record<string, unknown> = {}): Buffer =>
  buildJar({ 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id, name: `Name ${id}`, version: '1.2.3', depends: { minecraft: '~1.21' }, ...extra }) });

export const forgeJar = (id: string): Buffer =>
  buildJar({
    'META-INF/mods.toml': `modLoader="javafml"\nloaderVersion="[47,)"\n[[mods]]\nmodId="${id}"\nversion="2.0.0"\ndisplayName="Name ${id}"\n[[dependencies.${id}]]\n  modId="minecraft"\n  mandatory=true\n  versionRange="[1.20.1]"\n  side="BOTH"\n`,
  });
