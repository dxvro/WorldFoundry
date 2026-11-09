import { describe, expect, it } from 'vitest';
import { AppError } from '../src/http/errors.js';
import { IGNORE_UNRECOGNIZED_VM_OPTIONS, aikarFlags, buildJavaArgs } from '../src/process/command.js';
import { LineAssembler, MAX_LINE_LENGTH, RingBuffer, TRUNCATION_MARK } from '../src/process/lines.js';
import { MetricsSampler, parseCpuTime, parseProcStat, parseWindowsSamples, type RawSample } from '../src/process/metrics.js';
import { classifyLine } from '../src/process/patterns.js';
import { tokenizeArgs } from '../src/process/tokenize.js';

describe('tokenizeArgs', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(tokenizeArgs('')).toEqual([]);
    expect(tokenizeArgs('   ')).toEqual([]);
    expect(tokenizeArgs('-Da=1  -Db=2\t-Dc=3')).toEqual(['-Da=1', '-Db=2', '-Dc=3']);
    expect(tokenizeArgs('-Dname="two words" \'single quoted\' plain')).toEqual(['-Dname=two words', 'single quoted', 'plain']);
    expect(tokenizeArgs('-Dpath="C:\\Program Files\\x"')).toEqual(['-Dpath=C:\\Program Files\\x']);
    expect(tokenizeArgs('"say \\"hi\\""')).toEqual(['say "hi"']);
    expect(tokenizeArgs('a "" b')).toEqual(['a', '', 'b']);
    expect(tokenizeArgs(`"it's"`)).toEqual(["it's"]);
  });

  it('rejects unbalanced quotes and control characters with a 422', () => {
    for (const bad of ['-Dx="open', "-Dx='open", '-Dx=1\n-Dy=2', 'a\u0000b']) {
      try {
        tokenizeArgs(bad);
        expect.unreachable(bad);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect(error).toMatchObject({ statusCode: 422, code: 'INVALID_JVM_ARGS' });
      }
    }
  });
});

describe('buildJavaArgs', () => {
  const base = { minRamMb: 1024, maxRamMb: 4096, useAikarFlags: false, extraJvmArgs: '', platform: 'win32' as const };

  it('puts memory first, encodings before the launch target and nogui last (jar)', () => {
    expect(buildJavaArgs({ ...base, launch: { kind: 'jar', jar: 'server.jar' } })).toEqual([
      '-Xms1024M',
      '-Xmx4096M',
      '-Dfile.encoding=UTF-8',
      '-Dstdout.encoding=UTF-8',
      '-Dstderr.encoding=UTF-8',
      '-jar',
      'server.jar',
      'nogui',
    ]);
  });

  it('uses @argsfile for the platform and keeps nogui as program argument', () => {
    const launch = { kind: 'args' as const, unixFile: 'libraries/x/unix_args.txt', winFile: 'libraries/x/win_args.txt' };
    expect(buildJavaArgs({ ...base, launch }).slice(-2)).toEqual(['@libraries/x/win_args.txt', 'nogui']);
    expect(buildJavaArgs({ ...base, launch, platform: 'linux' }).slice(-2)).toEqual(['@libraries/x/unix_args.txt', 'nogui']);
    expect(buildJavaArgs({ ...base, launch })).not.toContain('-jar');
  });

  it('inserts Aikar flags and extra args between memory and encodings', () => {
    const args = buildJavaArgs({ ...base, useAikarFlags: true, extraJvmArgs: '-Dfoo="a b" -XX:+UseZGC', launch: { kind: 'jar', jar: 's.jar' } });
    expect(args.slice(2, 4)).toEqual(['-XX:+IgnoreUnrecognizedVMOptions', '-XX:+UseG1GC']);
    expect(args).toContain('-Dfoo=a b');
    expect(args.indexOf('-XX:+UseZGC')).toBeGreaterThan(args.indexOf('-Daikars.new.flags=true'));
    expect(args.indexOf('-Dfile.encoding=UTF-8')).toBeGreaterThan(args.indexOf('-XX:+UseZGC'));
  });

  it('adds IgnoreUnrecognizedVMOptions only together with the Aikar flags', () => {
    const launch = { kind: 'jar' as const, jar: 's.jar' };
    const on = buildJavaArgs({ ...base, useAikarFlags: true, launch });
    expect(on.indexOf(IGNORE_UNRECOGNIZED_VM_OPTIONS)).toBe(2);
    expect(on.filter((arg) => arg === IGNORE_UNRECOGNIZED_VM_OPTIONS)).toHaveLength(1);
    expect(on.indexOf(IGNORE_UNRECOGNIZED_VM_OPTIONS)).toBeLessThan(on.indexOf('-XX:+UnlockExperimentalVMOptions'));
    const off = buildJavaArgs({ ...base, useAikarFlags: false, extraJvmArgs: '-XX:+UseZGC', launch });
    expect(off).not.toContain(IGNORE_UNRECOGNIZED_VM_OPTIONS);
    expect(aikarFlags(4096)).not.toContain(IGNORE_UNRECOGNIZED_VM_OPTIONS);
  });

  it('switches to the large-heap Aikar values at 12 GB', () => {
    const small = aikarFlags(12 * 1024 - 1);
    const large = aikarFlags(12 * 1024);
    expect(small).toContain('-XX:G1NewSizePercent=30');
    expect(small).toContain('-XX:G1MaxNewSizePercent=40');
    expect(small).toContain('-XX:G1HeapRegionSize=8M');
    expect(small).toContain('-XX:G1ReservePercent=20');
    expect(small).toContain('-XX:InitiatingHeapOccupancyPercent=15');
    expect(large).toContain('-XX:G1NewSizePercent=40');
    expect(large).toContain('-XX:G1MaxNewSizePercent=50');
    expect(large).toContain('-XX:G1HeapRegionSize=16M');
    expect(large).toContain('-XX:G1ReservePercent=15');
    expect(large).toContain('-XX:InitiatingHeapOccupancyPercent=20');
  });

  it('propagates tokenizer errors', () => {
    expect(() => buildJavaArgs({ ...base, extraJvmArgs: '"x', launch: { kind: 'jar', jar: 's.jar' } })).toThrow(AppError);
  });
});

describe('classifyLine', () => {
  const prefixes: Array<[string, (message: string) => string]> = [
    ['vanilla', (m) => `[12:00:00] [Server thread/INFO]: ${m}`],
    ['paper', (m) => `[12:00:00 INFO]: ${m}`],
    ['forge', (m) => `[12:00:00] [Server thread/INFO] [net.minecraft.server.dedicated.DedicatedServer/]: ${m}`],
    ['mod loader tag', (m) => `[12:00:00] [Server thread/INFO] [minecraft/DedicatedServer]: ${m}`],
    ['dated', (m) => `[2026-11-04 12:00:00.123] [Server thread/INFO] (Minecraft) ${m}`.replace(') ', '): ')],
    ['logger without colon', (m) => `[12:00:00] [Server thread/INFO] (Minecraft) ${m}`],
  ];

  for (const [name, wrap] of prefixes) {
    it(`detects done/join/leave in ${name} format`, () => {
      expect(classifyLine(wrap('Done (1.234s)! For help, type "help"'))).toEqual({ type: 'done' });
      expect(classifyLine(wrap('Done (3,5s)! For help, type "help" or "?"'))).toEqual({ type: 'done' });
      expect(classifyLine(wrap('Steve joined the game'))).toEqual({ type: 'join', name: 'Steve' });
      expect(classifyLine(wrap('Steve left the game'))).toEqual({ type: 'leave', name: 'Steve' });
    });

    it(`cannot be spoofed by chat in ${name} format`, () => {
      expect(classifyLine(wrap('<Bob> Done (1.0s)! For help, type "help"'))).toBeNull();
      expect(classifyLine(wrap('<Bob> Steve joined the game'))).toBeNull();
      expect(classifyLine(wrap('[Server] Steve joined the game'))).toBeNull();
      expect(classifyLine(wrap('[Not Secure] <Bob> Steve left the game'))).toBeNull();
      expect(classifyLine(wrap('* Bob Steve joined the game'))).toBeNull();
      expect(classifyLine(wrap('Bob whispers to you: Steve joined the game'))).toBeNull();
    });
  }

  it('ignores lines without the log prefix and absurdly long lines', () => {
    expect(classifyLine('Done (1.0s)! For help, type "help"')).toBeNull();
    expect(classifyLine('Steve joined the game')).toBeNull();
    expect(classifyLine(`[12:00:00] [Server thread/INFO]: ${'x'.repeat(500)} joined the game`)).toBeNull();
    expect(classifyLine('[12:00:00] [Server thread/INFO]: Steve Smith joined the game')).toBeNull();
  });
});

describe('LineAssembler', () => {
  const collect = (feed: (assembler: LineAssembler) => void, max?: number): string[] => {
    const lines: string[] = [];
    const assembler = new LineAssembler((line) => lines.push(line), max);
    feed(assembler);
    return lines;
  };

  it('keeps multi-byte characters intact across chunk boundaries', () => {
    const bytes = Buffer.from('Grüße ☃ 😀\nsecond line\n', 'utf8');
    for (let split = 1; split < bytes.length; split++) {
      const lines = collect((a) => {
        a.push(bytes.subarray(0, split));
        a.push(bytes.subarray(split));
      });
      expect(lines).toEqual(['Grüße ☃ 😀', 'second line']);
    }
    const bytewise = collect((a) => {
      for (const byte of bytes) a.push(Buffer.from([byte]));
    });
    expect(bytewise).toEqual(['Grüße ☃ 😀', 'second line']);
  });

  it('joins partial lines, strips CR from CRLF and flushes a trailing line', () => {
    expect(
      collect((a) => {
        a.push(Buffer.from('par'));
        a.push(Buffer.from('tial\r\nnext\r'));
        a.push(Buffer.from('\nlast'));
        a.flush();
      }),
    ).toEqual(['partial', 'next', 'last']);
  });

  it('caps very long lines and discards the rest of that line', () => {
    const lines = collect((a) => {
      a.push(Buffer.from(`${'x'.repeat(100)}\nshort\n`));
      a.push(Buffer.from('y'.repeat(30)));
      a.push(Buffer.from('y'.repeat(30)));
      a.push(Buffer.from('\nnext\n'));
    }, 40);
    expect(lines[0]).toBe(`${'x'.repeat(40)}${TRUNCATION_MARK}`);
    expect(lines.slice(1)).toEqual(['short', `${'y'.repeat(40)}${TRUNCATION_MARK}`, 'next']);
    expect(MAX_LINE_LENGTH).toBeGreaterThan(1000);
  });

  it('emits no empty line for a flush without pending data', () => {
    expect(collect((a) => a.flush())).toEqual([]);
  });
});

describe('RingBuffer', () => {
  it('keeps only the newest entries', () => {
    const ring = new RingBuffer<number>(5);
    for (let i = 1; i <= 23; i++) ring.push(i);
    expect(ring.last()).toEqual([19, 20, 21, 22, 23]);
    expect(ring.last(2)).toEqual([22, 23]);
    expect(ring.size).toBe(5);
  });

  it('returns everything while below capacity', () => {
    const ring = new RingBuffer<string>(3);
    ring.push('a');
    ring.push('b');
    expect(ring.last()).toEqual(['a', 'b']);
    expect(ring.last(10)).toEqual(['a', 'b']);
  });

  it('stays bounded in memory for a long stream', () => {
    const ring = new RingBuffer<number>(2000);
    for (let i = 0; i < 100_000; i++) ring.push(i);
    expect(ring.last()).toHaveLength(2000);
    expect(ring.last()[1999]).toBe(99_999);
  });
});

describe('metrics parsing', () => {
  it('parses the Windows batch output', () => {
    const ticks = 639_000_000_000_000_000n;
    const out = `T ${ticks}\r\nP 1234 30000000 52428800\r\nP 99 0 1024\r\ngarbage\r\n`;
    const samples = parseWindowsSamples(out);
    expect(samples.get(1234)).toEqual({ cpuMs: 3000, rssBytes: 52_428_800, atMs: Number(ticks / 10_000n) });
    expect(samples.size).toBe(2);
  });

  it('parses /proc/<pid>/stat including command names with spaces and parentheses', () => {
    const stat = '4242 (java (x) y) S 1 4242 4242 0 -1 4194304 100 0 0 0 150 50 0 0 20 0 30 0 100 1000000 5000 18446744073709551615';
    const sample = parseProcStat(stat, '1000 5000 100 1 0 200 0', 777);
    expect(sample).toEqual({ cpuMs: 2000, rssBytes: 5000 * 4096, atMs: 777 });
    expect(parseProcStat('garbage', 'x', 1)).toBeNull();
  });

  it('parses ps cputime', () => {
    expect(parseCpuTime('0:01.50')).toBe(1500);
    expect(parseCpuTime('01:02:03')).toBe(3_723_000);
    expect(parseCpuTime('2-00:00:10')).toBe(172_810_000);
    expect(parseCpuTime('nonsense')).toBeNull();
  });
});

describe('MetricsSampler', () => {
  it('normalizes CPU to cores from the delta between two samples', async () => {
    const readings: RawSample[] = [
      { cpuMs: 1000, rssBytes: 100, atMs: 10_000 },
      { cpuMs: 3000, rssBytes: 200, atMs: 12_000 },
    ];
    let call = 0;
    const seen: Array<Map<number, { cpuPercent: number; rssBytes: number }>> = [];
    const sampler = new MetricsSampler(() => [7], (m) => seen.push(m), {
      cores: 4,
      read: async () => new Map([[7, readings[call++] as RawSample]]),
    });
    await sampler.poll();
    await sampler.poll();
    expect(seen[0]?.get(7)).toEqual({ cpuPercent: 0, rssBytes: 100 });
    // 2000 ms of CPU in 2000 ms on 4 cores = 25 %
    expect(seen[1]?.get(7)).toEqual({ cpuPercent: 25, rssBytes: 200 });
  });

  it('does not pile up overlapping polls and survives failing reads', async () => {
    let running = 0;
    let maxRunning = 0;
    let calls = 0;
    const errors: unknown[] = [];
    const sampler = new MetricsSampler(() => [1], () => undefined, {
      log: (e) => errors.push(e),
      read: async () => {
        calls++;
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 30));
        running--;
        throw new Error('powershell broken');
      },
    });
    await Promise.all([sampler.poll(), sampler.poll(), sampler.poll()]);
    expect(calls).toBe(1);
    expect(maxRunning).toBe(1);
    expect(errors).toHaveLength(1);
    await sampler.poll();
    expect(calls).toBe(2);
  });

  it('only reads when something runs', async () => {
    let reads = 0;
    const sampler = new MetricsSampler(() => [], () => undefined, { read: async () => (reads++, new Map()) });
    await sampler.poll();
    expect(reads).toBe(0);
  });
});
