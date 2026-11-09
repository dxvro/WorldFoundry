import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { AppError } from '../http/errors.js';
import { stripAnsi } from '../process/lines.js';

export const INSTALL_LOG_FILE = 'install.log';
export const DEFAULT_TAIL = 500;
export const MAX_TAIL = 5000;
const MAX_LINE_LENGTH = 4000;
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) ([\s\S]*)$/;
// control characters other than tab never belong in a log shown to the user
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

export interface InstallLogLine {
  // zero-based line number in the file; install.log events carry the same number
  seq: number;
  time: number | null;
  text: string;
}

export interface InstallLogView {
  lines: InstallLogLine[];
  totalLines: number;
  truncated: boolean;
}

async function regularFile(file: string): Promise<boolean> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new AppError(409, 'INSTALL_LOG_UNSAFE', 'The log file is not a regular file and will not be read.');
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function parseLine(seq: number, raw: string): InstallLogLine {
  const clean = stripAnsi(raw).replace(CONTROL, '');
  const match = TIMESTAMP.exec(clean);
  const text = (match?.[2] ?? clean).slice(0, MAX_LINE_LENGTH);
  return { seq, time: match?.[1] === undefined ? null : Date.parse(match[1]), text };
}

// Streams the file once: counts every line and keeps only the last `tail`
export async function readInstallLog(serverDir: string, tail: number): Promise<InstallLogView> {
  const file = path.join(serverDir, INSTALL_LOG_FILE);
  if (!(await regularFile(file))) return { lines: [], totalLines: 0, truncated: false };
  const keep: Array<{ seq: number; raw: string }> = [];
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let total = 0;
  const push = (raw: string): void => {
    keep.push({ seq: total++, raw: raw.endsWith('\r') ? raw.slice(0, -1) : raw });
    if (keep.length > tail * 2) keep.splice(0, keep.length - tail);
  };
  const consume = (text: string): void => {
    pending += text;
    let index = pending.indexOf('\n');
    while (index !== -1) {
      push(pending.slice(0, index));
      pending = pending.slice(index + 1);
      index = pending.indexOf('\n');
    }
    // a runaway line without newline must not grow without bound
    if (pending.length > MAX_LINE_LENGTH * 4) pending = pending.slice(-MAX_LINE_LENGTH * 4);
  };
  for await (const chunk of createReadStream(file)) consume(decoder.write(chunk as Buffer));
  consume(decoder.end());
  if (pending !== '') push(pending);
  const lines = keep.slice(-tail).map((entry) => parseLine(entry.seq, entry.raw));
  return { lines, totalLines: total, truncated: total > lines.length };
}

export async function countLogLines(serverDir: string): Promise<number> {
  const file = path.join(serverDir, INSTALL_LOG_FILE);
  if (!(await regularFile(file))) return 0;
  let count = 0;
  let last = 0x0a;
  for await (const chunk of createReadStream(file)) {
    for (const byte of chunk as Buffer) if (byte === 0x0a) count++;
    last = (chunk as Buffer)[(chunk as Buffer).length - 1] ?? last;
  }
  return last === 0x0a ? count : count + 1;
}
