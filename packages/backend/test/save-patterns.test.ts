import { describe, expect, it } from 'vitest';
import { classifySaveLine } from '../src/process/patterns.js';

const vanilla = (message: string): string => `[12:00:00] [Server thread/INFO]: ${message}`;
const paper = (message: string): string => `[12:00:00 INFO]: ${message}`;
const forge = (message: string): string => `[12:00:00] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: ${message}`;
const fabric = (message: string): string => `[12:00:00] [Server thread/INFO] (Minecraft) ${message}`;

describe('save command feedback', () => {
  it.each([vanilla, paper, forge, fabric])('is recognized with every log format (%#)', (wrap) => {
    expect(classifySaveLine(wrap('Automatic saving is now disabled'))).toBe('off');
    expect(classifySaveLine(wrap('Saved the game'))).toBe('flushed');
    expect(classifySaveLine(wrap('Automatic saving is now enabled'))).toBe('on');
    expect(classifySaveLine(wrap('Could not save the game (is there enough disk space?)'))).toBe('failed');
  });

  it('knows the wording of older versions and the "already" answers', () => {
    expect(classifySaveLine(vanilla('Turned off world auto-saving'))).toBe('off');
    expect(classifySaveLine(vanilla('Turned on world auto-saving'))).toBe('on');
    expect(classifySaveLine(vanilla('Saved the world'))).toBe('flushed');
    expect(classifySaveLine(paper('Save complete.'))).toBe('flushed');
    expect(classifySaveLine(vanilla('Saving is already turned off.'))).toBe('off');
    expect(classifySaveLine(vanilla('Saving is already turned on.'))).toBe('on');
  });

  it('accepts the [Server: ...] and [Rcon: ...] wrapping and trailing dots or blanks', () => {
    expect(classifySaveLine(vanilla('[Server: Saved the game]'))).toBe('flushed');
    expect(classifySaveLine(vanilla('[Rcon: Automatic saving is now disabled]'))).toBe('off');
    expect(classifySaveLine(vanilla('Saved the game. '))).toBe('flushed');
    expect(classifySaveLine(vanilla('saved the game'))).toBe('flushed');
  });

  it('recognizes servers that do not know the flush argument', () => {
    expect(classifySaveLine(paper('Unknown or incomplete command, see below for error'))).toBe('unsupported');
    expect(classifySaveLine(vanilla('Incorrect argument for command'))).toBe('unsupported');
    expect(classifySaveLine(paper('Usage: /save-all'))).toBe('unsupported');
  });

  it('cannot be triggered by chat, by the saving progress line or by other text', () => {
    expect(classifySaveLine(vanilla('<Bob> Saved the game'))).toBeNull();
    expect(classifySaveLine(vanilla('[Server] Saved the game'))).toBeNull();
    expect(classifySaveLine(paper('<Bob> Automatic saving is now disabled'))).toBeNull();
    expect(classifySaveLine(vanilla('Saving the game (this may take a moment!)'))).toBeNull();
    expect(classifySaveLine('Saved the game')).toBeNull();
    expect(classifySaveLine(vanilla('Steve joined the game'))).toBeNull();
    expect(classifySaveLine(vanilla(`Saved the game${'!'.repeat(500)}`))).toBeNull();
  });
});
