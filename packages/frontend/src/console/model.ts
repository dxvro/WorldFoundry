import { getCurrentDictionary } from '../i18n/current';
import type { MessageRef } from '@worldfoundry/backend/contract';
import type { ConsoleLine, ConsoleStream } from '../lib/types';

// The backend keeps at most this many lines per server; the page never holds more either.
export const MAX_CONSOLE_LINES = 2000;

export const BATCH_INTERVAL_MS = 50;

export interface ConsoleRow {
  seq: number;
  time: number;
  stream: ConsoleStream | 'gap';
  text: string;
  // the reference of a system line the backend wrote itself (its text is English; rendered in the active language)
  textRef?: MessageRef;
}

export interface ConsoleModel {
  rows: ConsoleRow[];
  // highest seq seen from the server, 0 while nothing arrived
  lastSeq: number;
}

export const emptyConsole = (): ConsoleModel => ({ rows: [], lastSeq: 0 });

const gapRow = (seq: number, missing: number, time: number): ConsoleRow => ({
  seq: seq - 0.5,
  time,
  stream: 'gap',
  text: missing === 1 ? getCurrentDictionary().console.gap.one : getCurrentDictionary().console.gap.many(missing),
});

function trim(rows: ConsoleRow[]): ConsoleRow[] {
  return rows.length > MAX_CONSOLE_LINES ? rows.slice(rows.length - MAX_CONSOLE_LINES) : rows;
}

// Appends lines that are newer than everything seen so far. Duplicates (seq not above lastSeq) are dropped,
// a jump in seq leaves a visible gap marker instead of silently hiding missing output.
export function appendLines(model: ConsoleModel, lines: readonly ConsoleLine[]): ConsoleModel {
  if (lines.length === 0) return model;
  const rows = model.rows.slice();
  let lastSeq = model.lastSeq;
  for (const line of lines) {
    if (line.seq <= lastSeq) continue;
    if (lastSeq > 0 && line.seq > lastSeq + 1) rows.push(gapRow(line.seq, line.seq - lastSeq - 1, line.time));
    rows.push({ seq: line.seq, time: line.time, stream: line.stream, text: line.text, textRef: line.textRef });
    lastSeq = line.seq;
  }
  return lastSeq === model.lastSeq ? model : { rows: trim(rows), lastSeq };
}

// History after (re)connecting. It continues the existing rows when it overlaps or touches them. When it ends
// before what we have already seen, the backend restarted and numbering began anew: start over.
export function applyHistory(model: ConsoleModel, lines: readonly ConsoleLine[]): ConsoleModel {
  const last = lines[lines.length - 1];
  if (last === undefined) return model;
  if (last.seq < model.lastSeq) return appendLines(emptyConsole(), lines);
  return appendLines(model, lines);
}

export interface RowFilter {
  text: string;
  streams: ReadonlySet<ConsoleStream>;
}

// `display` gives the text a row shows (system lines with a reference are rendered in the active language), so the
// filter matches what the user sees; without it the stored (English) text is searched.
export function filterRows(rows: readonly ConsoleRow[], filter: RowFilter, display: (row: ConsoleRow) => string = (row) => row.text): readonly ConsoleRow[] {
  const needle = filter.text.trim().toLowerCase();
  if (needle === '' && filter.streams.size === 4) return rows;
  return rows.filter((row) => {
    if (row.stream === 'gap') return needle === '';
    return filter.streams.has(row.stream) && (needle === '' || display(row).toLowerCase().includes(needle));
  });
}

// Collects incoming lines and hands them over in one go per interval, so a server that prints thousands of
// lines per second causes about twenty renders per second instead of one per line. A timer rather than
// requestAnimationFrame keeps working in a background tab.
export class LineBatcher {
  private queue: ConsoleLine[] = [];
  private scheduled: number | null = null;

  constructor(
    private readonly flush: (lines: ConsoleLine[]) => void,
    private readonly schedule: (callback: () => void) => number = (callback) => window.setTimeout(callback, BATCH_INTERVAL_MS),
    private readonly cancel: (handle: number) => void = (handle) => window.clearTimeout(handle),
  ) {}

  push(line: ConsoleLine): void {
    this.queue.push(line);
    // nothing older than the last MAX lines can be visible, so a flood never builds an unbounded queue
    if (this.queue.length > MAX_CONSOLE_LINES * 2) this.queue = this.queue.slice(-MAX_CONSOLE_LINES);
    if (this.scheduled === null) {
      this.scheduled = this.schedule(() => {
        this.scheduled = null;
        this.drain();
      });
    }
  }

  drain(): void {
    if (this.queue.length === 0) return;
    const lines = this.queue;
    this.queue = [];
    this.flush(lines);
  }

  dispose(): void {
    if (this.scheduled !== null) this.cancel(this.scheduled);
    this.scheduled = null;
    this.queue = [];
  }
}
