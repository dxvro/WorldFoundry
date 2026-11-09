import { getCurrentDictionary } from '../i18n/current';
import { ApiError } from '../lib/api';
import { ReconnectingSocket, websocketUrl, type ConnectionState, type ReconnectingSocketOptions, type SocketFactory } from '../lib/socket';
import type { ConsoleServerMessage, RuntimeStatus } from '../lib/types';
import { MAX_CONSOLE_LINES, LineBatcher, appendLines, applyHistory, emptyConsole, type ConsoleModel } from './model';

// A failed console command. Like an ApiError it carries the backend `code`, so errorMessage can translate it.
export class CommandError extends ApiError {
  constructor(code: string, message: string) {
    super(0, code, message);
    this.name = 'CommandError';
  }
}

export interface ConsoleSnapshot {
  model: ConsoleModel;
  status: RuntimeStatus | null;
  connection: ConnectionState;
}

export interface ConsoleSessionOptions {
  serverId: string;
  factory?: SocketFactory;
  onChange: (snapshot: ConsoleSnapshot) => void;
  onRejected?: () => void;
  commandTimeoutMs?: number;
  socketOptions?: Partial<Pick<ReconnectingSocketOptions, 'backoff' | 'random' | 'pingIntervalMs' | 'silenceTimeoutMs'>>;
  schedule?: (callback: () => void) => number;
  cancel?: (handle: number) => void;
}

interface Pending {
  resolve: () => void;
  reject: (error: CommandError) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isConsoleMessage(value: unknown): value is ConsoleServerMessage {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

// Owns one console WebSocket: history on (re)connect, live lines batched per interval, seq-based
// de-duplication, and request/response matching for commands.
export class ConsoleSession {
  private model: ConsoleModel = emptyConsole();
  private status: RuntimeStatus | null = null;
  private connection: ConnectionState = 'connecting';
  private counter = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly socket: ReconnectingSocket;
  private readonly batcher: LineBatcher;

  constructor(private readonly options: ConsoleSessionOptions) {
    this.batcher = new LineBatcher(
      (lines) => {
        this.model = appendLines(this.model, lines);
        this.emit();
      },
      options.schedule,
      options.cancel,
    );
    this.socket = new ReconnectingSocket({
      url: () => websocketUrl(`/api/servers/${encodeURIComponent(options.serverId)}/console?history=${MAX_CONSOLE_LINES}`),
      onMessage: (message) => this.handle(message),
      onState: (state) => {
        this.connection = state;
        if (state !== 'open') this.failPending(getCurrentDictionary().console.errors.interrupted);
        this.emit();
      },
      ...(options.onRejected === undefined ? {} : { onRejected: options.onRejected }),
      ...(options.factory === undefined ? {} : { factory: options.factory }),
      ...options.socketOptions,
    });
  }

  start(): void {
    this.socket.start();
  }

  stop(): void {
    this.socket.stop();
    this.batcher.dispose();
    this.failPending(getCurrentDictionary().console.errors.closed);
  }

  retryNow(): void {
    this.socket.retryNow();
  }

  snapshot(): ConsoleSnapshot {
    return { model: this.model, status: this.status, connection: this.connection };
  }

  send(command: string): Promise<void> {
    const id = `c${Date.now().toString(36)}${(this.counter++).toString(36)}`;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CommandError('COMMAND_TIMEOUT', getCurrentDictionary().console.errors.timeout));
      }, this.options.commandTimeoutMs ?? 10_000);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.socket.send({ type: 'command', command, id })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CommandError('NOT_CONNECTED', getCurrentDictionary().console.errors.notConnectedSent));
      }
    });
  }

  private emit(): void {
    this.options.onChange(this.snapshot());
  }

  private failPending(message: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new CommandError('NOT_CONNECTED', message));
      this.pending.delete(id);
    }
  }

  private handle(raw: unknown): void {
    if (!isConsoleMessage(raw)) return;
    switch (raw.type) {
      case 'history':
        // lines queued before the history arrived are older than it or already contained in it
        this.batcher.drain();
        this.model = applyHistory(this.model, raw.lines);
        this.emit();
        break;
      case 'line':
        this.batcher.push(raw.line);
        break;
      case 'status':
        this.status = raw.status;
        this.emit();
        break;
      case 'ack':
        this.settle(raw.id, null);
        break;
      case 'error':
        this.settle(raw.id, new CommandError(raw.code, raw.message));
        break;
      case 'pong':
        break;
    }
  }

  private settle(id: string | undefined, error: CommandError | null): void {
    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (error === null) pending.resolve();
    else pending.reject(error);
  }
}
