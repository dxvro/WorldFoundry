import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type ServerProcess = ChildProcessWithoutNullStreams;

export interface SpawnRequest {
  command: string;
  args: readonly string[];
  cwd: string;
}

export interface ProcessSpawner {
  spawn(request: SpawnRequest): ServerProcess;
  // kills the process and everything it started
  killTree(child: ServerProcess): Promise<void>;
}

export function killWindowsTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 }, () => resolve());
  });
}

export const realSpawner: ProcessSpawner = {
  spawn: ({ command, args, cwd }) =>
    spawn(command, [...args], { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }),
  async killTree(child) {
    if (child.pid === undefined || child.exitCode !== null) return;
    if (process.platform === 'win32') await killWindowsTree(child.pid);
    if (child.exitCode === null) child.kill('SIGKILL');
  },
};
