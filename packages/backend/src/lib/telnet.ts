import net from 'node:net';
import { AppError } from '../http/errors.js';

// The admin console of 7 Days to Die: a plain telnet text stream. After "Please enter password:" the password is sent,
// "Logon successful." confirms it, then a command is sent and its output collected until the stream is quiet for a moment.
export interface TelnetTarget {
  port: number;
  password: string;
  host?: string;
  timeoutMs?: number;
  // how long the output must be quiet before the answer counts as complete
  quietMs?: number;
}

const unreachable = (): AppError => new AppError(502, 'GAME_CONSOLE_UNREACHABLE', 'The admin console of the server does not answer.');

export function telnetCommand(target: TelnetTarget, command: string): Promise<string> {
  if (/[\r\n]/.test(command)) return Promise.reject(new AppError(422, 'COMMAND_INVALID', 'A command must be one line.'));
  const quietMs = target.quietMs ?? 400;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: target.host ?? '127.0.0.1', port: target.port });
    let text = '';
    let stage: 'password' | 'login' | 'command' | 'done' = 'password';
    let answerStart = 0;
    let quiet: NodeJS.Timeout | null = null;
    const finish = (error: Error | null): void => {
      if (stage === 'done') return;
      stage = 'done';
      clearTimeout(timer);
      if (quiet !== null) clearTimeout(quiet);
      socket.end('exit\r\n');
      socket.destroy();
      if (error !== null) reject(error);
      else resolve(cleanAnswer(text.slice(answerStart), command));
    };
    const timer = setTimeout(() => finish(stage === 'command' ? null : unreachable()), target.timeoutMs ?? 5000);
    socket.setEncoding('utf8');
    socket.on('error', () => finish(unreachable()));
    socket.on('close', () => finish(stage === 'command' ? null : unreachable()));
    socket.on('data', (chunk: string) => {
      text += chunk;
      if (text.length > 512 * 1024) text = text.slice(-256 * 1024);
      if (stage === 'password' && /password:/i.test(text)) {
        stage = 'login';
        socket.write(`${target.password}\r\n`);
      } else if (stage === 'login' && /Logon successful/i.test(text)) {
        stage = 'command';
        answerStart = text.length;
        socket.write(`${command}\r\n`);
      } else if (stage === 'login' && /Password incorrect|wrong password/i.test(text)) {
        finish(new AppError(502, 'GAME_CONSOLE_DENIED', 'The admin console of the server refused the password.'));
      }
      if (stage === 'command' && text.length > answerStart) {
        if (quiet !== null) clearTimeout(quiet);
        quiet = setTimeout(() => finish(null), quietMs);
      }
    });
  });
}

// drops the echo of the command and the log lines 7 Days to Die prints into every session
export function cleanAnswer(raw: string, command: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== '' && line.trim() !== command && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d \d+\.\d+ INF Executing command '/.test(line))
    .join('\n');
}
