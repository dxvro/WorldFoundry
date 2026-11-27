import os from 'node:os';
import type { UsageResponse, UsagePoint, ServerUsagePoint } from '../contract.js';
import { diskUsage } from '../lib/disk.js';

export type { UsageResponse, UsagePoint, ServerUsagePoint };

// How busy the machine and each server are: sampled every few seconds and kept for a while, so the usage page shows a
// history right away. CPU of the host comes from the times of all cores (the same on Windows and Linux); the servers'
// CPU and memory are the numbers the process manager measures anyway.
export const DEFAULT_INTERVAL_MS = 5_000;
export const DEFAULT_KEEP = 120;

export interface CpuTimes {
  idle: number;
  total: number;
}

export interface UsageSources {
  cpuTimes: () => CpuTimes;
  totalMemory: () => number;
  freeMemory: () => number;
  loadAverage: () => number[];
  uptimeSeconds: () => number;
  disk: () => Promise<{ totalBytes: number; freeBytes: number } | null>;
  // CPU (percent of the whole machine) and memory of every running server
  servers: () => Array<{ serverId: string; cpuPercent: number | null; rssBytes: number | null }>;
  ownMemory: () => number;
  now: () => number;
}

export function systemCpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const { user, nice, sys, idle: free, irq } = cpu.times;
    idle += free;
    total += user + nice + sys + free + irq;
  }
  return { idle, total };
}

export const defaultSources = (dataDir: string, servers: UsageSources['servers']): UsageSources => ({
  cpuTimes: systemCpuTimes,
  totalMemory: () => os.totalmem(),
  freeMemory: () => os.freemem(),
  loadAverage: () => os.loadavg(),
  uptimeSeconds: () => os.uptime(),
  disk: () => diskUsage(dataDir),
  servers,
  ownMemory: () => process.memoryUsage().rss,
  now: () => Date.now(),
});

// busy share of the CPU time between two readings, 0 to 100
export function cpuBetween(before: CpuTimes, after: CpuTimes): number | null {
  const total = after.total - before.total;
  if (total <= 0) return null;
  const busy = total - (after.idle - before.idle);
  return Math.min(100, Math.max(0, Math.round((busy / total) * 1000) / 10));
}

class Ring<T> {
  private readonly items: T[] = [];
  constructor(private readonly size: number) {}
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.size) this.items.shift();
  }
  all(): T[] {
    return [...this.items];
  }
}

export class UsageMonitor {
  private readonly host: Ring<UsagePoint>;
  private readonly perServer = new Map<string, Ring<ServerUsagePoint>>();
  private last: CpuTimes | null = null;
  private disk: { totalBytes: number; freeBytes: number } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sources: UsageSources,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
    private readonly keep = DEFAULT_KEEP,
  ) {
    this.host = new Ring(keep);
  }

  start(): void {
    if (this.timer !== null) return;
    this.last = this.sources.cpuTimes();
    void this.sample();
    this.timer = setInterval(() => void this.sample(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async sample(): Promise<void> {
    const at = this.sources.now();
    const times = this.sources.cpuTimes();
    const cpuPercent = this.last === null ? null : cpuBetween(this.last, times);
    this.last = times;
    const total = this.sources.totalMemory();
    this.host.push({ at, cpuPercent, memoryUsedBytes: Math.max(0, total - this.sources.freeMemory()) });
    const running = new Set<string>();
    for (const server of this.sources.servers()) {
      if (server.cpuPercent === null && server.rssBytes === null) continue;
      running.add(server.serverId);
      let ring = this.perServer.get(server.serverId);
      if (ring === undefined) {
        ring = new Ring(this.keep);
        this.perServer.set(server.serverId, ring);
      }
      ring.push({ at, cpuPercent: server.cpuPercent, rssBytes: server.rssBytes });
    }
    // a stopped server keeps its last history until it has aged out of the window
    for (const [serverId, ring] of this.perServer) {
      const points = ring.all();
      if (!running.has(serverId) && (points.at(-1)?.at ?? 0) < at - this.intervalMs * this.keep) this.perServer.delete(serverId);
    }
    this.disk = await this.sources.disk().catch(() => null);
  }

  snapshot(): UsageResponse {
    return {
      intervalMs: this.intervalMs,
      host: {
        cpuCount: os.cpus().length,
        cpuModel: os.cpus()[0]?.model.trim() ?? null,
        loadAverage: process.platform === 'win32' ? null : this.sources.loadAverage().map((value) => Math.round(value * 100) / 100),
        uptimeSeconds: Math.round(this.sources.uptimeSeconds()),
        totalMemoryBytes: this.sources.totalMemory(),
        disk: this.disk,
        appMemoryBytes: this.sources.ownMemory(),
      },
      samples: this.host.all(),
      servers: [...this.perServer].map(([serverId, ring]) => ({ serverId, samples: ring.all() })),
    };
  }
}
