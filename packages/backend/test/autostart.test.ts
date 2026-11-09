import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { servers, type NewServer } from '../src/db/schema.js';
import { serializeLaunchSpec } from '../src/installer/launch-spec.js';
import { managedKit, type ManagedKit } from './fake-adoptium.js';
import { ServerEnv, freePort, waitFor } from './server-env.js';

let env: ServerEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

interface ErrorBody {
  error: { code: string; message: string };
}

async function row(config: { serversDir: string }, overrides: Partial<NewServer> & { id: string }): Promise<NewServer> {
  await mkdir(path.join(config.serversDir, overrides.id), { recursive: true });
  await writeFile(path.join(config.serversDir, overrides.id, 'server.jar'), 'jar');
  return {
    name: `Server ${overrides.id}`,
    loader: 'vanilla',
    mcVersion: '1.21.1',
    installState: 'installed',
    launchSpec: serializeLaunchSpec({ kind: 'jar', jar: 'server.jar' }),
    requiredJavaMajor: 21,
    eulaAccepted: true,
    autoStart: true,
    port: await freePort(),
    createdAt: new Date(Date.now() + Number(overrides.id.replace(/\D/g, '')) * 1000),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('autostart at boot', () => {
  it('starts the marked servers after the application is up, without blocking it', async () => {
    env = await ServerEnv.create({
      prepare: async ({ t, config }) => {
        await t.db.insert(servers).values([await row(config, { id: 'auto-1' }), await row(config, { id: 'auto-2' }), await row(config, { id: 'manual-3', autoStart: false })]);
      },
    });
    await Promise.all([env.waitState('auto-1', 'online'), env.waitState('auto-2', 'online')]);
    expect(env.services.manager.status('manual-3').state).toBe('offline');
    expect(env.spawner.calls).toHaveLength(2);
  });

  it('starts one after the other, in creation order', async () => {
    env = await ServerEnv.create({
      prepare: async ({ t, config }) => {
        await t.db.insert(servers).values([await row(config, { id: 'a-2' }), await row(config, { id: 'a-1' }), await row(config, { id: 'a-3' })]);
      },
    });
    await waitFor(() => env!.spawner.calls.length === 3, 8000, 'three starts');
    expect(env.spawner.calls.map((call) => path.basename(call.cwd))).toEqual(['a-1', 'a-2', 'a-3']);
  });

  it('skips servers without accepted EULA or without a finished installation, and does not touch their EULA file', async () => {
    env = await ServerEnv.create({
      prepare: async ({ t, config }) => {
        await t.db.insert(servers).values([
          await row(config, { id: 'no-eula', eulaAccepted: false }),
          await row(config, { id: 'pending-2', installState: 'pending' }),
          await row(config, { id: 'ok-3' }),
        ]);
      },
    });
    await env.waitState('ok-3', 'online');
    expect(env.services.manager.status('no-eula').state).toBe('offline');
    expect(env.services.manager.status('pending-2').state).toBe('offline');
    expect(env.spawner.calls).toHaveLength(1);
  });

  it('shows a failure as that server\'s status and does not stop the others', async () => {
    const taken = await freePort();
    env = await ServerEnv.create({
      prepare: async ({ t, config }) => {
        await t.db.insert(servers).values([
          await row(config, { id: 'bad-1', launchSpec: serializeLaunchSpec({ kind: 'jar', jar: 'missing.jar' }) }),
          await row(config, { id: 'first-2', port: taken }),
          await row(config, { id: 'clash-3', port: taken }),
          await row(config, { id: 'good-4' }),
        ]);
      },
    });
    await Promise.all([env.waitState('first-2', 'online'), env.waitState('good-4', 'online'), env.waitState('bad-1', 'crashed'), env.waitState('clash-3', 'crashed')]);
    expect(env.services.manager.status('bad-1').message).toContain('start file');
    expect(env.services.manager.status('clash-3').message).toContain('Port');
    const texts = env.services.manager.history('clash-3').map((line) => line.text);
    expect(texts.some((text) => text.startsWith('The server could not be started: Autostart failed'))).toBe(true);
    // a failed autostart is not "running": the server can be started by hand afterwards
    expect(env.services.manager.isRunning('clash-3')).toBe(false);
  });

  it('installs a missing Java first and only then goes on with the next server', async () => {
    let kit: ManagedKit | undefined;
    env = await ServerEnv.create({
      javaService: (dataDir) => {
        kit = managedKit(dataDir, { platform: 'win32', arch: 'x64' });
        kit.adoptium.add({ major: 21, os: 'windows', arch: 'x64', image: 'jre' });
        kit.adoptium.downloadDelayMs = 250;
        return kit.java;
      },
      prepare: async ({ t, config }) => {
        await t.db.insert(servers).values([await row(config, { id: 'j-1' }), await row(config, { id: 'j-2' })]);
      },
    });
    // the application is already up (create() returned) while the runtime is still being installed
    await env.waitState('j-1', 'preparing', 5000);
    expect(env.spawner.calls).toHaveLength(0);
    expect(env.services.manager.status('j-2').state).toBe('offline');
    await Promise.all([env.waitState('j-1', 'online', 15_000), env.waitState('j-2', 'online', 15_000)]);
    expect(kit?.adoptium.requests.filter((request) => request.includes('release-assets'))).toHaveLength(1);
    expect(env.spawner.calls.map((call) => path.basename(call.cwd))).toEqual(['j-1', 'j-2']);
  });

  it('shows a failed Java installation as the status of the server and goes on', async () => {
    let kit: ManagedKit | undefined;
    env = await ServerEnv.create({
      javaService: (dataDir) => {
        kit = managedKit(dataDir, { platform: 'win32', arch: 'x64' });
        kit.adoptium.add({ major: 21, os: 'windows', arch: 'x64', image: 'jre' });
        kit.adoptium.tamper = true;
        return kit.java;
      },
      prepare: async ({ t, config }) => {
        await t.db.insert(servers).values([await row(config, { id: 'j-1' }), await row(config, { id: 'j-2' })]);
      },
    });
    await Promise.all([env.waitState('j-1', 'crashed', 15_000), env.waitState('j-2', 'crashed', 15_000)]);
    expect(env.services.manager.status('j-1').message).toContain('checksum');
    expect(env.spawner.calls).toHaveLength(0);
  });
});

describe('the autostart setting', () => {
  it('is part of the server and changes through PATCH', async () => {
    env = await ServerEnv.create();
    const server = await env.addServer();
    expect((await env.call<{ server: { autoStart: boolean } }>('GET', `/api/servers/${server.id}`)).body.server.autoStart).toBe(false);
    const res = await env.call<{ server: { autoStart: boolean }; restartRequired: boolean }>('PATCH', `/api/servers/${server.id}`, { autoStart: true });
    expect(res.status).toBe(200);
    expect(res.body.server.autoStart).toBe(true);
    expect(res.body.restartRequired).toBe(false);
    expect((await env.row(server.id))?.autoStart).toBe(true);
    expect((await env.call<ErrorBody>('PATCH', `/api/servers/${server.id}`, { autoStart: 'ja' })).status).toBe(400);
  });

  it('run() reports what it did and can be called again', async () => {
    env = await ServerEnv.create();
    const server = await env.addServer({ autoStart: true });
    const report = await env.services.autostart.run();
    expect(report).toEqual({ started: [server.id], skipped: [], failed: [] });
    await env.waitState(server.id, 'online');
    const again = await env.services.autostart.run();
    expect(again).toEqual({ started: [], skipped: [server.id], failed: [] });
    expect(env.services.manager.status(server.id).state).toBe('online');
  });
});
