import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';

export interface RawSample {
  // cumulative CPU time of the process in milliseconds
  cpuMs: number;
  rssBytes: number;
  // wall clock of the measurement in milliseconds, taken on the same clock as cpuMs was read
  atMs: number;
}

export type SampleReader = (pids: readonly number[]) => Promise<Map<number, RawSample>>;

export interface ProcessMetrics {
  cpuPercent: number;
  rssBytes: number;
}

const run = (file: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error === null) resolve(stdout);
      else reject(error);
    });
  });

// One PowerShell start per poll for all PIDs; wmic is gone from current Windows builds.
// The first line is the wall clock (100 ns ticks since year 1), then one line per process: pid cpuTicks workingSet.
const WINDOWS_SCRIPT = (pids: readonly number[]): string =>
  `$t=[DateTime]::UtcNow.Ticks; "T $t"; Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { try { "P $($_.Id) $($_.TotalProcessorTime.Ticks) $($_.WorkingSet64)" } catch {} }`;

export function parseWindowsSamples(output: string): Map<number, RawSample> {
  const samples = new Map<number, RawSample>();
  let atMs = 0;
  for (const line of output.split(/\r?\n/)) {
    const clock = /^T (\d+)$/.exec(line.trim());
    if (clock?.[1] !== undefined) atMs = Number(BigInt(clock[1]) / 10_000n);
    const row = /^P (\d+) (\d+) (\d+)$/.exec(line.trim());
    if (row?.[1] !== undefined && row[2] !== undefined && row[3] !== undefined) {
      samples.set(Number(row[1]), { cpuMs: Number(BigInt(row[2]) / 10_000n), rssBytes: Number(row[3]), atMs });
    }
  }
  return samples;
}

async function readWindows(pids: readonly number[]): Promise<Map<number, RawSample>> {
  const encoded = Buffer.from(WINDOWS_SCRIPT(pids), 'utf16le').toString('base64');
  const stdout = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
  return parseWindowsSamples(stdout);
}

const CLOCK_TICKS_PER_SECOND = 100;
const PAGE_SIZE = 4096;

export function parseProcStat(stat: string, statm: string, atMs: number): RawSample | null {
  // the command name may contain spaces and parentheses, so cut after the last ')'
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const residentPages = Number(statm.split(' ')[1]);
  if (![utime, stime, residentPages].every(Number.isFinite)) return null;
  return { cpuMs: ((utime + stime) * 1000) / CLOCK_TICKS_PER_SECOND, rssBytes: residentPages * PAGE_SIZE, atMs };
}

async function readLinux(pids: readonly number[]): Promise<Map<number, RawSample>> {
  const samples = new Map<number, RawSample>();
  for (const pid of pids) {
    try {
      const [stat, statm] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readFile(`/proc/${pid}/statm`, 'utf8')]);
      const sample = parseProcStat(stat, statm, Date.now());
      if (sample !== null) samples.set(pid, sample);
    } catch {
      // process vanished between polls
    }
  }
  return samples;
}

export function parseCpuTime(text: string): number | null {
  // [[dd-]hh:]mm:ss[.cc] as printed by ps
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (match?.[3] === undefined || match[4] === undefined) return null;
  const seconds = Number(match[1] ?? 0) * 86_400 + Number(match[2] ?? 0) * 3600 + Number(match[3]) * 60 + Number(match[4]);
  return seconds * 1000;
}

async function readPs(pids: readonly number[]): Promise<Map<number, RawSample>> {
  const stdout = await run('ps', ['-o', 'pid=,rss=,time=', '-p', pids.join(',')]);
  const samples = new Map<number, RawSample>();
  const atMs = Date.now();
  for (const line of stdout.split('\n')) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    const cpuMs = row?.[3] === undefined ? null : parseCpuTime(row[3]);
    if (row?.[1] !== undefined && row[2] !== undefined && cpuMs !== null) {
      samples.set(Number(row[1]), { cpuMs, rssBytes: Number(row[2]) * 1024, atMs });
    }
  }
  return samples;
}

export function platformReader(platform: NodeJS.Platform = process.platform): SampleReader {
  if (platform === 'win32') return readWindows;
  if (platform === 'linux') return readLinux;
  return readPs;
}

// CPU is the share of the whole machine (all cores = 100 %), computed from the delta of two samples
export class MetricsSampler {
  private previous = new Map<number, RawSample>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly getPids: () => number[],
    private readonly onMetrics: (metrics: Map<number, ProcessMetrics>) => void,
    private readonly options: { read?: SampleReader; intervalMs?: number; cores?: number; log?: (error: unknown) => void } = {},
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.poll(), this.options.intervalMs ?? 5000);
    this.timer.unref();
    void this.poll();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.previous.clear();
  }

  get active(): boolean {
    return this.timer !== null;
  }

  // overlapping polls are skipped; a failing poll is only logged
  async poll(): Promise<void> {
    if (this.polling) return;
    const pids = this.getPids();
    if (pids.length === 0) {
      this.previous.clear();
      return;
    }
    this.polling = true;
    try {
      const samples = await (this.options.read ?? platformReader())(pids);
      const cores = this.options.cores ?? os.cpus().length;
      const result = new Map<number, ProcessMetrics>();
      for (const [pid, sample] of samples) {
        const before = this.previous.get(pid);
        const elapsed = before === undefined ? 0 : sample.atMs - before.atMs;
        const cpuPercent =
          before === undefined || elapsed <= 0 ? 0 : Math.min(100, Math.max(0, ((sample.cpuMs - before.cpuMs) / elapsed / cores) * 100));
        result.set(pid, { cpuPercent: Math.round(cpuPercent * 10) / 10, rssBytes: sample.rssBytes });
      }
      this.previous = samples;
      this.onMetrics(result);
    } catch (error) {
      this.options.log?.(error);
    } finally {
      this.polling = false;
    }
  }
}
