import { describe, expect, it, vi } from 'vitest';
import { line, lines } from '../test/fakes';
import { LineBatcher, MAX_CONSOLE_LINES, appendLines, applyHistory, emptyConsole, filterRows } from './model';

describe('appendLines', () => {
  it('appends in order and tracks the highest seq', () => {
    const model = appendLines(emptyConsole(), lines(1, 3));
    expect(model.rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(model.lastSeq).toBe(3);
  });

  it('drops lines it has already seen', () => {
    const first = appendLines(emptyConsole(), lines(1, 5));
    const again = appendLines(first, [line(4), line(5), line(6)]);
    expect(again.rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(appendLines(again, lines(1, 6))).toBe(again);
  });

  it('marks a gap instead of hiding missing lines', () => {
    const model = appendLines(appendLines(emptyConsole(), lines(1, 2)), [line(6)]);
    expect(model.rows.map((row) => row.stream)).toEqual(['stdout', 'stdout', 'gap', 'stdout']);
    expect(model.rows[2]?.text).toContain('3 lines');
    expect(model.lastSeq).toBe(6);
  });

  it('does not report a gap for the first lines it ever sees', () => {
    const model = appendLines(emptyConsole(), lines(500, 502));
    expect(model.rows.some((row) => row.stream === 'gap')).toBe(false);
  });

  it('never holds more than the 2000 lines the backend keeps', () => {
    const model = appendLines(emptyConsole(), lines(1, MAX_CONSOLE_LINES + 300));
    expect(model.rows).toHaveLength(MAX_CONSOLE_LINES);
    expect(model.rows[0]?.seq).toBe(301);
    expect(model.rows.at(-1)?.seq).toBe(MAX_CONSOLE_LINES + 300);
  });
});

describe('applyHistory after a reconnect', () => {
  it('continues seamlessly: overlap is not duplicated, new lines are added', () => {
    const before = appendLines(emptyConsole(), lines(1, 50));
    const after = applyHistory(before, lines(30, 80));
    expect(after.rows.map((row) => row.seq)).toEqual(Array.from({ length: 80 }, (_, i) => i + 1));
  });

  it('shows a gap when the buffer no longer reaches back to what was seen', () => {
    const before = appendLines(emptyConsole(), lines(1, 10));
    const after = applyHistory(before, lines(2001, 2100));
    const gap = after.rows.find((row) => row.stream === 'gap');
    expect(gap?.text).toContain('1990 lines');
    expect(after.lastSeq).toBe(2100);
  });

  it('starts over when numbering restarted (backend restart)', () => {
    const before = appendLines(emptyConsole(), lines(1, 400));
    const after = applyHistory(before, lines(1, 12));
    expect(after.rows).toHaveLength(12);
    expect(after.lastSeq).toBe(12);
  });

  it('keeps the model for an empty history', () => {
    const before = appendLines(emptyConsole(), lines(1, 3));
    expect(applyHistory(before, [])).toBe(before);
  });
});

describe('filterRows', () => {
  const model = appendLines(emptyConsole(), [
    line(1, 'Player Alex joins', 'stdout'),
    line(2, 'FEHLER im Tick', 'stderr'),
    line(3, 'say hallo', 'input'),
    line(4, 'Server gestartet', 'system'),
  ]);
  const all = new Set(['stdout', 'stderr', 'input', 'system'] as const);

  it('filters by text case-insensitively', () => {
    expect(filterRows(model.rows, { text: 'fehler', streams: all }).map((row) => row.seq)).toEqual([2]);
  });

  it('filters by stream', () => {
    expect(filterRows(model.rows, { text: '', streams: new Set(['input', 'system'] as const) }).map((row) => row.seq)).toEqual([3, 4]);
  });

  it('matches the displayed text when a display function is given', () => {
    const withRef = appendLines(emptyConsole(), [{ ...line(1, 'Server stopped (exit code 1).', 'system'), textRef: { key: 'SERVER_STOPPED', params: { code: 1 } } }]);
    const display = (): string => 'Server halted (exit code 1).';
    expect(filterRows(withRef.rows, { text: 'halted', streams: all }, display)).toHaveLength(1);
    expect(filterRows(withRef.rows, { text: 'halted', streams: all })).toHaveLength(0);
    expect(filterRows(withRef.rows, { text: 'stopped', streams: all }, display)).toHaveLength(0);
  });

  it('returns the same array when nothing is filtered', () => {
    expect(filterRows(model.rows, { text: '  ', streams: all })).toBe(model.rows);
  });
});

describe('LineBatcher', () => {
  it('hands many lines over in one flush per interval', () => {
    const flush = vi.fn();
    const callbacks: Array<() => void> = [];
    const batcher = new LineBatcher(
      flush,
      (callback) => callbacks.push(callback),
      () => undefined,
    );
    for (const entry of lines(1, 500)) batcher.push(entry);
    expect(flush).not.toHaveBeenCalled();
    expect(callbacks).toHaveLength(1);
    callbacks[0]?.();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0]?.[0]).toHaveLength(500);
    batcher.push(line(501));
    expect(callbacks).toHaveLength(2);
  });

  it('keeps its queue bounded during a flood', () => {
    const flush = vi.fn();
    const batcher = new LineBatcher(
      flush,
      () => 1,
      () => undefined,
    );
    for (const entry of lines(1, MAX_CONSOLE_LINES * 5)) batcher.push(entry);
    batcher.drain();
    const flushed = flush.mock.calls[0]?.[0] as Array<{ seq: number }>;
    expect(flushed.length).toBeLessThanOrEqual(MAX_CONSOLE_LINES * 2);
    expect(flushed.at(-1)?.seq).toBe(MAX_CONSOLE_LINES * 5);
  });

  it('drops pending lines on dispose', () => {
    const flush = vi.fn();
    const cancel = vi.fn();
    const batcher = new LineBatcher(flush, () => 7, cancel);
    batcher.push(line(1));
    batcher.dispose();
    batcher.drain();
    expect(cancel).toHaveBeenCalledWith(7);
    expect(flush).not.toHaveBeenCalled();
  });
});
