import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../http/errors.js';

// What an update download really touches (checked on 2026-11-05): the API, github.com (redirect of release
// downloads) and release-assets.githubusercontent.com; objects.githubusercontent.com is the older redirect target.
export const UPDATE_ALLOWED_HOSTS: readonly string[] = ['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'];
const MAX_REDIRECTS = 5;

export interface UpdateHttpOptions {
  fetch: typeof fetch;
  allowedHosts: readonly string[];
  timeoutMs: number;
  userAgent: string;
  // test builds only: plain http towards one of the allowed hosts (the local fake GitHub)
  allowInsecureHttp?: boolean;
  signal?: AbortSignal;
}

const rejected = (host: string): AppError => new AppError(502, 'UPDATE_URL_REJECTED', `Downloads from "${host}" are not allowed for updates.`, undefined, { host });

export function assertUpdateUrl(raw: string, options: Pick<UpdateHttpOptions, 'allowedHosts' | 'allowInsecureHttp'>): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(502, 'UPDATE_URL_REJECTED', 'The update address is invalid.');
  }
  const insecure = options.allowInsecureHttp === true && url.protocol === 'http:';
  if (url.protocol !== 'https:' && !insecure) throw rejected(url.hostname);
  if (!options.allowedHosts.includes(url.hostname)) throw rejected(url.hostname);
  // production hosts are only reachable on the default port
  if (!insecure && options.allowInsecureHttp !== true && url.port !== '') throw rejected(url.hostname);
  if (url.username !== '' || url.password !== '') throw rejected(url.hostname);
  return url;
}

// Follows redirects by hand so that every hop is checked against the allowlist. No credentials are ever sent.
export async function fetchUpdate(rawUrl: string, options: UpdateHttpOptions, accept = 'application/octet-stream'): Promise<Response> {
  let url = assertUpdateUrl(rawUrl, options);
  for (let hop = 0; ; hop++) {
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(options.timeoutMs);
      response = await options.fetch(url, {
        redirect: 'manual',
        headers: { 'User-Agent': options.userAgent, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' },
        signal: options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        if (options.signal?.aborted === true) throw new AppError(499, 'UPDATE_ABORTED', 'The operation was cancelled.');
        throw new AppError(504, 'UPDATE_TIMEOUT', 'The connection to GitHub took too long.');
      }
      throw new AppError(502, 'UPDATE_UNREACHABLE', 'GitHub is not reachable. Please check the internet connection.');
    }
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      if (location === null || hop >= MAX_REDIRECTS) throw new AppError(502, 'UPDATE_DOWNLOAD_FAILED', 'Too many or invalid redirects during the update download.');
      url = assertUpdateUrl(new URL(location, url).href, options);
      continue;
    }
    return response;
  }
}

export async function fetchSmallBuffer(url: string, options: UpdateHttpOptions, maxBytes: number, accept?: string): Promise<Buffer> {
  const response = await fetchUpdate(url, options, accept);
  if (!response.ok || response.body === null) {
    void response.body?.cancel().catch(() => undefined);
    throw new AppError(502, 'UPDATE_DOWNLOAD_FAILED', `The download failed (HTTP ${response.status}).`, undefined, { status: response.status });
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    void response.body.cancel().catch(() => undefined);
    throw new AppError(502, 'UPDATE_TOO_LARGE', 'The response from GitHub is unexpectedly large and was rejected.');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of Readable.fromWeb(response.body as never) as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > maxBytes) throw new AppError(502, 'UPDATE_TOO_LARGE', 'The response from GitHub is unexpectedly large and was rejected.');
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, 'UPDATE_DOWNLOAD_FAILED', 'The download was interrupted.');
  }
  return Buffer.concat(chunks);
}

export interface DownloadResult {
  sha256: string;
  size: number;
}

export interface DownloadOptions extends UpdateHttpOptions {
  maxBytes: number;
  expectedSize?: number;
  onProgress?: (received: number, total: number | null) => void;
}

// Streams to "<destination>.part", checks the size limit while receiving, renames on success
export async function downloadFile(url: string, destination: string, options: DownloadOptions): Promise<DownloadResult> {
  const response = await fetchUpdate(url, options);
  if (!response.ok || response.body === null) {
    void response.body?.cancel().catch(() => undefined);
    throw new AppError(502, 'UPDATE_DOWNLOAD_FAILED', `The download failed (HTTP ${response.status}).`, undefined, { status: response.status });
  }
  const headerLength = response.headers.get('content-length');
  const total = headerLength !== null && /^\d+$/.test(headerLength) ? Number(headerLength) : null;
  if ((total ?? options.expectedSize ?? 0) > options.maxBytes) {
    void response.body.cancel().catch(() => undefined);
    throw new AppError(502, 'UPDATE_TOO_LARGE', 'The update file is larger than allowed and was rejected.');
  }
  await mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.part`;
  const hash = createHash('sha256');
  let received = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > options.maxBytes) {
        callback(new AppError(502, 'UPDATE_TOO_LARGE', 'The update file is larger than allowed and the download was cancelled.'));
        return;
      }
      hash.update(chunk);
      options.onProgress?.(received, total ?? options.expectedSize ?? null);
      callback(null, chunk);
    },
  });
  try {
    const limit = AbortSignal.timeout(Math.max(options.timeoutMs * 20, 30 * 60_000));
    await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(partial, { flags: 'w', mode: 0o600 }), {
      signal: options.signal === undefined ? limit : AbortSignal.any([limit, options.signal]),
    });
    if (options.expectedSize !== undefined && received !== options.expectedSize) {
      throw new AppError(502, 'UPDATE_SIZE_MISMATCH', 'The downloaded file does not have the announced size.');
    }
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    if (error instanceof AppError) throw error;
    if (options.signal?.aborted === true) throw new AppError(499, 'UPDATE_ABORTED', 'The operation was cancelled.');
    throw new AppError(502, 'UPDATE_DOWNLOAD_FAILED', 'The download was interrupted.');
  }
  return { sha256: hash.digest('hex'), size: received };
}
