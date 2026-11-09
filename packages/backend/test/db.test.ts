import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { modDependencies, modUpdateLog, mods, servers } from '../src/db/schema.js';
import { createTestDb, modRow, serverRow, type TestDb } from './helpers.js';

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.cleanup();
});

const now = () => new Date();

describe('Foreign keys', () => {
  it('cascades server deletion after a transaction has run first', async () => {
    // a transaction first: libsql may drop/reopen its connection afterwards
    await t.db.transaction(async (tx) => {
      await tx.insert(servers).values(serverRow('s1'));
    });
    await t.db.insert(servers).values(serverRow('s2'));
    await t.db.insert(mods).values([modRow('m1', 's1'), modRow('m2', 's1'), modRow('m3', 's2')]);
    await t.db.insert(modDependencies).values({ modId: 'm1', dependencyType: 'required', dependsOnModId: 'm2' });
    await t.db
      .insert(modUpdateLog)
      .values({ serverId: 's1', modId: 'm1', modName: 'Mod m1', status: 'success', createdAt: now() });

    await t.db.delete(servers).where(eq(servers.id, 's1'));

    expect(await t.db.select().from(mods)).toHaveLength(1);
    expect(await t.db.select().from(modDependencies)).toHaveLength(0);
    expect(await t.db.select().from(modUpdateLog)).toHaveLength(0);
  });

  it('rejects rows pointing at a missing server', async () => {
    await t.db.transaction(async (tx) => {
      await tx.insert(servers).values(serverRow('s1'));
    });
    await expect(t.db.insert(mods).values(modRow('m1', 'missing'))).rejects.toThrow();
  });

  it('sets references to NULL when a mod is deleted and keeps the update log', async () => {
    await t.db.insert(servers).values(serverRow('s1'));
    await t.db.insert(mods).values([modRow('m1', 's1'), modRow('m2', 's1')]);
    await t.db.insert(modDependencies).values({ modId: 'm1', dependencyType: 'required', dependsOnModId: 'm2' });
    await t.db
      .insert(modUpdateLog)
      .values({ serverId: 's1', modId: 'm2', modName: 'Mod m2', status: 'failed', error: 'x', createdAt: now() });

    await t.db.delete(mods).where(eq(mods.id, 'm2'));

    const [dep] = await t.db.select().from(modDependencies);
    expect(dep?.dependsOnModId).toBeNull();
    const [log] = await t.db.select().from(modUpdateLog);
    expect(log?.modId).toBeNull();
    expect(log?.modName).toBe('Mod m2');

    await t.db.delete(mods).where(eq(mods.id, 'm1'));
    expect(await t.db.select().from(modDependencies)).toHaveLength(0);
    expect(await t.db.select().from(modUpdateLog)).toHaveLength(1);
  });
});

describe('Mod unique constraints', () => {
  beforeEach(async () => {
    await t.db.insert(servers).values([serverRow('s1'), serverRow('s2')]);
    await t.db.insert(mods).values(modRow('m1', 's1'));
  });

  it('rejects duplicate file_name per server', async () => {
    await expect(
      t.db.insert(mods).values(modRow('m2', 's1', { fileName: 'm1.jar' })),
    ).rejects.toThrow();
  });

  it('rejects duplicate sha512 per server', async () => {
    await expect(t.db.insert(mods).values(modRow('m2', 's1', { sha512: 'sha-m1' }))).rejects.toThrow();
  });

  it('rejects duplicate project_id per server', async () => {
    await expect(
      t.db.insert(mods).values(modRow('m2', 's1', { projectId: 'project-m1' })),
    ).rejects.toThrow();
  });

  it('allows the same mod on a different server', async () => {
    await t.db.insert(mods).values(modRow('m3', 's2', { fileName: 'm1.jar', sha512: 'sha-m1', projectId: 'project-m1' }));
    expect(await t.db.select().from(mods)).toHaveLength(2);
  });

  it('lets two manual mods with NULL project_id coexist', async () => {
    await t.db.insert(mods).values([
      modRow('a', 's1', { source: 'manual', projectId: null }),
      modRow('b', 's1', { source: 'manual', projectId: null }),
    ]);
    expect(await t.db.select().from(mods)).toHaveLength(3);
  });
});

describe('Write serialization', () => {
  it('lets concurrent transactions that hold the write lock across awaits all succeed', async () => {
    const hold = (id: string, ms: number) =>
      t.db.transaction(async (tx) => {
        await tx.insert(servers).values(serverRow(id));
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
    const results = await Promise.allSettled([hold('a', 150), hold('b', 5), hold('c', 5)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect(await t.db.select().from(servers)).toHaveLength(3);
  });
});
