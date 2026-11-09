import { describe, expect, it } from 'vitest';
import { CommandHistory, MAX_COMMAND_HISTORY } from './history';

describe('CommandHistory', () => {
  it('walks back with up and forward with down, returning to the draft', () => {
    const history = new CommandHistory(['list', 'say hi', 'time set day']);
    expect(history.previous('halb getippt')).toBe('time set day');
    expect(history.previous('')).toBe('say hi');
    expect(history.previous('')).toBe('list');
    expect(history.previous('')).toBeNull();
    expect(history.next()).toBe('say hi');
    expect(history.next()).toBe('time set day');
    expect(history.next()).toBe('halb getippt');
    expect(history.next()).toBeNull();
  });

  it('ignores empty commands and immediate repeats, and resets the cursor on push', () => {
    const history = new CommandHistory();
    history.push('  ');
    history.push('list');
    history.push('list');
    expect(history.items).toEqual(['list']);
    history.previous('');
    history.push('stop');
    expect(history.previous('')).toBe('stop');
  });

  it('keeps only the newest entries', () => {
    const history = new CommandHistory();
    for (let i = 0; i < MAX_COMMAND_HISTORY + 20; i++) history.push(`cmd ${i}`);
    expect(history.items).toHaveLength(MAX_COMMAND_HISTORY);
    expect(history.items.at(-1)).toBe(`cmd ${MAX_COMMAND_HISTORY + 19}`);
  });

  it('has nothing to recall when empty', () => {
    expect(new CommandHistory().previous('x')).toBeNull();
  });
});
