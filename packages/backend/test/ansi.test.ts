import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LineAssembler, stripAnsi } from '../src/process/lines.js';
import { classifyLine } from '../src/process/patterns.js';
import { ServerEnv, waitFor } from './server-env.js';

const ESC = '\x1b';
const COLOURED_DONE = `${ESC}[0;37m[12:00:00 ${ESC}[32mINFO${ESC}[0;37m]${ESC}[m: Done (1.234s)! For help, type "help"${ESC}[m`;
const COLOURED_JOIN = `${ESC}[0;37m[12:00:00 ${ESC}[32mINFO${ESC}[0;37m]${ESC}[m: Steve joined the game${ESC}[m`;

const assemble = (chunks: Array<string | Buffer>): string[] => {
  const lines: string[] = [];
  const assembler = new LineAssembler((line) => lines.push(line));
  for (const chunk of chunks) assembler.push(Buffer.from(chunk));
  assembler.flush();
  return lines;
};

describe('ANSI sequences in the line pipeline', () => {
  it('strips colour sequences so the Done and join lines are classified', () => {
    const [done, join] = assemble([`${COLOURED_DONE}\n${COLOURED_JOIN}\n`]);
    expect(done).toBe('[12:00:00 INFO]: Done (1.234s)! For help, type "help"');
    expect(join).toBe('[12:00:00 INFO]: Steve joined the game');
    expect(classifyLine(done ?? '')).toEqual({ type: 'done' });
    expect(classifyLine(join ?? '')).toEqual({ type: 'join', name: 'Steve' });
  });

  it('strips a sequence that is split across chunks, at every possible position', () => {
    const text = `${COLOURED_DONE}\n`;
    for (let cut = 1; cut < text.length; cut++) {
      expect(assemble([text.slice(0, cut), text.slice(cut)]), `cut at ${cut}`).toEqual(['[12:00:00 INFO]: Done (1.234s)! For help, type "help"']);
    }
    const bytes = Buffer.from(text);
    const single = [...bytes].map((byte) => Buffer.from([byte]));
    expect(assemble(single)).toEqual(['[12:00:00 INFO]: Done (1.234s)! For help, type "help"']);
  });

  it('strips OSC sequences, cursor sequences and a sequence cut off at the line end', () => {
    expect(stripAnsi(`${ESC}]0;Titel\x07text`)).toBe('text');
    expect(stripAnsi(`${ESC}]8;;https://example.org${ESC}\\Link${ESC}]8;;${ESC}\\`)).toBe('Link');
    expect(stripAnsi(`${ESC}[2K${ESC}[1Gline${ESC}[?25h`)).toBe('line');
    expect(stripAnsi(`abc${ESC}[3`)).toBe('abc');
    expect(assemble([`end${ESC}[0;3`])).toEqual(['end']);
  });

  it('leaves ordinary text, including brackets, untouched', () => {
    expect(stripAnsi('[12:00:00 INFO]: <Bob> [x] (y) 1;2m')).toBe('[12:00:00 INFO]: <Bob> [x] (y) 1;2m');
    expect(assemble(['a\r\nb\n'])).toEqual(['a', 'b']);
  });

  it('does not let colour codes turn chat into a status line', () => {
    const [line] = assemble([`${ESC}[0;37m[12:00:00 INFO]: <Bob> Done (1.0s)! For help, type "help"${ESC}[m\n`]);
    expect(classifyLine(line ?? '')).toBeNull();
  });
});

describe('a coloured server console', () => {
  let env: ServerEnv;
  beforeEach(async () => {
    env = await ServerEnv.create();
  });
  afterEach(async () => {
    await env.close();
  });

  it('reaches online, tracks players and stores clean console text', async () => {
    env.spawner.format = 'ansi';
    const server = await env.addServer();
    expect((await env.call('POST', `/api/servers/${server.id}/start`)).status).toBe(200);
    await env.waitState(server.id, 'online');
    await env.services.manager.sendCommand(server.id, 'join Steve');
    await waitFor(() => env.services.manager.status(server.id).players.includes('Steve') || undefined);
    const texts = env.services.manager.history(server.id).map((line) => line.text);
    expect(texts.some((text) => text.includes('Done (1.234s)!'))).toBe(true);
    expect(texts.filter((text) => text.includes(ESC))).toEqual([]);
  });
});
