import { migrate } from 'drizzle-orm/libsql/migrator';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { MIGRATIONS_FOLDER, runMigrations } from '../src/db/migrate.js';
import { FakeModrinth } from './fake-modrinth.js';
import { testConfig } from './helpers.js';
import { scratchDir } from './server-env.js';

interface Journal {
  entries: Array<{ idx: number; tag: string }>;
}

let dir: string;
let handle: DbHandle;
beforeEach(async () => {
  dir = await scratchDir('upgrade-');
});
// the folder is removed by the global teardown: libsql keeps the file locked on Windows until the process ends
afterEach(() => {
  handle?.close();
});

// the migrations as they were before this release: every file up to and including 0001
async function previousMigrations(): Promise<string> {
  const target = path.join(dir, 'previous');
  await mkdir(path.join(target, 'meta'), { recursive: true });
  const journal = JSON.parse(await readFile(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((entry) => entry.idx <= 1);
  for (const entry of kept) await cp(path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), path.join(target, `${entry.tag}.sql`));
  await writeFile(path.join(target, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }));
  return target;
}

async function scalar(sql: string): Promise<unknown> {
  const result = await handle.client.execute(sql);
  return Object.values(result.rows[0] ?? {})[0];
}

async function seedPreviousSchema(): Promise<void> {
  const now = Date.now();
  await handle.client.execute({
    sql: `INSERT INTO servers (id, name, loader, mc_version, loader_version, install_state, install_error, launch_spec, required_java_major, port, java_path, min_ram_mb, max_ram_mb, use_aikar_flags, extra_jvm_args, eula_accepted, last_started_at, last_exit_code, created_at, updated_at)
          VALUES ('s-1', 'Überleben', 'fabric', '1.21.1', '0.16.14', 'installed', NULL, '{"kind":"jar","jar":"fabric-server-launch.jar"}', 21, 25570, 'C:/Java/bin/java.exe', 2048, 6144, 1, '-Dx=1', 1, ?, 0, ?, ?)`,
    args: [now - 5000, now - 10_000, now - 1000],
  });
  await handle.client.execute({
    sql: `INSERT INTO servers (id, name, loader, mc_version, install_state, port, min_ram_mb, max_ram_mb, use_aikar_flags, extra_jvm_args, eula_accepted, created_at, updated_at)
          VALUES ('s-2', 'Old', 'forge', '1.12.2', 'failed', 25571, 1024, 2048, 0, '', 0, ?, ?)`,
    args: [now - 9000, now - 900],
  });
  const mod = (id: string, serverId: string, file: string, hash: string, project: string | null): Promise<unknown> =>
    handle.client.execute({
      sql: `INSERT INTO mods (id, server_id, source, project_id, version_id, version_number, name, file_name, sha512, size_bytes, is_dependency, installed_at, updated_at)
            VALUES (?, ?, 'modrinth', ?, 'v1', '1.0', ?, ?, ?, 4096, ?, ?, ?)`,
      args: [id, serverId, project, `Mod ${id}`, file, hash, id === 'm-2' ? 1 : 0, now - 8000, now - 700],
    });
  await mod('m-1', 's-1', 'alpha.jar', 'hash-1', 'P1');
  await mod('m-2', 's-1', 'beta.jar', 'hash-2', 'P2');
  await mod('m-3', 's-2', 'gamma.jar', 'hash-3', null);
  await handle.client.execute({
    sql: `INSERT INTO mod_dependencies (mod_id, dependency_type, project_id, version_id, file_name, depends_on_mod_id) VALUES ('m-1', 'required', 'P2', NULL, NULL, 'm-2')`,
    args: [],
  });
  await handle.client.execute({
    sql: `INSERT INTO mod_update_log (server_id, mod_id, mod_name, from_version_id, to_version_id, from_file_name, to_file_name, backup_path, status, error, created_at)
          VALUES ('s-1', 'm-1', 'Mod m-1', 'v0', 'v1', 'alpha-0.jar', 'alpha.jar', 'mods_backup/alpha-0.jar', 'success', NULL, ?)`,
    args: [now - 4000],
  });
}

describe('upgrading a database from the previous schema', () => {
  it('keeps every row and value, and gives the new columns their defaults', async () => {
    handle = await openDb(path.join(dir, 'worldfoundry.db'));
    await migrate(handle.db, { migrationsFolder: await previousMigrations() });
    expect(await scalar("SELECT count(*) FROM pragma_table_info('mods') WHERE name = 'enabled'")).toBe(0);
    expect(await scalar("SELECT count(*) FROM sqlite_master WHERE name = 'backups'")).toBe(0);
    await seedPreviousSchema();
    const before = {
      servers: (await handle.client.execute('SELECT * FROM servers ORDER BY id')).rows.map((row) => ({ ...row })),
      mods: (await handle.client.execute('SELECT * FROM mods ORDER BY id')).rows.map((row) => ({ ...row })),
      deps: (await handle.client.execute('SELECT * FROM mod_dependencies')).rows.map((row) => ({ ...row })),
      log: (await handle.client.execute('SELECT * FROM mod_update_log')).rows.map((row) => ({ ...row })),
    };

    await runMigrations(handle.db);

    const after = {
      servers: (await handle.client.execute('SELECT * FROM servers ORDER BY id')).rows.map((row) => ({ ...row })),
      mods: (await handle.client.execute('SELECT * FROM mods ORDER BY id')).rows.map((row) => ({ ...row })),
      deps: (await handle.client.execute('SELECT * FROM mod_dependencies')).rows.map((row) => ({ ...row })),
      log: (await handle.client.execute('SELECT * FROM mod_update_log')).rows.map((row) => ({ ...row })),
    };
    // all old columns keep their values
    const keep = (rows: Array<Record<string, unknown>>, drop: string[]): Array<Record<string, unknown>> =>
      rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !drop.includes(key))));
    expect(keep(after.servers, ['auto_start', 'backup_interval_hours', 'backup_keep_last', 'backup_include_config', 'backup_schedule_since', 'install_error_ref', 'game', 'game_settings', 'backup_calendar'])).toEqual(before.servers);
    // servers from before WorldFoundry knew several games are Minecraft servers
    expect(after.servers.every((row) => row['game'] === 'minecraft')).toBe(true);
    expect(keep(after.mods, ['enabled'])).toEqual(before.mods);
    expect(after.deps).toEqual(before.deps);
    expect(keep(after.log, ['error_ref'])).toEqual(before.log);
    // rows written before message references existed simply have none
    expect(after.servers.every((row) => row['install_error_ref'] === null)).toBe(true);
    expect(after.log.every((row) => row['error_ref'] === null)).toBe(true);
    expect(after.servers).toHaveLength(2);
    expect(after.mods).toHaveLength(3);

    // new columns: mods stay switched on, nothing starts by itself, no schedule, seven backups would be kept
    expect(after.mods.every((row) => row['enabled'] === 1)).toBe(true);
    expect(after.servers.every((row) => row['auto_start'] === 0 && row['backup_interval_hours'] === null && row['backup_keep_last'] === 7)).toBe(true);
    expect(after.servers.every((row) => row['backup_include_config'] === 0 && row['backup_schedule_since'] === null)).toBe(true);
    expect(await scalar('SELECT count(*) FROM backups')).toBe(0);
    // the self-update tables of the newest migration exist and are empty
    expect(await scalar('SELECT count(*) FROM app_settings')).toBe(0);
    expect(await scalar('SELECT count(*) FROM update_history')).toBe(0);
    expect(await scalar('SELECT count(*) FROM __drizzle_migrations')).toBe(8);
  });

  it('keeps relationships working: foreign keys, cascades and the new table', async () => {
    handle = await openDb(path.join(dir, 'worldfoundry.db'));
    await migrate(handle.db, { migrationsFolder: await previousMigrations() });
    await seedPreviousSchema();
    await runMigrations(handle.db);
    await handle.client.execute({
      sql: `INSERT INTO backups (id, server_id, kind, status, file_name, level_name, created_at) VALUES ('b-1', 's-1', 'manual', 'ok', 'x.tar.gz', 'world', ?)`,
      args: [Date.now()],
    });
    await handle.client.execute("DELETE FROM servers WHERE id = 's-1'");
    expect(await scalar('SELECT count(*) FROM backups')).toBe(0);
    expect(await scalar('SELECT count(*) FROM mods')).toBe(1);
    expect(await scalar('SELECT count(*) FROM mod_dependencies')).toBe(0);
    expect(await scalar('SELECT count(*) FROM mod_update_log')).toBe(0);
  });

  it('is a no-op the second time and runs the application on the upgraded database', async () => {
    handle = await openDb(path.join(dir, 'worldfoundry.db'));
    await migrate(handle.db, { migrationsFolder: await previousMigrations() });
    await seedPreviousSchema();
    await runMigrations(handle.db);
    await runMigrations(handle.db);
    expect(await scalar('SELECT count(*) FROM __drizzle_migrations')).toBe(8);

    const app = buildApp({ db: handle.db, config: { ...testConfig(dir), javaAutoInstall: false }, modrinth: new FakeModrinth().api(), javaStandardRoots: [] });
    await app.ready();
    try {
      const servers = JSON.parse((await app.inject({ method: 'GET', url: '/api/servers' })).body) as { servers: Array<{ id: string; name: string; autoStart: boolean; backupKeepLast: number }> };
      expect(servers.servers.map((server) => [server.id, server.name, server.autoStart, server.backupKeepLast])).toEqual([
        ['s-1', 'Überleben', false, 7],
        ['s-2', 'Old', false, 7],
      ]);
      const mods = JSON.parse((await app.inject({ method: 'GET', url: '/api/servers/s-1/mods' })).body) as { mods: Array<{ id: string; enabled: boolean }> };
      expect(mods.mods.map((mod) => [mod.id, mod.enabled])).toEqual([
        ['m-1', true],
        ['m-2', true],
      ]);
      const list = JSON.parse((await app.inject({ method: 'GET', url: '/api/servers/s-1/backups' })).body) as { backups: unknown[]; schedule: unknown };
      expect(list).toMatchObject({ backups: [], schedule: { intervalHours: null, keepLast: 7, includeConfig: false } });
    } finally {
      await app.close();
    }
  });

  it('keeps the earlier migrations untouched while new ones are only added', async () => {
    const files = (await readdir(MIGRATIONS_FOLDER)).filter((name) => name.endsWith('.sql')).sort();
    expect(files).toHaveLength(8);
    expect(files.slice(0, 2)).toEqual(['0000_dazzling_onslaught.sql', '0001_dry_thunderbolt.sql']);
    // the line endings depend on the checkout (core.autocrlf), the content does not
    const earlier = (await readFile(path.join(MIGRATIONS_FOLDER, files[1] as string), 'utf8')).replace(/\r\n/g, '\n');
    expect(earlier).toBe(
      'ALTER TABLE `servers` ADD `launch_spec` text;--> statement-breakpoint\nALTER TABLE `servers` ADD `required_java_major` integer;',
    );
  });
});
