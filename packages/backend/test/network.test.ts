import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { servers } from '../src/db/schema.js';
import { accessUrls, describeAccess, detectAddresses, getLanUrls, isLinkLocalIPv4, isPrivateIPv4, isVirtualInterface, localIPv4Addresses, type Interfaces } from '../src/lib/network.js';
import { listenWithFallback } from '../src/network/boot.js';
import { effectiveNetwork, normalizeAllowedHost, normalizePublicAddress, sameNetwork } from '../src/network/settings.js';
import { RESTART_EXIT_CODE } from '../src/system/restart.js';
import { ServerEnv, freePort, waitFor } from './server-env.js';

interface ErrorBody {
  error: { code: string; message: string };
}

interface LanCase {
  name: string;
  interfaces: Interfaces;
  lan: Array<[string, string, boolean]>;
  virtual: Array<[string, string, boolean]>;
}

const cases = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'test', 'lan-cases.json'), 'utf8')) as LanCase[];

describe('detecting the addresses of this machine', () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      const detected = detectAddresses(testCase.interfaces);
      expect(detected.lan.map((entry) => [entry.address, entry.interfaceName, entry.private])).toEqual(testCase.lan);
      expect(detected.virtual.map((entry) => [entry.address, entry.interfaceName, entry.private])).toEqual(testCase.virtual);
    });
  }

  it('classifies private and link-local ranges exactly', () => {
    for (const address of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.1']) expect(isPrivateIPv4(address), address).toBe(true);
    for (const address of ['172.15.0.1', '172.32.0.1', '192.169.0.1', '11.0.0.1', '100.64.0.1', 'not-an-ip', '::1']) expect(isPrivateIPv4(address), address).toBe(false);
    expect(isLinkLocalIPv4('169.254.1.1')).toBe(true);
    expect(isLinkLocalIPv4('169.253.1.1')).toBe(false);
  });

  it('recognises virtual adapters by name and keeps ordinary ones', () => {
    for (const name of ['vEthernet (WSL)', 'docker0', 'br-abc123', 'veth12', 'virbr0', 'VirtualBox Host-Only Network', 'vboxnet0', 'VMware Network Adapter VMnet1', 'vmnet8', 'Tailscale', 'tailscale0', 'ZeroTier One', 'wg0', 'tun0', 'tap0', 'utun3', 'OpenVPN Data Channel Offload']) {
      expect(isVirtualInterface(name), name).toBe(true);
    }
    for (const name of ['Ethernet', 'Ethernet 2', 'WLAN', 'Wi-Fi', 'eth0', 'enp3s0', 'wlan0', 'en0', 'bond0']) expect(isVirtualInterface(name), name).toBe(false);
  });

  it('builds the access URLs from the bind address', () => {
    const detected = detectAddresses(cases[0]?.interfaces as Interfaces);
    expect(accessUrls('0.0.0.0', 3000, detected)).toEqual(['http://192.168.178.20:3000']);
    expect(accessUrls('192.168.178.20', 3100, detected)).toEqual(['http://192.168.178.20:3100']);
    expect(accessUrls('127.0.0.1', 3000, detected)).toEqual(['http://127.0.0.1:3000', 'http://localhost:3000']);
    expect(getLanUrls(80, (cases[1] as LanCase).interfaces)).toEqual(['http://10.0.0.5:80']);
    expect(localIPv4Addresses((cases[0] as LanCase).interfaces).sort()).toEqual(['127.0.0.1', '169.254.10.4', '172.28.16.1', '192.168.178.20']);
  });

  it('describes the access for the start log, listing virtual adapters separately', () => {
    const detected = detectAddresses((cases[0] as LanCase).interfaces);
    expect(describeAccess('0.0.0.0', 3000, detected, 'DESKTOP')).toBe(
      'http://192.168.178.20:3000 (Host name: http://DESKTOP:3000; VPN/virtual: http://172.28.16.1:3000 [vEthernet (WSL (Hyper-V firewall))])',
    );
    expect(describeAccess('192.168.178.20', 3000, detected, 'DESKTOP')).toBe('http://192.168.178.20:3000');
    expect(describeAccess('127.0.0.1', 3000, detected, 'DESKTOP')).toContain('this machine only');
    expect(describeAccess('0.0.0.0', 3000, { lan: [], virtual: [] }, 'DESKTOP')).toContain('no LAN address');
  });
});

describe('settings values', () => {
  it('normalises host names and rejects everything that is not one', () => {
    expect(normalizeAllowedHost('Minecraft.Fritz.Box')).toBe('minecraft.fritz.box');
    expect(normalizeAllowedHost(' pc.lan:3000 ')).toBe('pc.lan');
    for (const bad of ['', 'http://pc.lan', 'pc.lan/path', 'a b', 'user@pc.lan', '-bad-.lan', 'x'.repeat(300)]) expect(normalizeAllowedHost(bad), bad).toBeNull();
  });

  it('normalises the public address', () => {
    expect(normalizePublicAddress('minecraft.fritz.box')).toEqual({ url: 'http://minecraft.fritz.box', hostname: 'minecraft.fritz.box' });
    expect(normalizePublicAddress('http://PC.lan:3000/')).toEqual({ url: 'http://pc.lan:3000', hostname: 'pc.lan' });
    expect(normalizePublicAddress('192.168.178.20:3100')).toEqual({ url: 'http://192.168.178.20:3100', hostname: '192.168.178.20' });
    for (const bad of ['', 'ftp://x', 'pc.lan:99999', 'pc.lan/path', 'javascript:alert(1)']) expect(normalizePublicAddress(bad), bad).toBeNull();
  });

  it('lets stored values replace the config file and allows the public host automatically', () => {
    const defaults = { host: '0.0.0.0', port: 3000, allowedHosts: ['craft.lan'] };
    expect(effectiveNetwork(defaults, {})).toEqual(defaults);
    const effective = effectiveNetwork(defaults, { bindHost: '192.168.1.5', port: 3100, allowedHosts: ['mc.fritz.box', 'craft.lan'], publicAddress: 'http://play.fritz.box:3100' });
    expect(effective).toEqual({ host: '192.168.1.5', port: 3100, allowedHosts: ['craft.lan', 'mc.fritz.box', 'play.fritz.box'] });
    expect(sameNetwork(effective, { ...effective, allowedHosts: [...effective.allowedHosts].reverse() })).toBe(true);
    expect(sameNetwork(effective, defaults)).toBe(false);
  });
});

describe('binding with fallbacks', () => {
  const failure = (code: string): Error => Object.assign(new Error(code), { code });

  it('binds as planned when possible', async () => {
    const calls: Array<{ host: string; port: number }> = [];
    const result = await listenWithFallback(async (options) => void calls.push(options), { host: '192.168.1.5', port: 3100, defaultPort: 3000 });
    expect(result).toEqual({ host: '192.168.1.5', port: 3100, warnings: [], warningRefs: [] });
    expect(calls).toEqual([{ host: '192.168.1.5', port: 3100 }]);
  });

  it('falls back to all adapters when the address does not exist', async () => {
    const calls: string[] = [];
    const result = await listenWithFallback(
      async ({ host }) => {
        calls.push(host);
        if (host !== '0.0.0.0') throw failure('EADDRNOTAVAIL');
      },
      { host: '10.9.9.9', port: 3000, defaultPort: 3000 },
    );
    expect(calls).toEqual(['10.9.9.9', '0.0.0.0']);
    expect(result.host).toBe('0.0.0.0');
    expect(result.warnings[0]).toContain('10.9.9.9');
    expect(result.warnings[0]).toContain('does not exist');
  });

  it('falls back to the configured port when the stored one is taken, and fails when that is taken too', async () => {
    const result = await listenWithFallback(
      async ({ port }) => {
        if (port === 3100) throw failure('EADDRINUSE');
      },
      { host: '0.0.0.0', port: 3100, defaultPort: 3000 },
    );
    expect(result.port).toBe(3000);
    expect(result.warnings[0]).toContain('3100');
    await expect(listenWithFallback(async () => Promise.reject(failure('EADDRINUSE')), { host: '0.0.0.0', port: 3000, defaultPort: 3000 })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await expect(listenWithFallback(async () => Promise.reject(failure('EACCES')), { host: '0.0.0.0', port: 80, defaultPort: 3000 })).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('does not widen loopback to all adapters', async () => {
    await expect(listenWithFallback(async () => Promise.reject(failure('EADDRNOTAVAIL')), { host: '127.0.0.1', port: 3000, defaultPort: 3000 })).rejects.toMatchObject({ code: 'EADDRNOTAVAIL' });
  });

  it('really recovers from a missing address with the real server', async () => {
    const env = await ServerEnv.create();
    try {
      const port = await freePort();
      const result = await listenWithFallback((options) => env.app.listen(options), { host: '10.254.254.254', port, defaultPort: port });
      expect(result.host).toBe('0.0.0.0');
      expect(result.warnings).toHaveLength(1);
      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(health.status).toBe(200);
    } finally {
      await env.close();
    }
  });
});

describe('network API', () => {
  let env: ServerEnv;
  const interfaces = (cases[0] as LanCase).interfaces;
  const exits: number[] = [];

  async function start(options: { token?: string } = {}): Promise<ServerEnv> {
    exits.length = 0;
    env = await ServerEnv.create({
      ...(options.token === undefined ? {} : { authToken: options.token }),
      config: { host: '0.0.0.0', port: 3999 },
      network: { interfaces: () => interfaces, hostname: () => 'MCPC' },
      restart: { exit: (code) => void exits.push(code), delayMs: 5 },
      portProbe: async (port) => (port === 3555 ? 'in-use' : port === 80 ? 'denied' : 'free'),
    });
    return env;
  }

  afterEach(async () => {
    await env.close();
  });

  it('lists the LAN addresses, virtual adapters and the machine name', async () => {
    await start();
    const res = await env.call<import('../src/contract.js').NetworkState>('GET', '/api/system/network');
    expect(res.status).toBe(200);
    expect(res.body.hostname).toBe('MCPC');
    expect(res.body.hostnameUrl).toBe('http://MCPC:3999');
    expect(res.body.lan.map((entry) => entry.url)).toEqual(['http://192.168.178.20:3999']);
    expect(res.body.virtual.map((entry) => entry.interfaceName)).toEqual(['vEthernet (WSL (Hyper-V firewall))']);
    expect(res.body.active).toMatchObject({ host: '0.0.0.0', port: 3999, urls: ['http://192.168.178.20:3999'] });
    expect(res.body.settings).toEqual({ bindHost: null, port: null, allowedHosts: [], publicAddress: null });
    expect(res.body.restartRequired).toBe(false);
    expect(res.body.restart.automatic).toBe(false);
  });

  it('shows only the chosen address when bound to one IP', async () => {
    await start();
    const saved = await env.call<import('../src/contract.js').NetworkState>('PUT', '/api/system/network', { bindHost: '192.168.178.20' });
    expect(saved.status).toBe(200);
    expect(saved.body.pending).toMatchObject({ host: '192.168.178.20', urls: ['http://192.168.178.20:3999'] });
    expect(saved.body.restartRequired).toBe(true);
    // the running process is unchanged until the restart
    expect(saved.body.active.host).toBe('0.0.0.0');
  });

  it('stores the settings in the database and reports a pending restart', async () => {
    await start();
    const saved = await env.call<import('../src/contract.js').NetworkState>('PUT', '/api/system/network', {
      bindHost: '192.168.178.20',
      port: 4100,
      allowedHosts: ['Minecraft.Fritz.Box', 'minecraft.fritz.box'],
      publicAddress: 'play.fritz.box:4100',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.settings).toEqual({ bindHost: '192.168.178.20', port: 4100, allowedHosts: ['minecraft.fritz.box'], publicAddress: 'http://play.fritz.box:4100' });
    expect(saved.body.pending.allowedHosts).toEqual(['minecraft.fritz.box', 'play.fritz.box']);
    expect(saved.body.restartRequired).toBe(true);
    const again = await env.call<import('../src/contract.js').NetworkState>('GET', '/api/system/network');
    expect(again.body.settings).toEqual(saved.body.settings);
    // resetting to the config file values
    const reset = await env.call<import('../src/contract.js').NetworkState>('PUT', '/api/system/network', { bindHost: null, port: null, allowedHosts: [], publicAddress: null });
    expect(reset.body.settings).toEqual({ bindHost: null, port: null, allowedHosts: [], publicAddress: null });
    expect(reset.body.restartRequired).toBe(false);
  });

  it('rejects an address that this machine does not have', async () => {
    await start();
    const res = await env.call<ErrorBody>('PUT', '/api/system/network', { bindHost: '10.99.99.99' });
    expect([res.status, res.body.error.code]).toEqual([422, 'NETWORK_ADDRESS_UNKNOWN']);
    expect(res.body.error.message).toContain('192.168.178.20');
    expect((await env.call<ErrorBody>('PUT', '/api/system/network', { bindHost: 'pc.lan' })).body.error.code).toBe('NETWORK_ADDRESS_INVALID');
    // all adapters and this PC only are always fine
    expect((await env.call('PUT', '/api/system/network', { bindHost: '127.0.0.1' })).status).toBe(200);
    expect((await env.call('PUT', '/api/system/network', { bindHost: '0.0.0.0' })).status).toBe(200);
  });

  it('validates the port: range, taken by another program, taken by a Minecraft server, no permission', async () => {
    await start();
    for (const port of [0, 70000, 3.5, -1]) {
      const res = await env.call<ErrorBody>('PUT', '/api/system/network', { port });
      expect([port, res.status, res.body.error.code]).toEqual([port, 422, 'NETWORK_PORT_INVALID']);
    }
    expect((await env.call<ErrorBody>('PUT', '/api/system/network', { port: 3555 })).body.error.code).toBe('NETWORK_PORT_IN_USE');
    expect((await env.call<ErrorBody>('PUT', '/api/system/network', { port: 80 })).body.error.code).toBe('NETWORK_PORT_DENIED');
    await env.t.db.insert(servers).values({ id: 's1', name: 'Survival', loader: 'vanilla', mcVersion: '1.21.1', port: 25570, createdAt: new Date(), updatedAt: new Date() });
    const clash = await env.call<ErrorBody>('PUT', '/api/system/network', { port: 25570 });
    expect(clash.body.error.code).toBe('NETWORK_PORT_IN_USE');
    expect(clash.body.error.message).toContain('Survival');
    // the port the process uses right now is not "taken"
    expect((await env.call('PUT', '/api/system/network', { port: 3999 })).status).toBe(200);
    expect((await env.call('PUT', '/api/system/network', { port: 4200 })).status).toBe(200);
  });

  it('validates host names and the public address', async () => {
    await start();
    const hosts = await env.call<ErrorBody>('PUT', '/api/system/network', { allowedHosts: ['good.fritz.box', 'http://bad'] });
    expect([hosts.status, hosts.body.error.code]).toEqual([422, 'NETWORK_HOST_INVALID']);
    expect(hosts.body.error.message).toContain('http://bad');
    const publicAddress = await env.call<ErrorBody>('PUT', '/api/system/network', { publicAddress: 'ftp://x' });
    expect([publicAddress.status, publicAddress.body.error.code]).toEqual([422, 'NETWORK_PUBLIC_INVALID']);
    // nothing was stored by the failed calls
    expect((await env.call<import('../src/contract.js').NetworkState>('GET', '/api/system/network')).body.settings.allowedHosts).toEqual([]);
  });

  it('needs a login, and the restart needs an explicit confirmation', async () => {
    await start({ token: 'secret-12345' });
    for (const [method, url] of [
      ['GET', '/api/system/network'],
      ['PUT', '/api/system/network'],
      ['POST', '/api/system/restart'],
    ] as const) {
      expect((await env.call<ErrorBody>(method, url, method === 'GET' ? undefined : {})).status, `${method} ${url}`).toBe(401);
    }
    const auth = { Authorization: 'Bearer secret-12345' };
    const unconfirmed = await env.call<ErrorBody>('POST', '/api/system/restart', {}, auth);
    expect([unconfirmed.status, unconfirmed.body.error.code]).toEqual([422, 'RESTART_CONFIRM_REQUIRED']);
    expect(exits).toEqual([]);
  });

  it('restarts: remembers the running servers, announces it, exits with the restart code and starts them again after the boot', async () => {
    await start();
    const server = await env.addServer();
    await env.call('POST', `/api/servers/${server.id}/start`);
    await env.waitState(server.id, 'online');
    const events: string[] = [];
    env.services.bus.subscribe((event) => void (event.type === 'system.restarting' && events.push(...event.urls)));
    await env.call('PUT', '/api/system/network', { port: 4300 });

    const res = await env.call<import('../src/contract.js').RestartPlan>('POST', '/api/system/restart', { confirm: true });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ restarting: true, automatic: false });
    expect(res.body.urls).toContain('http://192.168.178.20:4300');
    expect(res.body.urls).toContain('http://MCPC:4300');
    expect(events).toEqual(res.body.urls);
    await waitFor(() => exits.length > 0 || undefined);
    expect(exits).toEqual([RESTART_EXIT_CODE]);
    expect((await env.call<ErrorBody>('POST', '/api/system/restart', { confirm: true })).body.error.code).toBe('RESTART_IN_PROGRESS');

    // the "next boot": the recorded servers are started once, the record is gone afterwards
    await env.services.manager.stop(server.id);
    await env.waitState(server.id, 'offline');
    const report = await env.services.restart.resumeServers();
    expect(report.started).toEqual([server.id]);
    await env.waitState(server.id, 'online');
    expect(await env.services.restart.resumeServers()).toEqual({ started: [], failed: [] });
  });

  it('has no restart when the application is embedded without an exit handler', async () => {
    env = await ServerEnv.create({});
    const res = await env.call<ErrorBody>('POST', '/api/system/restart', { confirm: true });
    expect([res.status, res.body.error.code]).toEqual([501, 'RESTART_UNSUPPORTED']);
  });

  it('refuses the restart while an update runs', async () => {
    await start();
    const update = env.services.update as unknown as { phase: string };
    update.phase = 'installing';
    const res = await env.call<ErrorBody>('POST', '/api/system/restart', { confirm: true });
    expect([res.status, res.body.error.code]).toEqual([409, 'UPDATE_IN_PROGRESS']);
    expect(exits).toEqual([]);
    update.phase = 'idle';
  });

  it('puts the active URLs into the authenticated health answer', async () => {
    await start({ token: 'secret-12345' });
    const health = await env.call<{ lanUrls?: string[] }>('GET', '/api/health', undefined, { Authorization: 'Bearer secret-12345' });
    expect(health.body.lanUrls).toEqual(['http://192.168.178.20:3999']);
    expect(((await env.call('GET', '/api/health')).body as { lanUrls?: string[] }).lanUrls).toBeUndefined();
  });

  it('really probes a taken port with the real probe', async () => {
    env = await ServerEnv.create({ config: { host: '0.0.0.0', port: 3999 } });
    const blocker = net.createServer();
    const port = await freePort();
    await new Promise<void>((resolve) => blocker.listen(port, '0.0.0.0', resolve));
    try {
      const res = await env.call<ErrorBody>('PUT', '/api/system/network', { port });
      expect([res.status, res.body.error.code]).toEqual([422, 'NETWORK_PORT_IN_USE']);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
