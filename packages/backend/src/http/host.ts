import net from 'node:net';
import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import { AppError } from './errors.js';
import { dropUpgradeAfterResponse } from './upgrade.js';

const MACHINE_SUFFIXES = ['', '.local', '.lan', '.home', '.home.arpa', '.fritz.box'] as const;
const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
const PORT = /^:\d{1,5}$/;

// Extracts the lowercase host name from a Host header value ("name", "name:port", "1.2.3.4:port",
// "[::1]:port"); anything else, including user info, paths and whitespace, is invalid.
export function parseHostHeader(value: string): string | null {
  const text = value.toLowerCase();
  let hostname: string;
  let rest: string;
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end < 0) return null;
    hostname = text.slice(1, end);
    rest = text.slice(end + 1);
    if (net.isIP(hostname) !== 6) return null;
  } else {
    const colon = text.indexOf(':');
    hostname = colon < 0 ? text : text.slice(0, colon);
    rest = colon < 0 ? '' : text.slice(colon);
    if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
    const valid = net.isIP(hostname) === 4 || (hostname.length <= 253 && hostname.split('.').every((label) => LABEL.test(label)));
    if (!valid) return null;
  }
  return rest === '' || PORT.test(rest) ? hostname : null;
}

// Host names that may address this server: IP literals, localhost, this machine's name, and the
// ALLOWED_HOSTS entries. A DNS-rebinding page reaches the server under its own domain, so that Host
// value is the one thing that must not pass.
export function isHostAllowed(header: string | undefined, allowedHosts: readonly string[], machineName: string): boolean {
  if (header === undefined) return false;
  const hostname = parseHostHeader(header);
  if (hostname === null) return false;
  if (net.isIP(hostname) !== 0 || hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (allowedHosts.includes(hostname)) return true;
  const machine = machineName.toLowerCase();
  return MACHINE_SUFFIXES.some((suffix) => hostname === `${machine}${suffix}`);
}

export function registerHostGuard(app: FastifyInstance, allowedHosts: readonly string[], machineName: string = os.hostname()): void {
  app.addHook('onRequest', async (request, reply) => {
    if (isHostAllowed(request.headers.host, allowedHosts, machineName)) return;
    dropUpgradeAfterResponse(request, reply);
    throw new AppError(403, 'HOST_FORBIDDEN', 'The host of the request is not allowed. Further names can be allowed via ALLOWED_HOSTS or in the web interface under System > Network & Access.');
  });
}
