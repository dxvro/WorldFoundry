import { StringDecoder } from 'node:string_decoder';

export const MAX_LINE_LENGTH = 8192;
export const TRUNCATION_MARK = ' [...]';

// CSI (colours, cursor) and OSC (titles, links) sequences, plus one cut off at the end of a line
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*)?$/g;

export const stripAnsi = (text: string): string => text.replace(ANSI, '');

// Turns arbitrary byte chunks into complete lines: UTF-8 sequences and lines may be split anywhere.
export class LineAssembler {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private discarding = false;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxLength = MAX_LINE_LENGTH,
  ) {}

  push(chunk: Buffer): void {
    this.consume(this.decoder.write(chunk));
  }

  // emits a trailing line that never got its newline
  flush(): void {
    this.consume(this.decoder.end());
    if (this.pending !== '' && !this.discarding) this.emit(this.pending);
    this.pending = '';
    this.discarding = false;
  }

  // sequences are removed per assembled line, so one split across chunks is still seen whole
  private emit(line: string): void {
    this.onLine(stripAnsi(line));
  }

  private consume(text: string): void {
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== '\n') continue;
      this.append(text.slice(start, i));
      this.finishLine();
      start = i + 1;
    }
    this.append(text.slice(start));
  }

  private append(part: string): void {
    if (part === '' || this.discarding) return;
    this.pending += part;
    if (this.pending.length > this.maxLength) {
      this.emit(this.pending.slice(0, this.maxLength) + TRUNCATION_MARK);
      this.pending = '';
      this.discarding = true;
    }
  }

  private finishLine(): void {
    if (!this.discarding) this.emit(this.pending.endsWith('\r') ? this.pending.slice(0, -1) : this.pending);
    this.pending = '';
    this.discarding = false;
  }
}

export class RingBuffer<T> {
  private items: T[] = [];

  constructor(private readonly capacity: number) {}

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity * 2) this.items = this.items.slice(-this.capacity);
  }

  last(limit = this.capacity): T[] {
    const visible = this.items.length > this.capacity ? this.items.slice(-this.capacity) : this.items;
    return limit >= visible.length ? [...visible] : visible.slice(-limit);
  }

  get size(): number {
    return Math.min(this.items.length, this.capacity);
  }
}
