import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TarSource } from '../src/archive/tar.js';
import { extractZip } from '../src/archive/zip.js';
import { writeZip } from '../src/archive/zip-writer.js';
import { compareWorldToTarget, dataVersionOf, mcVersionFromDataVersion } from '../src/worldio/data-versions.js';
import { buildOutput, convertSingleplayerPlayer, detectStagedWorld } from '../src/worldio/layout.js';
import { levelInfoFromNbt, parseLevelDat } from '../src/worldio/level-dat.js';
import { EXPORT_MANIFEST_NAME, parseManifest, serializeManifest, type ExportManifest } from '../src/worldio/manifest.js';
import { parseTomlTables, readJarMeta } from '../src/worldio/mod-meta.js';
import { child, nbt, parseNbt, parseNbtFile, writeNbt, writeNbtGzip } from '../src/worldio/nbt.js';
import { stageArchive } from '../src/worldio/staging.js';
import { buildTarGz, buildZip } from './archive-builders.js';
import { scratchDir } from './server-env.js';
import { buildJar, fabricJar, forgeJar, levelDat, writeWorld } from './world-fixtures.js';

let dir: string;
beforeEach(async () => {
  dir = await scratchDir('worldio-');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const read = (...parts: string[]): Promise<string> => readFile(path.join(dir, ...parts), 'utf8');
const exists = (...parts: string[]): Promise<boolean> =>
  stat(path.join(dir, ...parts)).then(
    () => true,
    () => false,
  );

describe('NBT reader and writer', () => {
  it('round-trips every tag type', () => {
    const root = nbt.compound({
      b: nbt.byte(-3),
      s: nbt.short(-300),
      i: nbt.int(-70000),
      l: nbt.long(-(2n ** 40n)),
      f: nbt.float(1.5),
      d: nbt.double(-2.25),
      str: nbt.string('Grüße ☃'),
      ba: nbt.byteArray(Buffer.from([1, 2, 3])),
      ia: nbt.intArray([1, -2, 3]),
      la: nbt.longArray([1n, -2n]),
      list: nbt.list('compound', [nbt.compound({ a: nbt.int(1) }), nbt.compound({})]),
      empty: nbt.list('end', []),
      nested: nbt.compound({ deep: nbt.compound({ x: nbt.string('y') }) }),
    });
    const parsed = parseNbt(writeNbt(root, 'root'));
    expect(parsed.name).toBe('root');
    expect(child(parsed.root, 'b')).toEqual({ type: 'byte', value: -3 });
    expect(child(parsed.root, 'l')).toEqual({ type: 'long', value: -(2n ** 40n) });
    expect(child(parsed.root, 'str')).toEqual({ type: 'string', value: 'Grüße ☃' });
    expect(child(parsed.root, 'nested', 'deep', 'x')).toEqual({ type: 'string', value: 'y' });
    expect(writeNbt(parsed.root, 'root').equals(writeNbt(root, 'root'))).toBe(true);
  });

  it('reads gzip and raw files and refuses garbage and truncated data', () => {
    const root = nbt.compound({ a: nbt.int(7) });
    expect(child(parseNbtFile(writeNbtGzip(root)).root, 'a')).toEqual({ type: 'int', value: 7 });
    expect(child(parseNbtFile(writeNbt(root)).root, 'a')).toEqual({ type: 'int', value: 7 });
    expect(() => parseNbtFile(Buffer.from('not nbt at all'))).toThrowError(expect.objectContaining({ code: 'NBT_INVALID' }) as Error);
    expect(() => parseNbtFile(writeNbt(root).subarray(0, 6))).toThrowError(expect.objectContaining({ code: 'NBT_INVALID' }) as Error);
    expect(() => parseNbtFile(gzipSync(Buffer.alloc(100, 7)))).toThrowError(expect.objectContaining({ code: 'NBT_INVALID' }) as Error);
  });

  it('refuses absurd lengths and nesting instead of allocating', () => {
    // compound with an int array claiming 2 billion entries
    const hostile = Buffer.concat([Buffer.from([10, 0, 0, 11, 0, 1, 0x61]), Buffer.from([0x7f, 0xff, 0xff, 0xff])]);
    expect(() => parseNbt(hostile)).toThrowError(expect.objectContaining({ code: 'NBT_INVALID' }) as Error);
    let deep = Buffer.from([10, 0, 0]);
    for (let i = 0; i < 600; i++) deep = Buffer.concat([deep, Buffer.from([10, 0, 1, 0x61])]);
    expect(() => parseNbt(Buffer.concat([deep, Buffer.alloc(700)]))).toThrowError(expect.objectContaining({ code: 'NBT_INVALID' }) as Error);
  });
});

describe('level.dat', () => {
  it('reads version, name, game mode and hardcore from a modern world', () => {
    const info = parseLevelDat(levelDat({ name: 'Island', versionName: '1.20.4', dataVersion: 3700, gameType: 1, hardcore: true, snapshot: false }));
    expect(info).toMatchObject({ levelName: 'Island', versionName: '1.20.4', dataVersion: 3700, mcVersion: '1.20.4', mcVersionApprox: false, gameType: 1, hardcore: true, preOneNine: false });
  });

  it('derives the version from the DataVersion when the name is missing', () => {
    expect(parseLevelDat(levelDat({ versionName: null, dataVersion: 3465 }))).toMatchObject({ mcVersion: '1.20.1', mcVersionApprox: false, preOneNine: false });
    expect(parseLevelDat(levelDat({ versionName: null, dataVersion: 3464 }))).toMatchObject({ mcVersion: '1.20', mcVersionApprox: true });
  });

  it('recognises worlds before 1.9 by the absence of both version tags', () => {
    const info = parseLevelDat(levelDat({ versionName: null, dataVersion: null }));
    expect(info).toMatchObject({ preOneNine: true, mcVersion: null, versionName: null });
  });

  it('reads the Forge 1.12 FML mod list and skips the built-ins', () => {
    const info = parseLevelDat(
      levelDat({
        versionName: null,
        dataVersion: 1343,
        fml: {
          style: 'legacy',
          mods: [
            { id: 'minecraft', version: '1.12.2' },
            { id: 'FML', version: '8.0.99' },
            { id: 'forge', version: '14.23.5.2860' },
            { id: 'jei', version: '4.16.1' },
            { id: 'thermalfoundation', version: '2.6.7' },
          ],
        },
      }),
    );
    expect(info.fml).toBe(true);
    expect(info.forgeMods).toEqual([
      { id: 'jei', version: '4.16.1' },
      { id: 'thermalfoundation', version: '2.6.7' },
    ]);
    expect(info.forgeVersion).toBe('14.23.5.2860');
    expect(info.mcVersion).toBe('1.12.2');
  });

  it('reads the modern fml.loadingModList and NeoForge', () => {
    const info = parseLevelDat(
      levelDat({ versionName: '1.21.1', fml: { style: 'modern', mods: [{ id: 'neoforge', version: '21.1.77' }, { id: 'create', version: '6.0.0' }] }, brands: ['neoforge'], wasModded: true }),
    );
    expect(info.forgeMods).toEqual([{ id: 'create', version: '6.0.0' }]);
    expect(info.neoforgeVersion).toBe('21.1.77');
    expect(info.serverBrands).toEqual(['neoforge']);
    expect(info.wasModded).toBe(true);
  });

  it('extracts the singleplayer player UUID', () => {
    const info = parseLevelDat(levelDat({ playerUuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5' }));
    expect(info.playerUuid).toBe('069a79f4-44e9-4726-a5be-fca90e38aaf5');
  });

  it('rejects files that are not Java level.dat files', () => {
    expect(() => parseLevelDat(Buffer.from('hello'))).toThrowError(expect.objectContaining({ code: 'LEVEL_DAT_INVALID' }) as Error);
    expect(() => levelInfoFromNbt(nbt.compound({ Other: nbt.int(1) }))).toThrowError(expect.objectContaining({ code: 'LEVEL_DAT_INVALID' }) as Error);
  });
});

describe('data versions', () => {
  it('maps in both directions and compares', () => {
    expect(dataVersionOf('1.21.1')).toBe(3955);
    expect(mcVersionFromDataVersion(3955)).toEqual({ version: '1.21.1', approximate: false });
    expect(mcVersionFromDataVersion(100)).toBeNull();
    expect(compareWorldToTarget({ name: '1.21.1', dataVersion: 3955 }, '1.20.4')).toBe('newer');
    expect(compareWorldToTarget({ name: '1.16.5', dataVersion: 2586 }, '1.21.1')).toBe('older');
    expect(compareWorldToTarget({ name: '1.21.1', dataVersion: 3955 }, '1.21.1')).toBe('same');
    // unknown target numbering falls back to the version names
    expect(compareWorldToTarget({ name: '1.21.1', dataVersion: 3955 }, '26.1')).toBe('older');
    expect(compareWorldToTarget({ name: '26.2', dataVersion: 9999 }, '26.1')).toBe('newer');
    expect(compareWorldToTarget({ name: null, dataVersion: null }, '1.21.1')).toBe('unknown');
  });
});

function independentListing(archive: string): string | null {
  try {
    if (process.platform === 'win32') {
      return execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead($env:ZIP_FILE); try { $z.Entries | ForEach-Object { $s=$_.Open(); $m=New-Object IO.MemoryStream; $s.CopyTo($m); $s.Dispose(); $_.FullName + ' ' + $m.Length } } finally { $z.Dispose() }"],
        { encoding: 'utf8', env: { ...process.env, ZIP_FILE: archive } },
      );
    }
    return execFileSync('unzip', ['-l', archive], { encoding: 'utf8' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

describe('zip writer', () => {
  async function sample(): Promise<TarSource[]> {
    await mkdir(path.join(dir, 'src', 'sub'), { recursive: true });
    await writeFile(path.join(dir, 'src', 'a.txt'), 'hello '.repeat(5000));
    await writeFile(path.join(dir, 'src', 'sub', 'b.bin'), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(dir, 'src', 'empty.txt'), '');
    await writeFile(path.join(dir, 'src', 'x.jar'), 'jar-bytes');
    return [
      { kind: 'dir', name: 'sub', mtimeMs: Date.now(), mode: 0o755 },
      { kind: 'file', name: 'a.txt', file: path.join(dir, 'src', 'a.txt'), size: 30000, mtimeMs: Date.now(), mode: 0o644 },
      { kind: 'file', name: 'sub/b.bin', file: path.join(dir, 'src', 'sub', 'b.bin'), size: 4, mtimeMs: Date.now(), mode: 0o644 },
      { kind: 'file', name: 'empty.txt', file: path.join(dir, 'src', 'empty.txt'), size: 0, mtimeMs: Date.now(), mode: 0o644 },
      { kind: 'file', name: 'x.jar', file: path.join(dir, 'src', 'x.jar'), size: 9, mtimeMs: Date.now(), mode: 0o644 },
      { kind: 'bytes', name: 'Ümläut/meta.json', data: Buffer.from('{"a":1}'), mtimeMs: Date.now(), mode: 0o644 },
    ];
  }

  it.each([false, true])('writes archives the own reader and system tools read back (zip64: %s)', async (forceZip64) => {
    const sources = await sample();
    const target = path.join(dir, 'out.zip');
    await writeZip(target, sources, { forceZip64 });
    const report = await extractZip(target, path.join(dir, 'x'), { maxBytes: 1_000_000, maxEntries: 100 });
    expect(report.entries).toBe(6);
    expect(await read('x', 'a.txt')).toBe('hello '.repeat(5000));
    expect(await read('x', 'sub', 'b.bin')).toBe('\u0000\u0001\u0002\u0003');
    expect(await read('x', 'x.jar')).toBe('jar-bytes');
    expect(await read('x', 'Ümläut', 'meta.json')).toBe('{"a":1}');
    expect(await read('x', 'empty.txt')).toBe('');
    // an independent reader: .NET's ZipFile on Windows, unzip elsewhere (skipped when neither exists)
    const listing = independentListing(target);
    if (listing !== null) {
      expect(listing).toContain('a.txt');
      expect(listing).toContain('b.bin');
      expect(listing).toContain('meta.json');
    }
  });

  it('keeps a file that changes size while it is written from silently truncating', async () => {
    await writeFile(path.join(dir, 'f'), 'abc');
    const source: TarSource = { kind: 'file', name: 'f', file: path.join(dir, 'f'), size: 10, mtimeMs: 0, mode: 0o644 };
    await expect(writeZip(path.join(dir, 'o.zip'), [source])).rejects.toMatchObject({ code: 'ARCHIVE_SOURCE_CHANGED' });
  });
});

describe('archive staging safety', () => {
  const limits = { maxBytes: 50 * 1024 * 1024, maxEntries: 1000, maxRatio: 200 };
  const stage = async (name: string, data: Buffer, custom = limits): Promise<unknown> => {
    const file = path.join(dir, name);
    await writeFile(file, data);
    return stageArchive(file, path.join(dir, 'stage'), custom, async () => null, () => undefined);
  };

  it('extracts zip and tar.gz archives', async () => {
    expect(await stage('a.zip', buildZip([{ name: 'world/level.dat', content: 'x' }]))).toMatchObject({ format: 'zip', entries: 1 });
    await rm(path.join(dir, 'stage'), { recursive: true });
    expect(await stage('a.tgz', buildTarGz([{ name: 'world/level.dat', content: 'x' }]))).toMatchObject({ format: 'tar.gz', entries: 1 });
  });

  it('reads zips from Windows PowerShell: backslash separators and folder entries ending in a backslash', async () => {
    const entries = [
      { name: 'My Island\\', content: '' },
      { name: 'My Island\\DIM-1\\', content: '' },
      { name: 'My Island\\level.dat', content: 'x' },
      { name: 'My Island\\DIM-1\\region\\r.0.0.mca', content: 'nether' },
    ];
    expect(await stage('ps.zip', buildZip(entries))).toMatchObject({ format: 'zip' });
    expect(await read('stage', 'My Island', 'DIM-1', 'region', 'r.0.0.mca')).toBe('nether');
  });

  it('rejects zip slip, absolute paths and symlinks', async () => {
    await expect(stage('a.zip', buildZip([{ name: '../evil.txt', content: 'x' }]))).rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE' });
    await expect(stage('b.zip', buildZip([{ name: '/etc/passwd', content: 'x' }]))).rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE' });
    await expect(stage('c.zip', buildZip([{ name: 'link', content: '../../x', mode: 0o120777 }]))).rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE' });
    await expect(stage('d.tgz', buildTarGz([{ name: 'a/../../evil', content: 'x' }]))).rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE' });
    await expect(stage('e.tgz', buildTarGz([{ name: 'l', type: '2', linkname: '/etc/passwd' }]))).rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE' });
    expect(await exists('evil.txt')).toBe(false);
  });

  it('rejects too many entries and too much data', async () => {
    const many = buildZip(Array.from({ length: 30 }, (_, i) => ({ name: `f${i}.txt`, content: 'x' })));
    await expect(stage('m.zip', many, { ...limits, maxEntries: 10 })).rejects.toMatchObject({ code: 'ARCHIVE_TOO_LARGE' });
    const big = buildZip([{ name: 'big.bin', content: Buffer.alloc(200_000, 1) }]);
    await expect(stage('b.zip', big, { ...limits, maxBytes: 100_000 })).rejects.toMatchObject({ code: 'ARCHIVE_TOO_LARGE' });
  });

  it('rejects a compression bomb by its ratio before extracting', async () => {
    // 2 GiB of zeros declared; the real zip stays tiny. Built by hand because the content is never materialised in memory.
    const entry = buildZip([{ name: 'bomb.bin', content: Buffer.alloc(8 * 1024 * 1024, 0) }]);
    const lying = Buffer.from(entry);
    // patch the declared uncompressed size (local and central header) to 2 GiB
    const patch = (signature: number, offset: number): void => {
      const at = lying.indexOf(Buffer.from(new Uint32Array([signature]).buffer));
      lying.writeUInt32LE(2 * 1024 * 1024 * 1024, at + offset);
    };
    patch(0x02014b50, 24);
    await expect(stage('bomb.zip', lying, { ...limits, maxBytes: 4 * 1024 * 1024 * 1024 })).rejects.toMatchObject({ code: 'ARCHIVE_BOMB' });
  });

  it('rejects files that are not archives and corrupt archives', async () => {
    await expect(stage('x.rar', Buffer.from('Rar!\u001a\u0007\u0000 rest'))).rejects.toMatchObject({ code: 'IMPORT_FORMAT_UNSUPPORTED' });
    const broken = buildZip([{ name: 'a.txt', content: 'hello world', badCrc: true }]);
    await expect(stage('y.zip', broken)).rejects.toMatchObject({ code: 'ARCHIVE_CORRUPT' });
  });
});

describe('layout detection and conversion', () => {
  async function stageOf(build: (root: string) => Promise<void>): Promise<string> {
    const root = path.join(dir, `stage-${Math.random().toString(36).slice(2)}`);
    await mkdir(root, { recursive: true });
    await build(root);
    return root;
  }

  it('recognises a singleplayer world with the dimensions inside, also below a wrapper folder', async () => {
    const root = await stageOf((r) => writeWorld(path.join(r, 'My World'), 'x', {}).then(() => undefined));
    // writeWorld created My World/x/...; flatten by detecting the single wrapper chain
    const world = await detectStagedWorld(root);
    expect(world).toMatchObject({ kind: 'world', layout: 'inside' });
    expect(world.netherSrc).not.toBeNull();
    expect(world.endSrc).not.toBeNull();
  });

  it('recognises a Paper server folder: split dimensions, level-name from server.properties', async () => {
    const root = await stageOf(async (r) => {
      await writeWorld(r, 'survival', { dims: 'split', brands: ['Paper'] });
      await writeFile(path.join(r, 'server.properties'), 'level-name=survival\nserver-port=25570\n');
      await writeFile(path.join(r, 'paper.yml'), '');
      await mkdir(path.join(r, 'plugins'));
    });
    const world = await detectStagedWorld(root);
    expect(world).toMatchObject({ kind: 'server', worldName: 'survival', layout: 'split', levelNameFromProperties: 'survival' });
    expect(world.paperHints.join()).toContain('paper.yml');
    expect(world.modDirs.plugins).not.toBeNull();
    expect(world.configItems).toContain('server.properties');
  });

  it('refuses archives without a world and Bedrock worlds with readable errors', async () => {
    const empty = await stageOf((r) => writeFile(path.join(r, 'readme.txt'), 'x'));
    await expect(detectStagedWorld(empty)).rejects.toMatchObject({ code: 'IMPORT_NO_WORLD' });
    const bedrock = await stageOf(async (r) => {
      await mkdir(path.join(r, 'db'));
      await writeFile(path.join(r, 'levelname.txt'), 'Bedrock');
    });
    await expect(detectStagedWorld(bedrock)).rejects.toMatchObject({ code: 'IMPORT_BEDROCK' });
  });

  it('converts inside -> split (singleplayer to Paper) and keeps the level data in every folder', async () => {
    const root = await stageOf((r) => writeWorld(r, 'Adventure', {}));
    const world = await detectStagedWorld(root);
    const out = path.join(dir, 'out-split');
    const built = await buildOutput(world, 'split', 'world', out);
    expect(built.folders).toEqual(['world', 'world_nether', 'world_the_end']);
    expect(await read('out-split', 'world', 'region', 'r.0.0.mca')).toBe('overworld-region');
    expect(await read('out-split', 'world_nether', 'DIM-1', 'region', 'r.0.0.mca')).toBe('nether-region');
    expect(await read('out-split', 'world_the_end', 'DIM1', 'region', 'r.0.0.mca')).toBe('end-region');
    expect(await exists('out-split', 'world_nether', 'level.dat')).toBe(true);
    // the dimensions are no longer inside the world, session.lock is gone
    expect(await exists('out-split', 'world', 'DIM-1')).toBe(false);
    expect(await exists('out-split', 'world', 'session.lock')).toBe(false);
  });

  it('keeps inside for vanilla/Fabric/Forge targets', async () => {
    const root = await stageOf((r) => writeWorld(r, 'a', {}));
    const out = path.join(dir, 'out-inside');
    const built = await buildOutput(await detectStagedWorld(root), 'inside', 'world', out);
    expect(built.folders).toEqual(['world']);
    expect(await read('out-inside', 'world', 'DIM-1', 'region', 'r.0.0.mca')).toBe('nether-region');
    expect(await read('out-inside', 'world', 'DIM1', 'region', 'r.0.0.mca')).toBe('end-region');
  });

  it('converts split -> inside (Paper to vanilla) and split -> split with another name', async () => {
    const make = (): Promise<string> => stageOf(async (r) => {
      await writeWorld(r, 'world', { dims: 'split' });
      await writeFile(path.join(r, 'server.properties'), 'level-name=world\n');
    });
    const out = path.join(dir, 'out-in');
    const built = await buildOutput(await detectStagedWorld(await make()), 'inside', 'world', out);
    expect(built.converted).toBe(true);
    expect(built.folders).toEqual(['world']);
    expect(await read('out-in', 'world', 'DIM-1', 'region', 'r.0.0.mca')).toBe('nether-region');
    expect(await read('out-in', 'world', 'DIM1', 'region', 'r.0.0.mca')).toBe('end-region');
    expect(await exists('out-in', 'world_nether')).toBe(false);

    const again = path.join(dir, 'out-sp');
    const second = await buildOutput(await detectStagedWorld(await make()), 'split', 'fresh', again);
    expect(second.converted).toBe(false);
    expect(second.folders).toEqual(['fresh', 'fresh_nether', 'fresh_the_end']);
    expect(await read('out-sp', 'fresh_nether', 'DIM-1', 'region', 'r.0.0.mca')).toBe('nether-region');
  });

  it('copies a world without nether or end as it is', async () => {
    const root = await stageOf((r) => writeWorld(r, 'flat', { dims: 'none' }));
    const world = await detectStagedWorld(root);
    expect(world.netherSrc).toBeNull();
    const built = await buildOutput(world, 'split', 'world', path.join(dir, 'out-none'));
    expect(built.folders).toEqual(['world']);
  });

  it('writes the singleplayer player as playerdata of the server', async () => {
    const uuid = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
    const root = await stageOf((r) => writeWorld(r, 'a', { playerUuid: uuid }));
    const world = await detectStagedWorld(root);
    const out = path.join(dir, 'out-player');
    await buildOutput(world, 'inside', 'world', out);
    const info = parseLevelDat(await readFile(path.join(out, 'world', 'level.dat')));
    expect(await convertSingleplayerPlayer(path.join(out, 'world'), info)).toBe(uuid);
    const written = parseNbtFile(await readFile(path.join(out, 'world', 'playerdata', `${uuid}.dat`)));
    expect(child(written.root, 'Health')).toEqual({ type: 'float', value: 20 });
    // an existing playerdata file wins
    expect(await convertSingleplayerPlayer(path.join(out, 'world'), info)).toBeNull();
  });
});

describe('export manifest', () => {
  const manifest: ExportManifest = {
    format: 1,
    kind: 'worldfoundry-world-export',
    appVersion: '0.1.0',
    createdAt: '2025-01-01T00:00:00.000Z',
    source: 'server',
    server: { name: 'Überleben', mcVersion: '1.21.1', loader: 'fabric', loaderVersion: '0.16.0' },
    world: { levelName: 'world', folders: ['world', 'world_nether'], layout: 'inside', dataVersion: 3955 },
    includes: { config: true, mods: 'jars' },
    mods: [
      {
        name: 'Sodium',
        fileName: 'sodium.jar',
        enabled: false,
        sha1: 'a'.repeat(40),
        sha512: 'b'.repeat(128),
        sizeBytes: 12,
        modId: 'sodium',
        version: '0.6.0',
        projectId: 'AANobbMI',
        versionId: 'abc',
        source: 'modrinth',
        side: 'client',
        dir: 'mods',
        included: true,
      },
    ],
  };

  it('round-trips exactly', () => {
    expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
    expect(EXPORT_MANIFEST_NAME).toBe('worldfoundry-export.json');
  });

  it('refuses foreign, broken and future manifests with a readable message', () => {
    expect(() => parseManifest(Buffer.from('{nope'))).toThrowError(expect.objectContaining({ code: 'EXPORT_MANIFEST_INVALID' }) as Error);
    expect(() => parseManifest(Buffer.from(JSON.stringify({ ...manifest, format: 2 })))).toThrowError(expect.objectContaining({ code: 'EXPORT_MANIFEST_INVALID' }) as Error);
    expect(() => parseManifest(Buffer.from(JSON.stringify({ ...manifest, mods: [{ name: 'x' }] })))).toThrowError(expect.objectContaining({ code: 'EXPORT_MANIFEST_INVALID' }) as Error);
  });
});

describe('mod jar metadata', () => {
  const write = async (name: string, data: Buffer): Promise<string> => {
    const file = path.join(dir, name);
    await writeFile(file, data);
    return file;
  };

  it('reads Fabric, Quilt, Forge, NeoForge, legacy Forge and plugin descriptors', async () => {
    expect(await readJarMeta(await write('f.jar', fabricJar('sodium', { environment: 'client' })))).toMatchObject({
      loaders: ['fabric'],
      modId: 'sodium',
      name: 'Name sodium',
      version: '1.2.3',
      side: 'client',
      minecraft: '~1.21',
    });
    expect(await readJarMeta(await write('q.jar', buildJar({ 'quilt.mod.json': JSON.stringify({ quilt_loader: { id: 'qmod', version: '2', metadata: { name: 'Q' }, depends: [{ id: 'minecraft', versions: '>=1.20' }] } }) })))).toMatchObject({
      loaders: ['quilt'],
      modId: 'qmod',
      minecraft: '>=1.20',
    });
    expect(await readJarMeta(await write('g.jar', forgeJar('create')))).toMatchObject({ loaders: ['forge'], modId: 'create', version: '2.0.0', minecraft: '[1.20.1]', side: 'both' });
    expect(
      await readJarMeta(await write('n.jar', buildJar({ 'META-INF/neoforge.mods.toml': 'modLoader = "javafml"\n[[mods]]\nmodId = "neomod"\nversion = "${file.jarVersion}"\n', 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\nImplementation-Version: 9.9.1\n' }))),
    ).toMatchObject({ loaders: ['neoforge'], modId: 'neomod', version: '9.9.1' });
    expect(await readJarMeta(await write('l.jar', buildJar({ 'mcmod.info': JSON.stringify([{ modid: 'jei', name: 'JEI', version: '4.1', mcversion: '1.12.2' }, { modid: 'jei-api' }]) })))).toMatchObject({
      loaders: ['forge'],
      modId: 'jei',
      extraIds: ['jei-api'],
      minecraft: '1.12.2',
    });
    expect(await readJarMeta(await write('p.jar', buildJar({ 'plugin.yml': "name: EssentialsX\nversion: '2.20'\napi-version: 1.20\n" })))).toMatchObject({
      loaders: ['paper'],
      modId: 'EssentialsX',
      version: '2.20',
      side: 'server',
    });
  });

  it('reports jars without descriptors as unknown and rejects non-zip files', async () => {
    expect(await readJarMeta(await write('lib.jar', buildJar({ 'a/B.class': 'x' })))).toMatchObject({ loaders: [], modId: null });
    await expect(readJarMeta(await write('bad.jar', Buffer.from('not a zip')))).rejects.toMatchObject({ code: 'ARCHIVE_CORRUPT' });
  });

  it('parses the TOML subset of mods.toml', () => {
    const tables = parseTomlTables('# c\nmodLoader="javafml" # trailing\n[[mods]]\nmodId = "a#b"\ndescription=\'\'\'\nlong\ntext\n\'\'\'\n[[dependencies.a]]\nmodId="minecraft"\n');
    expect(tables.find((t) => t.name === 'mods')?.values).toMatchObject({ modId: 'a#b', description: 'long\ntext' });
    expect(tables.find((t) => t.name === 'dependencies.a')?.values['modId']).toBe('minecraft');
    expect(tables[0]?.values['modLoader']).toBe('javafml');
  });
});
