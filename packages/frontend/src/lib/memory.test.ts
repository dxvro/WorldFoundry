import { describe, expect, it } from 'vitest';
import { memoryText, parseMemory, unitFor } from './memory';

describe('typed memory', () => {
  it('converts KB, MB and GB to whole megabytes', () => {
    expect(parseMemory('6', 'GB')).toBe(6144);
    expect(parseMemory('1,5', 'GB')).toBe(1536);
    expect(parseMemory(' 3000 ', 'MB')).toBe(3000);
    expect(parseMemory('2097152', 'KB')).toBe(2048);
    expect(parseMemory('1500', 'KB')).toBe(1);
  });

  it('refuses text that is not a positive number', () => {
    for (const text of ['', 'abc', '-2', '1e3', '0', '100', '1.2.3']) expect(parseMemory(text, text === '100' ? 'KB' : 'GB')).toBeNull();
  });

  it('shows the value in the chosen unit', () => {
    expect(unitFor(10240)).toBe('GB');
    expect(unitFor(3000)).toBe('MB');
    expect(memoryText(10240, 'GB')).toBe('10');
    expect(memoryText(3000, 'GB')).toBe('2.93');
    expect(memoryText(2048, 'KB')).toBe('2097152');
  });
});
