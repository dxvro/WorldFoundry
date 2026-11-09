import { LineAssembler } from '../process/lines.js';
import type { ProcessSpawner } from '../process/spawner.js';

export interface InstallerRun {
  javaPath: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  onLine: (line: string) => void;
}

export interface InstallerResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}

export type InstallerRunner = (run: InstallerRun) => Promise<InstallerResult>;

export function createInstallerRunner(spawner: ProcessSpawner): InstallerRunner {
  return (run) =>
    new Promise<InstallerResult>((resolve, reject) => {
      let timedOut = false;
      let aborted = false;
      let settled = false;
      const child = spawner.spawn({ command: run.javaPath, args: run.args, cwd: run.cwd });
      const out = new LineAssembler(run.onLine);
      const err = new LineAssembler(run.onLine);
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
      child.stdin.on('error', () => undefined);
      child.stdin.end();

      const stop = (): void => void spawner.killTree(child).catch(() => undefined);
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, run.timeoutMs);
      const onAbort = (): void => {
        aborted = true;
        stop();
      };
      if (run.signal.aborted) onAbort();
      else run.signal.addEventListener('abort', onAbort, { once: true });

      const finish = (settle: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        run.signal.removeEventListener('abort', onAbort);
        out.flush();
        err.flush();
        settle();
      };
      child.once('error', (error) => finish(() => reject(error)));
      child.once('close', (code) => finish(() => resolve({ exitCode: code, timedOut, aborted })));
    });
}
