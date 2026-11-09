import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSocket } from '../test/fakes';
import { DEFAULT_BACKOFF, ReconnectingSocket, backoffDelay, websocketUrl } from './socket';

describe('websocketUrl', () => {
  it('uses ws on http pages and wss on https pages, with the page host', () => {
    expect(websocketUrl('/api/events', { protocol: 'http:', host: '192.168.1.20:3000' })).toBe('ws://192.168.1.20:3000/api/events');
    expect(websocketUrl('/api/events', { protocol: 'https:', host: 'craft.example.lan' })).toBe('wss://craft.example.lan/api/events');
  });
});

describe('backoffDelay', () => {
  const none = { ...DEFAULT_BACKOFF, jitter: 0 };

  it('doubles per attempt and stops at the maximum', () => {
    expect([0, 1, 2, 3, 4, 10].map((attempt) => backoffDelay(attempt, none))).toEqual([500, 1000, 2000, 4000, 8000, 15000]);
  });

  it('spreads clients by the jitter without exceeding the maximum', () => {
    expect(backoffDelay(0, DEFAULT_BACKOFF, () => 0)).toBe(375);
    expect(backoffDelay(0, DEFAULT_BACKOFF, () => 0.999)).toBeGreaterThan(620);
    expect(backoffDelay(20, DEFAULT_BACKOFF, () => 0.999)).toBeLessThanOrEqual(DEFAULT_BACKOFF.maxMs);
  });
});

describe('ReconnectingSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.reset();
  });
  afterEach(() => vi.useRealTimers());

  const create = (extra: Partial<ConstructorParameters<typeof ReconnectingSocket>[0]> = {}) =>
    new ReconnectingSocket({
      url: () => 'ws://test/x',
      onMessage: () => undefined,
      factory: (url) => new FakeSocket(url),
      backoff: { baseMs: 100, maxMs: 400, jitter: 0 },
      ...extra,
    });

  it('reports the connection state and whether an open is a reconnect', () => {
    const states: string[] = [];
    const opens: boolean[] = [];
    const socket = create({ onState: (state) => states.push(state), onOpen: (isReconnect) => opens.push(isReconnect) });
    socket.start();
    FakeSocket.last.open();
    FakeSocket.last.drop();
    vi.advanceTimersByTime(100);
    FakeSocket.last.open();
    expect(states).toEqual(['connecting', 'open', 'closed', 'connecting', 'open']);
    expect(opens).toEqual([false, true]);
    socket.stop();
  });

  it('calls onRejected when the socket closes without ever opening', () => {
    const onRejected = vi.fn();
    const socket = create({ onRejected });
    socket.start();
    FakeSocket.last.drop();
    expect(onRejected).toHaveBeenCalledTimes(1);
    FakeSocket.last.open();
    FakeSocket.last.drop();
    expect(onRejected).toHaveBeenCalledTimes(1);
    socket.stop();
  });

  it('resets the backoff after a successful open', () => {
    const socket = create();
    socket.start();
    FakeSocket.last.drop();
    vi.advanceTimersByTime(100);
    FakeSocket.last.drop();
    vi.advanceTimersByTime(200);
    FakeSocket.last.open();
    FakeSocket.last.drop();
    vi.advanceTimersByTime(100);
    expect(FakeSocket.instances).toHaveLength(4);
    socket.stop();
  });

  it('does not reconnect after stop and ignores unparsable messages', () => {
    const onMessage = vi.fn();
    const socket = create({ onMessage });
    socket.start();
    const current = FakeSocket.last;
    current.open();
    current.onmessage?.({ data: 'not json' });
    current.receive({ type: 'pong' });
    expect(onMessage).toHaveBeenCalledTimes(1);
    socket.stop();
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('retryNow reconnects without waiting for the timer', () => {
    const socket = create();
    socket.start();
    FakeSocket.last.drop();
    socket.retryNow();
    expect(FakeSocket.instances).toHaveLength(2);
    socket.stop();
  });

  it('drops a connection that stays silent and sends pings meanwhile', () => {
    const socket = create({ pingIntervalMs: 1000, silenceTimeoutMs: 3500 });
    socket.start();
    const current = FakeSocket.last;
    current.open();
    vi.advanceTimersByTime(1000);
    expect(current.sent).toContainEqual({ type: 'ping' });
    vi.advanceTimersByTime(3000);
    expect(current.readyState).toBe(3);
    socket.stop();
  });
});
