import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createInstallerRunner } from '../src/installer/runner.js';
import { realSpawner, type ProcessSpawner } from '../src/process/spawner.js';
import { scratchDir } from './server-env.js';

const runnerFor = (script: string): ReturnType<typeof createInstallerRunner> => {
  const spawner: ProcessSpawner = {
    spawn: ({ cwd }) => spawn(process.execPath, ['-e', script], { cwd, shell: false, windowsHide: true }),
    killTree: (child) => realSpawner.killTree(child),
  };
  return createInstallerRunner(spawner);
};

const request = async (signal = new AbortController().signal, timeoutMs = 5000) => ({
  javaPath: 'java',
  args: ['-jar', 'x.jar', '--installServer'],
  cwd: await scratchDir('runner-'),
  timeoutMs,
  signal,
  onLine: () => undefined,
});

describe('installer runner', () => {
  it('streams stdout and stderr lines (UTF-8, CRLF) and reports the exit code', async () => {
    const lines: string[] = [];
    const run = runnerFor(`process.stdout.write('Grüße\\r\\ntwo\\n'); process.stderr.write('warning\\n'); process.exit(3)`);
    const result = await run({ ...(await request()), onLine: (line) => lines.push(line) });
    expect(result).toEqual({ exitCode: 3, timedOut: false, aborted: false });
    expect(lines.sort()).toEqual(['Grüße', 'two', 'warning']);
  });

  it('runs in the given working directory with a closed stdin', async () => {
    const lines: string[] = [];
    const req = await request();
    const run = runnerFor(`process.stdin.on('end', () => { console.log(process.cwd()); }); process.stdin.resume();`);
    const result = await run({ ...req, onLine: (line) => lines.push(line) });
    expect(result.exitCode).toBe(0);
    expect(lines[0]?.toLowerCase()).toBe(req.cwd.toLowerCase());
  });

  it('kills a hanging installer after the timeout', async () => {
    const run = runnerFor(`setInterval(() => {}, 1000)`);
    const result = await run(await request(undefined, 300));
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
  });

  it('kills the installer when the app aborts', async () => {
    const controller = new AbortController();
    const run = runnerFor(`setInterval(() => {}, 1000)`);
    setTimeout(() => controller.abort(), 200);
    const result = await run(await request(controller.signal));
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it('rejects when the process cannot be started', async () => {
    const spawner: ProcessSpawner = {
      spawn: ({ cwd }) => spawn('does-not-exist-xyz', [], { cwd, shell: false, windowsHide: true }),
      killTree: (child) => realSpawner.killTree(child),
    };
    await expect(createInstallerRunner(spawner)(await request())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
