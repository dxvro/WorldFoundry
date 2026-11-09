import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSocket, line, lines } from '../test/fakes';
import { CommandError, ConsoleSession, type ConsoleSnapshot } from './session';

function make(): { session: ConsoleSession; latest: () => ConsoleSnapshot; flush: () => void } {
  let snapshot: ConsoleSnapshot | null = null;
  const pending: Array<() => void> = [];
  const session = new ConsoleSession({
    serverId: 'abc',
    factory: (url) => new FakeSocket(url),
    onChange: (next) => {
      snapshot = next;
    },
    schedule: (callback) => pending.push(callback),
    cancel: () => undefined,
    commandTimeoutMs: 500,
    socketOptions: { random: () => 0.5, backoff: { baseMs: 100, maxMs: 1000, jitter: 0 } },
  });
  return {
    session,
    latest: () => snapshot ?? session.snapshot(),
    flush: () => pending.splice(0).forEach((callback) => callback()),
  };
}

const rowsOf = (snapshot: ConsoleSnapshot): number[] => snapshot.model.rows.map((row) => row.seq);

describe('ConsoleSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects to the console endpoint of the server with the full history size', () => {
    const { session } = make();
    session.start();
    expect(FakeSocket.last.url).toMatch(/^wss?:\/\/.+\/api\/servers\/abc\/console\?history=2000$/);
    session.stop();
  });

  it('shows history, then live lines batched per interval', () => {
    const { session, latest, flush } = make();
    session.start();
    const socket = FakeSocket.last;
    socket.open();
    socket.receive({ type: 'status', status: { state: 'online' } });
    socket.receive({ type: 'history', lines: lines(1, 3) });
    expect(rowsOf(latest())).toEqual([1, 2, 3]);
    expect(latest().connection).toBe('open');

    for (const entry of lines(4, 200)) socket.receive({ type: 'line', line: entry });
    expect(rowsOf(latest())).toHaveLength(3);
    flush();
    expect(rowsOf(latest())).toHaveLength(200);
    session.stop();
  });

  it('reconnects with backoff and neither duplicates nor loses lines', () => {
    const { session, latest, flush } = make();
    session.start();
    const first = FakeSocket.last;
    first.open();
    first.receive({ type: 'history', lines: lines(1, 10) });
    first.receive({ type: 'line', line: line(11) });
    flush();
    first.drop();
    expect(latest().connection).toBe('closed');

    vi.advanceTimersByTime(99);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);

    const second = FakeSocket.last;
    second.open();
    // while disconnected the server printed 12..20; the history overlaps what we have
    second.receive({ type: 'history', lines: lines(5, 20) });
    expect(rowsOf(latest())).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    // a late duplicate of an old live line changes nothing
    second.receive({ type: 'line', line: line(20) });
    second.receive({ type: 'line', line: line(21) });
    flush();
    expect(rowsOf(latest()).at(-1)).toBe(21);
    expect(new Set(rowsOf(latest())).size).toBe(21);
    session.stop();
  });

  it('doubles the delay on repeated failures', () => {
    const { session } = make();
    session.start();
    FakeSocket.last.drop();
    vi.advanceTimersByTime(100);
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.last.drop();
    vi.advanceTimersByTime(199);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);
    session.stop();
  });

  it('resolves a command on ack and shows the socket error inline for a rejected one', async () => {
    const { session } = make();
    session.start();
    const socket = FakeSocket.last;
    socket.open();

    const ok = session.send('list');
    const sent = socket.sent[0] as { type: string; command: string; id: string };
    expect(sent).toMatchObject({ type: 'command', command: 'list' });
    socket.receive({ type: 'ack', id: sent.id });
    await expect(ok).resolves.toBeUndefined();

    const failing = session.send('say hi');
    const second = socket.sent[1] as { id: string };
    socket.receive({ type: 'error', code: 'SERVER_NOT_RUNNING', message: 'The server is not running.', id: second.id });
    await expect(failing).rejects.toMatchObject({ code: 'SERVER_NOT_RUNNING', message: 'The server is not running.' });
    session.stop();
  });

  it('rejects commands when not connected and when the connection drops before the answer', async () => {
    const { session } = make();
    session.start();
    await expect(session.send('list')).rejects.toBeInstanceOf(CommandError);

    const socket = FakeSocket.last;
    socket.open();
    const pending = session.send('list');
    const assertion = expect(pending).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    socket.drop();
    await assertion;
    session.stop();
  });

  it('times out a command nobody answers', async () => {
    const { session } = make();
    session.start();
    FakeSocket.last.open();
    const pending = session.send('list');
    const assertion = expect(pending).rejects.toMatchObject({ code: 'COMMAND_TIMEOUT' });
    vi.advanceTimersByTime(600);
    await assertion;
    session.stop();
  });

  it('keeps the last known runtime status', () => {
    const { session, latest } = make();
    session.start();
    const socket = FakeSocket.last;
    socket.open();
    socket.receive({ type: 'status', status: { state: 'crashed', exitCode: 3 } });
    expect(latest().status).toMatchObject({ state: 'crashed', exitCode: 3 });
    session.stop();
  });
});
