import { eq } from 'drizzle-orm';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractTarGz } from '../src/archive/tar.js';
import { extractZip } from '../src/archive/zip.js';
import type { ExportJobDto, ImportJobDto, ImportReviewDto } from '../src/contract.js';
import { mods, servers } from '../src/db/schema.js';
import { parseManifest } from '../src/worldio/manifest.js';
import { buildTarGz, buildZip, type ZipEntry } from './archive-builders.js';
import { sha512Of } from './fake-modrinth.js';
import { ServerEnv, scratchDir, waitFor } from './server-env.js';
import { fabricJar, worldEntries } from './world-fixtures.js';

interface ErrorBody {
  error: { code: string; message: string; details?: { codes?: string[] } };
}

let env: ServerEnv;
let events: string;

const SMALL_TIMINGS = { saveOffMs: 400, flushMs: 1500, saveOnMs: 400 };

async function setup(options: Parameters<typeof ServerEnv.create>[0] = {}): Promise<void> {
  env = await ServerEnv.create({ saveTimings: SMALL_TIMINGS, ...options });
  events = path.join(await scratchDir('events-'), 'fake-events.log');
  env.spawner.extraEnv['FAKE_EVENTS_FILE'] = events;
}
beforeEach(async () => {
  await setup();
});
afterEach(async () => {
  await env.services.imports.idle();
  await env.services.exports.idle();
  await env.close();
});

const write = async (serverId: string, relative: string, content: string | Buffer): Promise<void> => {
  const file = path.join(env.serverDir(serverId), ...relative.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};
const read = (serverId: string, relative: string): Promise<string> => readFile(path.join(env.serverDir(serverId), ...relative.split('/')), 'utf8');
const exists = (serverId: string, relative: string): Promise<boolean> =>
  stat(path.join(env.serverDir(serverId), ...relative.split('/'))).then(
    () => true,
    () => false,
  );
const tmpEntries = async (kind: 'imports' | 'exports'): Promise<string[]> => readdir(path.join(env.config.dataDir, 'tmp', kind)).catch(() => []);

async function seedWorld(serverId: string, level = 'world', dims: 'inside' | 'split' = 'split'): Promise<void> {
  await write(serverId, 'server.properties', `level-name=${level}\nserver-port=25599\n`);
  for (const entry of worldEntries(level, { dims, versionName: '1.21.1' })) await write(serverId, entry.name, entry.content ?? '');
  await write(serverId, 'ops.json', '[]');
}

// ---- export helpers -----------------------------------------------------------------------

async function runExport(serverId: string, body: Record<string, unknown>): Promise<ExportJobDto> {
  const started = await env.call<{ export: ExportJobDto } & ErrorBody>('POST', `/api/servers/${serverId}/exports`, body);
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  await env.services.exports.idle();
  const done = await env.call<{ export: ExportJobDto }>('GET', `/api/exports/${started.body.export.id}`);
  return done.body.export;
}

async function download(job: ExportJobDto): Promise<{ dir: string; response: Awaited<ReturnType<typeof env.app.inject>> }> {
  const response = await env.app.inject({ method: 'GET', url: `/api/exports/${job.id}/download` });
  const dir = await scratchDir('dl-');
  const file = path.join(dir, job.fileName);
  await writeFile(file, response.rawPayload);
  const out = path.join(dir, 'x');
  if (job.options.format === 'zip') await extractZip(file, out, { maxBytes: 1e9, maxEntries: 100_000 });
  else await extractTarGz(file, out, { maxBytes: 1e9, maxEntries: 100_000 });
  return { dir: out, response };
}

// ---- import helpers -----------------------------------------------------------------------

async function upload(data: Buffer | Readable, query = '', headers: Record<string, string> = {}): Promise<{ status: number; body: { import: ImportJobDto } & ErrorBody }> {
  const response = await env.app.inject({
    method: 'POST',
    url: `/api/imports${query}`,
    headers: { 'content-type': 'application/octet-stream', ...headers },
    payload: data as Buffer,
  });
  return { status: response.statusCode, body: JSON.parse(response.body) as { import: ImportJobDto } & ErrorBody };
}

async function waitJob(id: string, states: string[]): Promise<ImportJobDto> {
  return waitFor(
    async () => {
      const res = await env.call<{ import: ImportJobDto }>('GET', `/api/imports/${id}`);
      return states.includes(res.body.import.status) ? res.body.import : undefined;
    },
    15_000,
    `Import ${states.join('/')}`,
  );
}

async function staged(entries: ZipEntry[], query = ''): Promise<ImportJobDto> {
  const res = await upload(buildZip(entries), query);
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return waitJob(res.body.import.id, ['staged', 'failed']);
}

const review = (id: string, loader: string, mcVersion: string) => env.call<ImportReviewDto & ErrorBody>('POST', `/api/imports/${id}/review`, { loader, mcVersion });
const createFrom = (id: string, body: Record<string, unknown>) => env.call<{ server: { id: string }; import: ImportJobDto } & ErrorBody>('POST', `/api/imports/${id}/create-server`, body);
const serverSpec = (loader: string, mcVersion: string, extra: Record<string, unknown> = {}) => ({ name: 'Imported', loader, mcVersion, ...extra });

describe('exporting a world', () => {
  it('exports a stopped server as zip with a manifest, Paper-style folders and optional config', async () => {
    const server = await env.addServer({ loader: 'paper', name: 'Überleben' });
    await seedWorld(server.id);
    const job = await runExport(server.id, { format: 'zip', mods: 'none', includeConfig: true });
    expect(job).toMatchObject({ status: 'ready', error: null, source: 'server' });
    expect(job.fileName).toMatch(/^Uberleben-world-\d{4}-\d{2}-\d{2}\.zip$/);
    const { dir, response } = await download(job);
    expect(response.headers['content-type']).toBe('application/zip');
    expect(Number(response.headers['content-length'])).toBe(job.sizeBytes);
    expect((await readdir(dir)).sort()).toEqual(['ops.json', 'server.properties', 'world', 'world_nether', 'world_the_end', 'worldfoundry-export.json']);
    expect(await readFile(path.join(dir, 'world_nether', 'DIM-1', 'region', 'r.0.0.mca'), 'utf8')).toBe('nether-region');
    const manifest = parseManifest(await readFile(path.join(dir, 'worldfoundry-export.json')));
    expect(manifest).toMatchObject({
      server: { name: 'Überleben', loader: 'paper', mcVersion: '1.21.1' },
      world: { levelName: 'world', folders: ['world', 'world_nether', 'world_the_end'], layout: 'split', dataVersion: 3955 },
      includes: { config: true, mods: 'none' },
      mods: [],
    });
    expect(await exists(server.id, 'world/session.lock')).toBe(false);
  });

  it('leaves out the config unless asked', async () => {
    const server = await env.addServer();
    await seedWorld(server.id, 'world', 'inside');
    const { dir } = await download(await runExport(server.id, {}));
    expect((await readdir(dir)).sort()).toEqual(['world', 'worldfoundry-export.json']);
  });

  it('writes tar.gz when asked', async () => {
    const server = await env.addServer();
    await seedWorld(server.id, 'world', 'inside');
    const job = await runExport(server.id, { format: 'tar.gz' });
    expect(job.fileName.endsWith('.tar.gz')).toBe(true);
    const { dir, response } = await download(job);
    expect(response.headers['content-type']).toBe('application/gzip');
    expect(await readFile(path.join(dir, 'world', 'DIM1', 'region', 'r.0.0.mca'), 'utf8')).toBe('end-region');
  });

  describe('mods', () => {
    beforeEach(async () => {
      env.modrinth.addProject('sodium', 'Sodium');
      env.modrinth.addVersion({ id: 'v-sodium', projectId: 'sodium', number: '0.6.0', date: '2024-01-01T00:00:00Z', content: 'sodium-jar-content', fileName: 'sodium.jar' });
    });

    async function fabricServer(): Promise<string> {
      const server = await env.addServer({ loader: 'fabric', name: 'Modded' });
      await seedWorld(server.id, 'world', 'inside');
      await write(server.id, 'mods/sodium.jar', 'sodium-jar-content');
      await write(server.id, 'mods/lithium.jar.disabled', fabricJar('lithium', { environment: 'server' }));
      await env.t.db.insert(mods).values({
        id: 'm1',
        serverId: server.id,
        source: 'modrinth',
        projectId: 'sodium',
        versionId: 'v-sodium',
        versionNumber: '0.6.0',
        name: 'Sodium',
        fileName: 'sodium.jar',
        sha512: sha512Of('sodium-jar-content'),
        sizeBytes: 18,
        installedAt: new Date(),
        updatedAt: new Date(),
      });
      return server.id;
    }

    it('lists mods in the manifest only', async () => {
      const id = await fabricServer();
      const { dir } = await download(await runExport(id, { mods: 'manifest' }));
      expect(await exists('', 'x')).toBe(false);
      expect(await readdir(dir)).not.toContain('mods');
      const manifest = parseManifest(await readFile(path.join(dir, 'worldfoundry-export.json')));
      expect(manifest.mods).toHaveLength(2);
      expect(manifest.mods.find((mod) => mod.fileName === 'sodium.jar')).toMatchObject({
        projectId: 'sodium',
        versionId: 'v-sodium',
        source: 'modrinth',
        enabled: true,
        included: false,
        sha512: sha512Of('sodium-jar-content'),
        dir: 'mods',
      });
      expect(manifest.mods.find((mod) => mod.fileName === 'lithium.jar')).toMatchObject({ enabled: false, modId: 'lithium', side: 'server', source: 'manual', sha1: expect.stringMatching(/^[0-9a-f]{40}$/) });
    });

    it('includes the jar files with their disabled state', async () => {
      const id = await fabricServer();
      const { dir } = await download(await runExport(id, { mods: 'jars' }));
      expect((await readdir(path.join(dir, 'mods'))).sort()).toEqual(['lithium.jar.disabled', 'sodium.jar']);
      expect(await readFile(path.join(dir, 'mods', 'sodium.jar'), 'utf8')).toBe('sodium-jar-content');
      expect(parseManifest(await readFile(path.join(dir, 'worldfoundry-export.json'))).mods.every((mod) => mod.included)).toBe(true);
    });

    it('ignores mod options for a vanilla server', async () => {
      const server = await env.addServer();
      await seedWorld(server.id, 'world', 'inside');
      const job = await runExport(server.id, { mods: 'jars' });
      expect(job.options.mods).toBe('none');
    });
  });

  it('freezes a running server with save-off / save-all flush and always resumes with save-on', async () => {
    const server = await env.addServer();
    await seedWorld(server.id, 'world', 'inside');
    expect((await env.call('POST', `/api/servers/${server.id}/start`)).status).toBe(200);
    await env.waitState(server.id, 'online');
    const job = await runExport(server.id, {});
    expect(job.status).toBe('ready');
    const lines = (await readFile(events, 'utf8')).split('\n').filter(Boolean).map((line) => line.slice(line.indexOf(' ') + 1));
    expect(lines.filter((line) => line.startsWith('save'))).toEqual(['save-off', 'save-all flush (saving off)', 'save-on']);
    expect((await env.status(server.id)).state).toBe('online');
    expect(await readFile(path.join((await download(job)).dir, 'world', 'region', 'r.0.0.mca'), 'utf8')).toBe('overworld-region');
  });

  it('answers readably when there is no world, when the file is gone and for unknown exports', async () => {
    const server = await env.addServer();
    const none = await env.call<ErrorBody>('POST', `/api/servers/${server.id}/exports`, {});
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('EXPORT_NOTHING');
    expect((await env.call<ErrorBody>('GET', '/api/exports/nope')).body.error.code).toBe('EXPORT_NOT_FOUND');
    expect((await env.call<ErrorBody>('POST', '/api/servers/nope/exports', {})).body.error.code).toBe('SERVER_NOT_FOUND');
    await seedWorld(server.id, 'world', 'inside');
    const job = await runExport(server.id, {});
    await env.call('DELETE', `/api/exports/${job.id}`);
    expect((await env.app.inject({ method: 'GET', url: `/api/exports/${job.id}/download` })).statusCode).toBe(404);
    expect(await tmpEntries('exports')).toEqual([]);
  });

  it('fails with a readable message when there is not enough free space and leaves no files', async () => {
    await env.close();
    await setup({ freeSpace: async () => 1000 });
    const server = await env.addServer();
    await seedWorld(server.id, 'world', 'inside');
    const job = await runExport(server.id, {});
    expect(job.status).toBe('failed');
    expect(job.error).toContain('disk space');
    expect(job.errorRef).toMatchObject({ key: 'DISK_FULL', params: { purpose: 'export' } });
    expect((await tmpEntries('exports')).filter((name) => !name.endsWith('.part') || true)).toEqual([]);
  });

  it('exports an existing backup as a world archive', async () => {
    const server = await env.addServer();
    await seedWorld(server.id, 'world', 'inside');
    const created = await env.call<{ backup: { id: string } }>('POST', `/api/servers/${server.id}/backups`);
    await env.services.backups.idle();
    const started = await env.call<{ export: ExportJobDto }>('POST', `/api/servers/${server.id}/backups/${created.body.backup.id}/export`, { format: 'zip' });
    expect(started.status).toBe(202);
    await env.services.exports.idle();
    const job = (await env.call<{ export: ExportJobDto }>('GET', `/api/exports/${started.body.export.id}`)).body.export;
    expect(job).toMatchObject({ status: 'ready', source: 'backup' });
    const { dir } = await download(job);
    expect(await readFile(path.join(dir, 'world', 'DIM-1', 'region', 'r.0.0.mca'), 'utf8')).toBe('nether-region');
    expect(parseManifest(await readFile(path.join(dir, 'worldfoundry-export.json'))).source).toBe('backup');
  });
});

describe('importing a world as a new server', () => {
  it('analyses a plain singleplayer world zip and creates a vanilla server with the world', async () => {
    const job = await staged(worldEntries('My Island', { versionName: '1.21.1', dataVersion: 3955, name: 'Island', playerUuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5' }));
    expect(job.status).toBe('staged');
    expect(job.analysis).toMatchObject({
      source: 'world',
      world: { layout: 'inside', hasNether: true, hasEnd: true, levelName: 'Island', singleplayerPlayer: true },
      version: { mcVersion: '1.21.1', preOneNine: false },
      proposal: { loader: 'vanilla', mcVersion: '1.21.1' },
      modded: false,
      archive: { format: 'zip' },
    });
    const checked = await review(job.id, 'vanilla', '1.21.1');
    expect(checked.status).toBe(200);
    expect(checked.body.notices.map((n) => n.code)).toContain('SINGLEPLAYER_PLAYER');

    const created = await createFrom(job.id, { server: serverSpec('vanilla', '1.21.1'), acknowledged: [] });
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    const done = await waitJob(job.id, ['done', 'failed']);
    expect(done.status, done.error ?? '').toBe('done');
    const id = created.body.server.id;
    expect(done.result?.folders).toEqual(['world']);
    expect(await read(id, 'world/region/r.0.0.mca')).toBe('overworld-region');
    expect(await read(id, 'world/DIM-1/region/r.0.0.mca')).toBe('nether-region');
    expect(await exists(id, 'world/playerdata/069a79f4-44e9-4726-a5be-fca90e38aaf5.dat')).toBe(true);
    // staging is gone and the server is a normal, installed, EULA-less server on a free port
    expect(await tmpEntries('imports')).toEqual([]);
    await waitFor(async () => (await env.row(id))?.installState === 'installed');
    expect(await env.row(id)).toMatchObject({ eulaAccepted: false, loader: 'vanilla', mcVersion: '1.21.1' });
  });

  it('converts the layout for Paper servers', async () => {
    const job = await staged(worldEntries('World', { versionName: '1.21.1' }));
    const created = await createFrom(job.id, { server: serverSpec('paper', '1.21.1'), acknowledged: [] });
    expect(created.status).toBe(202);
    const done = await waitJob(job.id, ['done', 'failed']);
    expect(done.result?.folders).toEqual(['world', 'world_nether', 'world_the_end']);
    const id = created.body.server.id;
    expect(await read(id, 'world_nether/DIM-1/region/r.0.0.mca')).toBe('nether-region');
    expect(await exists(id, 'world/DIM-1')).toBe(false);
  });

  it('refuses a downgrade and requires acknowledgement for an upgrade', async () => {
    const newer = await staged(worldEntries('w', { versionName: '1.21.1', dataVersion: 3955 }));
    const refused = await createFrom(newer.id, { server: serverSpec('vanilla', '1.20.4'), acknowledged: ['WORLD_NEWER'] });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('WORLD_NEWER');
    expect((await env.call<{ import: ImportJobDto }>('GET', `/api/imports/${newer.id}`)).body.import.status).toBe('staged');
    expect((await env.t.db.select().from(servers)).length).toBe(0);

    const older = await staged(worldEntries('w', { versionName: '1.20.4', dataVersion: 3700 }));
    const needs = await createFrom(older.id, { server: serverSpec('vanilla', '1.21.1'), acknowledged: [] });
    expect(needs.status).toBe(409);
    expect(needs.body.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(needs.body.error.details?.codes).toEqual(['WORLD_UPGRADE']);
    const ok = await createFrom(older.id, { server: serverSpec('vanilla', '1.21.1'), acknowledged: ['WORLD_UPGRADE'] });
    expect(ok.status).toBe(202);
    expect((await waitJob(older.id, ['done', 'failed'])).status).toBe('done');
  });

  it('asks the user to choose a version for worlds older than 1.9', async () => {
    const job = await staged(worldEntries('old', { versionName: null, dataVersion: null }));
    expect(job.analysis?.version).toMatchObject({ preOneNine: true, mcVersion: null });
    expect(job.analysis?.notices.map((n) => n.code)).toContain('WORLD_PRE_1_9');
    // the upload-time text differs from the review text, so it has its own key
    expect(job.analysis?.notices.find((n) => n.code === 'WORLD_PRE_1_9')?.key).toBe('WORLD_PRE_1_9_UPLOAD');
    expect(job.analysis?.proposal.evidenceRefs).toHaveLength(job.analysis?.proposal.evidence.length ?? -1);
    const needs = await createFrom(job.id, { server: serverSpec('vanilla', '1.21.1'), acknowledged: [] });
    expect(needs.body.error.code).toBe('CONFIRMATION_REQUIRED');
  });

  it('warns when a modded world is imported without mods and for a Fabric/Forge switch', async () => {
    const job = await staged(worldEntries('w', { versionName: '1.21.1', brands: ['fabric'], wasModded: true, fml: undefined }));
    expect(job.analysis).toMatchObject({ proposal: { loader: 'fabric' }, modded: true });
    const vanilla = await review(job.id, 'vanilla', '1.21.1');
    expect(vanilla.body.notices.find((n) => n.code === 'MODDED_NO_LOADER')).toMatchObject({ level: 'warn', needsConfirm: true });
    // a notice carries the parameters of its text, and the code is the message key
    expect(vanilla.body.notices.find((n) => n.code === 'MODDED_NO_LOADER')).toMatchObject({ params: { loader: 'Vanilla' }, text: expect.stringContaining('Vanilla cannot load them') });
    expect(vanilla.body.notices.every((n) => n.key === undefined)).toBe(true);
    const forge = await review(job.id, 'forge', '1.21.1');
    expect(forge.body.notices.map((n) => n.code)).toContain('LOADER_SWITCH');
    const blocked = await createFrom(job.id, { server: serverSpec('vanilla', '1.21.1'), acknowledged: [] });
    expect(blocked.body.error.code).toBe('CONFIRMATION_REQUIRED');
  });

  it('finds mods of a Forge world on Modrinth, lists the missing ones and installs the chosen ones', async () => {
    env.modrinth.addProject('jei', 'Just Enough Items');
    env.modrinth.addVersion({ id: 'v-jei', projectId: 'jei', number: '4.16.1', date: '2024-01-01T00:00:00Z', gameVersions: ['1.12.2'], loaders: ['forge'], fileName: 'jei-1.12.2.jar' });
    env.installer.mode = 'legacy';
    const job = await staged(
      worldEntries('w', {
        versionName: null,
        dataVersion: 1343,
        fml: {
          style: 'legacy',
          mods: [
            { id: 'minecraft', version: '1.12.2' },
            { id: 'forge', version: '14.23.5.2864' },
            { id: 'jei', version: '4.16.1' },
            { id: 'unknownmod', version: '1' },
          ],
        },
      }),
    );
    expect(job.analysis).toMatchObject({
      modded: true,
      proposal: { loader: 'forge', mcVersion: '1.12.2', loaderVersion: expect.stringContaining('14.23.5.2864') },
      mods: [
        { modId: 'jei', origin: 'level.dat', version: '4.16.1' },
        { modId: 'unknownmod', origin: 'level.dat' },
      ],
    });
    const checked = await review(job.id, 'forge', '1.12.2');
    expect(checked.body.modrinthAvailable).toBe(true);
    const jei = checked.body.matches.find((m) => m.key === 'fml:jei');
    expect(jei).toMatchObject({ state: 'found', projectId: 'jei', versionId: 'v-jei', selected: true });
    expect(checked.body.matches.find((m) => m.key === 'fml:unknownmod')).toMatchObject({ state: 'not-found', selected: false });

    const withoutAck = await createFrom(job.id, { server: serverSpec('forge', '1.12.2'), selection: { jars: [], install: [{ key: 'fml:jei', projectId: 'jei', versionId: 'v-jei' }] }, acknowledged: ['WORLD_PRE_1_9'] });
    expect(withoutAck.body.error.details?.codes).toEqual(['MODS_MISSING']);
    const created = await createFrom(job.id, {
      server: serverSpec('forge', '1.12.2'),
      selection: { jars: [], install: [{ key: 'fml:jei', projectId: 'jei', versionId: 'v-jei' }] },
      acknowledged: ['MODS_MISSING'],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    const done = await waitJob(job.id, ['done', 'failed']);
    expect(done.status, done.error ?? '').toBe('done');
    expect(done.result?.modsInstalled).toEqual(['jei']);
    const rows = await env.t.db.select().from(mods).where(eq(mods.serverId, created.body.server.id));
    expect(rows.map((row) => [row.projectId, row.fileName])).toEqual([['jei', 'jei-1.12.2.jar']]);
    expect(await exists(created.body.server.id, 'mods/jei-1.12.2.jar')).toBe(true);
  });

  it('places jars of a server archive and makes them updatable through their Modrinth hash', async () => {
    env.modrinth.addProject('sodium', 'Sodium');
    env.modrinth.addVersion({ id: 'v-sodium', projectId: 'sodium', number: '0.6.0', date: '2024-01-01T00:00:00Z', content: 'sodium-jar-content', fileName: 'sodium.jar' });
    const job = await staged([
      ...worldEntries('world', { versionName: '1.21.1' }),
      { name: 'server.properties', content: 'level-name=world\nserver-port=25000\nmotd=Hello\n' },
      { name: 'ops.json', content: '[]' },
      { name: 'mods/sodium.jar', content: 'sodium-jar-content' },
      { name: 'mods/own.jar.disabled', content: fabricJar('own') },
      { name: 'mods/clientonly.jar', content: fabricJar('shiny', { environment: 'client' }) },
    ]);
    expect(job.analysis).toMatchObject({ source: 'server', hasJars: true, proposal: { loader: 'fabric' }, config: { properties: true, items: expect.arrayContaining(['server.properties', 'ops.json']) } });
    const checked = await review(job.id, 'fabric', '1.21.1');
    const states = Object.fromEntries(checked.body.matches.map((m) => [m.key, m.state]));
    expect(states).toEqual({ 'jar:mods/sodium.jar': 'jar-known', 'jar:mods/own.jar': 'jar', 'jar:mods/clientonly.jar': 'client-only' });
    expect(checked.body.matches.find((m) => m.key === 'jar:mods/sodium.jar')).toMatchObject({ projectId: 'sodium', versionNumber: '0.6.0' });

    const created = await createFrom(job.id, {
      server: serverSpec('fabric', '1.21.1', { loaderVersion: '0.16.14' }),
      importConfig: true,
      selection: { jars: ['jar:mods/sodium.jar', 'jar:mods/own.jar'], install: [] },
      acknowledged: [],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    const done = await waitJob(job.id, ['done', 'failed']);
    expect(done.status, done.error ?? '').toBe('done');
    const id = created.body.server.id;
    expect(done.result?.jarsPlaced).toEqual(['sodium.jar', 'own.jar']);
    expect((await readdir(path.join(env.serverDir(id), 'mods'))).sort()).toEqual(['own.jar.disabled', 'sodium.jar']);
    const rows = await env.t.db.select().from(mods).where(eq(mods.serverId, id));
    expect(rows.find((row) => row.fileName === 'sodium.jar')).toMatchObject({ projectId: 'sodium', versionId: 'v-sodium', enabled: true });
    expect(rows.find((row) => row.fileName === 'own.jar')).toMatchObject({ projectId: null, enabled: false });
    // the configuration came along, with the port of the new server and the world name this app uses
    const properties = await read(id, 'server.properties');
    expect(properties).toContain('motd=Hello');
    expect(properties).toContain('level-name=world');
    expect(properties).toContain(`server-port=${created.body.server.id === id ? (await env.row(id))?.port : ''}`);
    expect(properties).not.toContain('server-port=25000');
    expect(await read(id, 'ops.json')).toBe('[]');
  });

  it('round-trips: export with jars, import as a new server', async () => {
    env.modrinth.addProject('sodium', 'Sodium');
    env.modrinth.addVersion({ id: 'v-sodium', projectId: 'sodium', number: '0.6.0', date: '2024-01-01T00:00:00Z', content: 'sodium-jar-content', fileName: 'sodium.jar' });
    const source = await env.addServer({ loader: 'fabric', loaderVersion: '0.16.14', name: 'Source' });
    await seedWorld(source.id, 'world', 'inside');
    await write(source.id, 'mods/sodium.jar', 'sodium-jar-content');
    const exported = await runExport(source.id, { mods: 'jars', includeConfig: true });
    const file = await env.app.inject({ method: 'GET', url: `/api/exports/${exported.id}/download` });

    const job = await waitJob((await upload(file.rawPayload)).body.import.id, ['staged', 'failed']);
    expect(job.status, job.error ?? '').toBe('staged');
    expect(job.analysis).toMatchObject({
      source: 'cm-export',
      manifest: { loader: 'fabric', mcVersion: '1.21.1', loaderVersion: '0.16.14' },
      proposal: { loader: 'fabric', mcVersion: '1.21.1', loaderVersion: '0.16.14' },
      hasJars: true,
    });
    const created = await createFrom(job.id, { server: serverSpec('fabric', '1.21.1', { loaderVersion: '0.16.14' }), selection: { jars: ['jar:mods/sodium.jar'], install: [] }, acknowledged: [] });
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    expect((await waitJob(job.id, ['done', 'failed'])).status).toBe('done');
    const id = created.body.server.id;
    expect(await read(id, 'world/DIM-1/region/r.0.0.mca')).toBe('nether-region');
    expect((await env.t.db.select().from(mods).where(eq(mods.serverId, id)))[0]).toMatchObject({ projectId: 'sodium', fileName: 'sodium.jar' });
  });

  it('keeps nothing in the server list when the import is cancelled', async () => {
    const job = await staged(worldEntries('w'));
    expect((await env.call('DELETE', `/api/imports/${job.id}`)).status).toBe(200);
    expect((await env.call<ErrorBody>('GET', `/api/imports/${job.id}`)).body.error.code).toBe('IMPORT_NOT_FOUND');
    expect(await tmpEntries('imports')).toEqual([]);
  });
});

describe('upload limits, hostile archives and cleanup', () => {
  it('refuses an upload above the limit by its announced size and by what actually arrives', async () => {
    await env.close();
    await setup({ config: { importMaxMb: 1 } });
    const announced = await upload(Buffer.alloc(1024 * 1024 + 10, 1));
    expect(announced.status).toBe(413);
    expect(announced.body.error.code).toBe('IMPORT_TOO_LARGE');
    expect(announced.body.error.message).toContain('IMPORT_MAX_MB');
    const stream = Readable.from((async function* () {
      for (let i = 0; i < 30; i++) yield Buffer.alloc(100 * 1024, 2);
    })());
    const streamed = await upload(stream);
    expect(streamed.status).toBe(413);
    expect(await tmpEntries('imports')).toEqual([]);
    expect((await env.call<{ maxUploadBytes: number }>('GET', '/api/imports/limits')).body.maxUploadBytes).toBe(1024 * 1024);
  });

  it('fails an upload that is not an archive and cleans up', async () => {
    const res = await upload(Buffer.from('this is not a zip file'));
    const job = await waitJob(res.body.import.id, ['failed']);
    expect(job.error).toContain('format');
    expect(await tmpEntries('imports')).toEqual([]);
  });

  it('rejects zip slip and symlink archives before anything is written outside', async () => {
    const slip = await staged([{ name: '../../escape.txt', content: 'x' }, ...worldEntries('w')]);
    expect(slip.status).toBe('failed');
    expect(slip.error).toContain('invalid entry');
    const link = await staged([{ name: 'w/link', content: '../../etc', mode: 0o120777 }, ...worldEntries('w')]);
    expect(link.status).toBe('failed');
    expect(await tmpEntries('imports')).toEqual([]);
    expect(await stat(path.join(env.config.dataDir, 'escape.txt')).catch(() => null)).toBeNull();
  });

  it('rejects archives without a world, Bedrock worlds and tar.gz bombs of entries', async () => {
    const none = await staged([{ name: 'readme.txt', content: 'hello' }]);
    expect(none.error).toContain('No Minecraft world');
    const bedrock = await staged([{ name: 'db/CURRENT', content: 'x' }, { name: 'levelname.txt', content: 'Bedrock' }]);
    expect(bedrock.error).toContain('Bedrock');
    const upl = await upload(buildTarGz(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, content: 'x' }))));
    expect((await waitJob(upl.body.import.id, ['failed', 'staged'])).status).toBe('failed');
    expect(await tmpEntries('imports')).toEqual([]);
  });

  it('imports a tar.gz archive as well', async () => {
    const res = await upload(buildTarGz(worldEntries('world', { versionName: '1.21.1' }).map((entry) => ({ name: entry.name, content: entry.content ?? '' }))));
    const job = await waitJob(res.body.import.id, ['staged', 'failed']);
    expect(job.status, job.error ?? '').toBe('staged');
    expect(job.analysis?.archive.format).toBe('tar.gz');
  });

  it('clears leftovers of interrupted imports at boot', async () => {
    const server = await env.addServer();
    await mkdir(path.join(env.config.dataDir, 'tmp', 'imports', 'old', 'content'), { recursive: true });
    await mkdir(path.join(env.serverDir(server.id), '.import-new-abc'), { recursive: true });
    await env.services.imports.recoverInterrupted();
    expect(await tmpEntries('imports')).toEqual([]);
    expect(await exists(server.id, '.import-new-abc')).toBe(false);
  });
});

describe('replacing the world of an existing server', () => {
  async function prepared(options: { loader?: 'vanilla' | 'paper' } = {}): Promise<string> {
    const server = await env.addServer(options.loader === undefined ? {} : { loader: options.loader });
    await write(server.id, 'server.properties', 'level-name=world\n');
    await write(server.id, 'world/level.dat', 'old');
    await write(server.id, 'world/region/r.0.0.mca', 'old-world');
    await write(server.id, 'world_nether/DIM-1/region/r.0.0.mca', 'altes-nether');
    return server.id;
  }

  it('creates a safety backup, replaces all folders and converts the layout for the server', async () => {
    const id = await prepared();
    const job = await staged(worldEntries('World', { versionName: '1.21.1', dims: 'split', name: 'New' }), `?serverId=${id}`);
    expect(job.mode).toBe('replace');
    const checked = await env.call<ImportReviewDto>('POST', `/api/imports/${job.id}/review`, {});
    expect(checked.body.notices.map((n) => n.code)).toEqual(expect.arrayContaining(['REPLACE_ONE_WAY']));
    const res = await env.call<{ import: ImportJobDto } & ErrorBody>('POST', `/api/servers/${id}/world/replace`, { importId: job.id, acknowledged: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const done = await waitJob(job.id, ['done', 'failed']);
    expect(done.status, done.error ?? '').toBe('done');
    expect(done.result?.safetyBackupId).not.toBeNull();
    expect(await read(id, 'world/region/r.0.0.mca')).toBe('overworld-region');
    expect(await read(id, 'world/DIM-1/region/r.0.0.mca')).toBe('nether-region');
    expect(await exists(id, 'world_nether')).toBe(false);
    expect((await readdir(env.serverDir(id))).filter((name) => name.startsWith('.import'))).toEqual([]);
    const list = await env.call<{ backups: Array<{ kind: string; status: string }> }>('GET', `/api/servers/${id}/backups`);
    expect(list.body.backups).toEqual([expect.objectContaining({ kind: 'safety', status: 'ok' })]);
    expect(await tmpEntries('imports')).toEqual([]);
  });

  it('uses the Paper layout for a Paper server', async () => {
    const id = await prepared({ loader: 'paper' });
    const job = await staged(worldEntries('x', { versionName: '1.21.1' }), `?serverId=${id}`);
    await env.call('POST', `/api/servers/${id}/world/replace`, { importId: job.id, acknowledged: [] });
    expect((await waitJob(job.id, ['done', 'failed'])).status).toBe('done');
    expect(await read(id, 'world_the_end/DIM1/region/r.0.0.mca')).toBe('end-region');
    expect(await exists(id, 'world/DIM1')).toBe(false);
  });

  it('refuses a newer world and keeps the old one', async () => {
    const id = await prepared();
    await env.t.db.update(servers).set({ mcVersion: '1.20.4' }).where(eq(servers.id, id));
    const job = await staged(worldEntries('x', { versionName: '1.21.1', dataVersion: 3955 }), `?serverId=${id}`);
    const res = await env.call<ErrorBody>('POST', `/api/servers/${id}/world/replace`, { importId: job.id, acknowledged: [] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WORLD_NEWER');
    expect(await read(id, 'world/region/r.0.0.mca')).toBe('old-world');
  });

  it('only works for stopped servers and for the server the upload was made for', async () => {
    const id = await prepared();
    const other = await prepared();
    await write(id, 'world/level.dat', 'old');
    expect((await env.call('POST', `/api/servers/${id}/start`)).status).toBe(200);
    await env.waitState(id, 'online');
    const running = await upload(buildZip(worldEntries('x')), `?serverId=${id}`);
    expect(running.status).toBe(409);
    expect(running.body.error.code).toBe('SERVER_RUNNING');
    await env.call('POST', `/api/servers/${id}/stop`);
    await env.waitState(id, 'offline');
    const job = await staged(worldEntries('x', { versionName: '1.21.1' }), `?serverId=${id}`);
    const wrong = await env.call<ErrorBody>('POST', `/api/servers/${other}/world/replace`, { importId: job.id, acknowledged: [] });
    expect(wrong.body.error.code).toBe('IMPORT_MODE');
    const missing = await upload(buildZip(worldEntries('x')), '?serverId=doesnotexist');
    expect(missing.status).toBe(404);
  });
});
