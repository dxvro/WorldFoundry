import net from 'node:net';
import { AppError } from '../http/errors.js';

// Source RCON (https://developer.valvesoftware.com/wiki/Source_RCON_Protocol): little-endian int32 size, id, type,
// then the body and two zero bytes. ARK uses it for console commands; one connection per command keeps it simple.
const AUTH = 3;
const EXEC = 2;
const AUTH_RESPONSE = 2;
const MAX_PACKET = 64 * 1024;

export function encodePacket(id: number, type: number, body: string): Buffer {
  const text = Buffer.from(body, 'utf8');
  const packet = Buffer.alloc(14 + text.length);
  packet.writeInt32LE(10 + text.length, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  text.copy(packet, 12);
  return packet;
}

export interface RconPacket {
  id: number;
  type: number;
  body: string;
}

// Splits a stream into packets; returns the packets and the bytes left for the next chunk
export function decodePackets(buffer: Buffer): { packets: RconPacket[]; rest: Buffer } {
  const packets: RconPacket[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const size = buffer.readInt32LE(offset);
    if (size < 10 || size > MAX_PACKET) throw new Error('invalid RCON packet');
    if (buffer.length - offset < size + 4) break;
    packets.push({ id: buffer.readInt32LE(offset + 4), type: buffer.readInt32LE(offset + 8), body: buffer.toString('utf8', offset + 12, offset + 4 + size - 2) });
    offset += size + 4;
  }
  return { packets, rest: buffer.subarray(offset) };
}

export interface RconOptions {
  host?: string;
  port: number;
  password: string;
  timeoutMs?: number;
}

const failed = (detail: string): AppError => new AppError(502, 'RCON_FAILED', `The server did not answer on RCON (${detail}).`, undefined, { reason: detail });

// Logs in, runs one command and returns its answer
export function rconCommand(options: RconOptions, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: options.host ?? '127.0.0.1', port: options.port });
    let buffer: Buffer = Buffer.alloc(0);
    let authed = false;
    let settled = false;
    const finish = (error: Error | null, value = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error === null) resolve(value);
      else reject(error);
    };
    const timer = setTimeout(() => finish(failed('timeout')), options.timeoutMs ?? 5000);
    socket.once('connect', () => socket.write(encodePacket(1, AUTH, options.password)));
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let decoded;
      try {
        decoded = decodePackets(buffer);
      } catch {
        finish(failed('invalid answer'));
        return;
      }
      buffer = decoded.rest;
      for (const packet of decoded.packets) {
        if (!authed) {
          if (packet.type !== AUTH_RESPONSE) continue;
          if (packet.id === -1) {
            finish(new AppError(502, 'RCON_AUTH_FAILED', 'The RCON password was refused.'));
            return;
          }
          authed = true;
          socket.write(encodePacket(2, EXEC, command));
        } else if (packet.id === 2) {
          finish(null, packet.body);
          return;
        }
      }
    });
    socket.once('error', (error: NodeJS.ErrnoException) => finish(failed(error.code ?? 'connection')));
    socket.once('close', () => finish(failed('closed')));
  });
}
