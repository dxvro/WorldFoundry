import type { SocketLike } from '../lib/socket';
import type { ConsoleLine, ConsoleStream } from '../lib/types';

export class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: unknown[] = [];

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  static reset(): void {
    FakeSocket.instances = [];
  }

  static get last(): FakeSocket {
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (socket === undefined) throw new Error('Kein Socket erzeugt');
    return socket;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

export const line = (seq: number, text = `Line ${seq}`, stream: ConsoleStream = 'stdout'): ConsoleLine => ({ seq, time: 1_700_000_000_000 + seq, stream, text });
export const lines = (from: number, to: number): ConsoleLine[] => Array.from({ length: to - from + 1 }, (_, index) => line(from + index));
