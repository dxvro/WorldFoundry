// A WebSocket that reconnects with exponential backoff. Used for the event stream and for each console.

export interface SocketLike {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string) => SocketLike;
export type ConnectionState = 'connecting' | 'open' | 'closed';

const OPEN = 1;

// ws:// on http pages, wss:// on https pages, always the host the page was loaded from
export function websocketUrl(path: string, location: Pick<Location, 'protocol' | 'host'> = window.location): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`;
}

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 500, maxMs: 15_000, jitter: 0.25 };

// attempt 0 -> ~base, doubling up to max; random() in [0,1) spreads clients so they do not reconnect in lockstep
export function backoffDelay(attempt: number, options: BackoffOptions = DEFAULT_BACKOFF, random: () => number = Math.random): number {
  const exponential = Math.min(options.maxMs, options.baseMs * 2 ** Math.max(0, attempt));
  const spread = exponential * options.jitter * (random() * 2 - 1);
  return Math.max(0, Math.round(Math.min(options.maxMs, exponential + spread)));
}

export interface ReconnectingSocketOptions {
  url: () => string;
  onMessage: (data: unknown) => void;
  onState?: (state: ConnectionState) => void;
  // called when the socket closed without ever having been open (rejected handshake, e.g. lost login)
  onRejected?: () => void;
  // called on every successful (re)connect, with true for reconnects
  onOpen?: (isReconnect: boolean) => void;
  factory?: SocketFactory;
  backoff?: BackoffOptions;
  random?: () => number;
  pingIntervalMs?: number;
  silenceTimeoutMs?: number;
}

export class ReconnectingSocket {
  private socket: SocketLike | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private stopped = true;
  private hasOpened = false;
  private state: ConnectionState = 'closed';
  private readonly factory: SocketFactory;

  constructor(private readonly options: ReconnectingSocketOptions) {
    this.factory = options.factory ?? ((url) => new WebSocket(url) as unknown as SocketLike);
  }

  get connection(): ConnectionState {
    return this.state;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
      try {
        socket.close();
      } catch {
        // already closed
      }
    }
    this.setState('closed');
  }

  // reconnect right away, e.g. when the browser reports that the network is back
  retryNow(): void {
    if (this.stopped || this.state === 'open' || this.socket !== null) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.open();
  }

  send(data: unknown): boolean {
    if (this.socket === null || this.socket.readyState !== OPEN) return false;
    try {
      this.socket.send(JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onState?.(state);
  }

  private clearTimers(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.timer = null;
    this.pingTimer = null;
  }

  private open(): void {
    this.setState('connecting');
    let socket: SocketLike;
    try {
      socket = this.factory(this.options.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    let opened = false;
    socket.onopen = () => {
      opened = true;
      const reconnect = this.hasOpened;
      this.hasOpened = true;
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      this.setState('open');
      this.startWatchdog();
      this.options.onOpen?.(reconnect);
    };
    socket.onmessage = (event) => {
      this.lastMessageAt = Date.now();
      if (typeof event.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      this.options.onMessage(parsed);
    };
    socket.onerror = () => undefined;
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.pingTimer !== null) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (!opened) this.options.onRejected?.();
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  // The server answers a ping with a pong; a connection that stays silent for too long is dropped and reopened.
  private startWatchdog(): void {
    const interval = this.options.pingIntervalMs ?? 20_000;
    const silence = this.options.silenceTimeoutMs ?? 60_000;
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > silence) {
        this.socket?.close();
        return;
      }
      this.send({ type: 'ping' });
    }, interval);
  }

  private scheduleReconnect(): void {
    this.setState('closed');
    const delay = backoffDelay(this.attempt, this.options.backoff, this.options.random);
    this.attempt++;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped) this.open();
    }, delay);
  }
}
