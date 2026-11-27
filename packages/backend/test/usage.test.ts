import { describe, expect, it } from 'vitest';
import { UsageMonitor, cpuBetween, type UsageSources } from '../src/system/usage.js';
import { ServerEnv } from './server-env.js';

function sources(overrides: Partial<UsageSources> = {}): UsageSources & { tick: () => void; running: Map<string, { cpuPercent: number; rssBytes: number }> } {
  let clock = 1_000_000;
  let idle = 0;
  let total = 0;
  const running = new Map<string, { cpuPercent: number; rssBytes: number }>();
  return {
    running,
    tick: () => {
      clock += 5000;
      // four cores, a quarter of the time busy
      total += 4000;
      idle += 3000;
    },
    cpuTimes: () => ({ idle, total }),
    totalMemory: () => 16 * 1024 ** 3,
    freeMemory: () => 10 * 1024 ** 3,
    loadAverage: () => [1.234, 0.5, 0.25],
    uptimeSeconds: () => 3600.4,
    disk: async () => ({ totalBytes: 100, freeBytes: 40 }),
    servers: () => [...running].map(([serverId, value]) => ({ serverId, ...value })),
    ownMemory: () => 80 * 1024 ** 2,
    now: () => clock,
    ...overrides,
  };
}

describe('usage monitor', () => {
  it('works out the CPU share between two readings', () => {
    expect(cpuBetween({ idle: 0, total: 0 }, { idle: 750, total: 1000 })).toBe(25);
    expect(cpuBetween({ idle: 0, total: 0 }, { idle: 0, total: 0 })).toBeNull();
  });

  it('keeps a window of host and server samples and forgets stopped servers once they aged out', async () => {
    const src = sources();
    const monitor = new UsageMonitor(src, 5000, 3);
    src.running.set('a', { cpuPercent: 12.5, rssBytes: 2048 });
    for (let i = 0; i < 4; i++) {
      src.tick();
      await monitor.sample();
    }
    const snap = monitor.snapshot();
    expect(snap.samples).toHaveLength(3);
    expect(snap.samples.every((point) => point.cpuPercent === 25 && point.memoryUsedBytes === 6 * 1024 ** 3)).toBe(true);
    expect(snap.host).toMatchObject({ totalMemoryBytes: 16 * 1024 ** 3, uptimeSeconds: 3600, disk: { totalBytes: 100, freeBytes: 40 }, appMemoryBytes: 80 * 1024 ** 2 });
    if (process.platform !== 'win32') expect(snap.host.loadAverage).toEqual([1.23, 0.5, 0.25]);
    expect(snap.servers).toEqual([{ serverId: 'a', samples: [expect.objectContaining({ cpuPercent: 12.5, rssBytes: 2048 }), expect.anything(), expect.anything()] }]);

    src.running.clear();
    src.tick();
    await monitor.sample();
    expect(monitor.snapshot().servers.map((entry) => entry.serverId)).toEqual(['a']);
    for (let i = 0; i < 4; i++) {
      src.tick();
      await monitor.sample();
    }
    expect(monitor.snapshot().servers).toEqual([]);
  });

  it('answers GET /api/system/usage', async () => {
    const env = await ServerEnv.create();
    try {
      const res = await env.call<{ intervalMs: number; host: { cpuCount: number }; samples: unknown[] }>('GET', '/api/system/usage');
      expect(res.status).toBe(200);
      expect(res.body.intervalMs).toBeGreaterThan(0);
      expect(res.body.host.cpuCount).toBeGreaterThan(0);
      expect(Array.isArray(res.body.samples)).toBe(true);
    } finally {
      await env.close();
    }
  });
});
