import { createWriteStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { AppError } from '../http/errors.js';

// Writes an uploaded request body to `file` without buffering it, and stops as soon as it grows past `maxBytes`.
// Not stream.pipeline: on an error that would destroy the request, and with it the connection the 413 is sent on.
// Returns the number of bytes received; throws UPLOAD_EMPTY for an empty body.
export async function receiveToFile(stream: Readable, file: string, maxBytes: number, tooLarge: () => AppError): Promise<number> {
  let received = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(file, { flags: 'wx' });
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        stream.pause();
        stream.removeListener('data', onData);
        out.destroy();
        reject(error);
      };
      const onData = (chunk: Buffer): void => {
        received += chunk.length;
        if (received > maxBytes) {
          fail(tooLarge());
          return;
        }
        if (!out.write(chunk)) {
          stream.pause();
          out.once('drain', () => stream.resume());
        }
      };
      stream.on('data', onData);
      stream.on('end', () => {
        if (settled) return;
        settled = true;
        out.end(() => resolve());
      });
      stream.on('error', fail);
      stream.on('close', () => {
        if (!(stream as { readableEnded?: boolean }).readableEnded) fail(Object.assign(new Error('closed'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
      });
      out.on('error', fail);
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOSPC') throw new AppError(507, 'DISK_FULL', 'There is not enough free disk space.');
    if (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET' || code === 'ABORT_ERR') {
      throw new AppError(400, 'UPLOAD_ABORTED', 'The upload was cancelled.');
    }
    throw error;
  }
  if (received === 0) throw new AppError(400, 'UPLOAD_EMPTY', 'No file was transferred.');
  return received;
}
