import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallLogView } from '../src/contract.js';
import type { AppEvent } from '../src/events/bus.js';
import { ServerEnv, waitFor } from './server-env.js';

interface ErrorBody {
  error: { code: string; message: string };
}

let env: ServerEnv;
let events: AppEvent[];
beforeEach(async () => {
  env = await ServerEnv.create();
  events = [];
  env.services.bus.subscribe((event) => events.push(event));
});
afterEach(async () => {
  await env.close();
});

const log = (serverId: string, query = '') => env.call<InstallLogView & ErrorBody>('GET', `/api/servers/${serverId}/install-log${query}`);
const liveLines = (serverId: string) => events.flatMap((e) => (e.type === 'install.log' && e.serverId === serverId ? [e] : []));

async function created(body: Record<string, unknown> = {}): Promise<string> {
  const res = await env.call<{ server: { id: string } }>('POST', '/api/servers', { name: 'Neo', loader: 'neoforge', mcVersion: '1.21.1', ...body });
  return res.body.server.id;
}

describe('GET /api/servers/:id/install-log', () => {
  it('returns the finished log with line numbers that match the live events exactly', async () => {
    const id = await created();
    await env.services.install.idle();
    const res = await log(id);
    expect(res.status).toBe(200);
    const live = liveLines(id);
    expect(res.body.totalLines).toBe(live.length);
    expect(res.body.truncated).toBe(false);
    expect(res.body.lines.map((line) => line.seq)).toEqual(live.map((_, index) => index));
    expect(res.body.lines.map((line) => line.text)).toEqual(live.map((event) => (event.type === 'install.log' ? event.line : '')));
    expect(res.body.lines[0]?.text).toContain('Installation of neoforge 1.21.1');
    expect(res.body.lines.at(-1)?.text).toContain('Installation finished');
    expect(res.body.lines.every((line) => typeof line.time === 'number')).toBe(true);
    // the time of a line is the time of its live event
    expect(res.body.lines.map((line) => line.time)).toEqual(live.map((event) => (event.type === 'install.log' ? event.time : 0)));
  });

  it('returns only the last lines for ?tail and flags the cut', async () => {
    const id = await created();
    await env.services.install.idle();
    const all = await log(id);
    const tail = await log(id, '?tail=3');
    expect(tail.body.lines).toEqual(all.body.lines.slice(-3));
    expect(tail.body).toMatchObject({ truncated: true, totalLines: all.body.totalLines });
    expect(tail.body.lines[0]?.seq).toBe(all.body.totalLines - 3);
  });

  it('can be read in the middle of an installation and continues without gaps or duplicates', async () => {
    env.installer.mode = 'hang';
    const id = await created();
    await waitFor(() => liveLines(id).some((event) => event.line === 'Installer started'), 4000, 'Installer');
    const snapshot = await log(id);
    const cut = liveLines(id).length;
    expect(snapshot.body.lines.at(-1)?.text).toContain('Installer');
    // lines written afterwards arrive as events carrying the next numbers
    await env.services.install.shutdown(2000);
    await env.services.install.idle();
    const merged = new Map<number, string>();
    for (const line of snapshot.body.lines) merged.set(line.seq, line.text);
    for (const event of liveLines(id)) merged.set(event.seq, event.line);
    const full = await log(id);
    expect([...merged.keys()].sort((a, b) => a - b)).toEqual(full.body.lines.map((line) => line.seq));
    expect(full.body.totalLines).toBeGreaterThan(cut - 1);
    expect(snapshot.body.lines.map((line) => line.seq)).toEqual(snapshot.body.lines.map((_, index) => index));
  });

  it('numbers a retry after the earlier lines of the same file', async () => {
    env.installer.mode = 'fail';
    const id = await created();
    await env.services.install.idle();
    const first = await log(id);
    expect(first.body.lines.some((line) => line.text.startsWith('ERROR:'))).toBe(true);
    env.installer.mode = 'modern';
    events.length = 0;
    expect((await env.call('POST', `/api/servers/${id}/install`)).status).toBe(202);
    await env.services.install.idle();
    const second = await log(id);
    expect(second.body.totalLines).toBeGreaterThan(first.body.totalLines);
    expect(liveLines(id)[0]?.seq).toBe(first.body.totalLines);
    expect(second.body.lines.map((line) => line.seq)).toEqual(second.body.lines.map((_, index) => index));
  });

  it('splits a multi-line message into numbered physical lines', async () => {
    env.installer.mode = 'fail';
    const id = await created();
    await env.services.install.idle();
    const res = await log(id);
    const failure = res.body.lines.findIndex((line) => line.text.startsWith('ERROR:'));
    expect(res.body.lines.slice(failure).map((line) => line.text)).toContain('Could not download libraries');
    expect(res.body.lines.map((line) => line.seq)).toEqual(res.body.lines.map((_, index) => index));
  });

  it('is empty before anything ran and for unknown servers a 404', async () => {
    const server = await env.addServer();
    expect((await log(server.id)).body).toEqual({ lines: [], totalLines: 0, truncated: false });
    expect((await log('00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('validates ?tail', async () => {
    const server = await env.addServer();
    for (const query of ['?tail=0', '?tail=5001', '?tail=abc', '?tail=-1']) expect((await log(server.id, query)).status).toBe(400);
    expect((await log(server.id, '?tail=5000')).status).toBe(200);
  });

  it('removes control characters and escape sequences and shortens huge lines', async () => {
    const server = await env.addServer();
    const file = path.join(env.serverDir(server.id), 'install.log');
    const stamp = '2024-05-01T10:00:00.000Z';
    await writeFile(
      file,
      [
        `${stamp} green \u001b[32mOK\u001b[0m and \u0007Bell\u0000 end`,
        `${stamp} Line with CRLF\r`,
        'without timestamp',
        `${stamp} ${'x'.repeat(9000)}`,
        `${stamp} last line without line break`,
      ].join('\n'),
    );
    const res = await log(server.id);
    expect(res.body.lines.map((line) => line.text.slice(0, 40))).toEqual([
      'green OK and Bell end',
      'Line with CRLF',
      'without timestamp',
      'x'.repeat(40),
      'last line without line break',
    ]);
    expect(res.body.lines[3]?.text.length).toBe(4000);
    expect(res.body.lines[2]?.time).toBeNull();
    expect(res.body.lines[0]?.time).toBe(Date.parse(stamp));
    expect(res.body.totalLines).toBe(5);
  });

  it('never follows a link or opens a directory named install.log', async () => {
    const server = await env.addServer();
    const target = path.join(env.serverDir(server.id), 'secret.txt');
    await writeFile(target, 'Password');
    const file = path.join(env.serverDir(server.id), 'install.log');
    try {
      await symlink(target, file);
    } catch {
      await mkdir(file);
    }
    const res = await log(server.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSTALL_LOG_UNSAFE');
    expect(JSON.stringify(res.body)).not.toContain('Password');
  });

  it('handles a large log by streaming and keeping only the tail', async () => {
    const server = await env.addServer();
    const stamp = '2024-05-01T10:00:00.000Z';
    const lines = Array.from({ length: 50_000 }, (_, index) => `${stamp} Line ${index}`);
    await writeFile(path.join(env.serverDir(server.id), 'install.log'), `${lines.join('\n')}\n`);
    const res = await log(server.id, '?tail=2');
    expect(res.body.totalLines).toBe(50_000);
    expect(res.body.lines.map((line) => line.text)).toEqual(['Line 49998', 'Line 49999']);
    expect(res.body.lines[0]?.seq).toBe(49_998);
  });
});
