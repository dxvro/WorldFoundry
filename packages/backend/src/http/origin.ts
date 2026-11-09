import type { FastifyInstance } from 'fastify';
import { AppError } from './errors.js';
import { dropUpgradeAfterResponse, isUpgradeRequest } from './upgrade.js';

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

export function isOriginAllowed(origin: string, host: string | undefined, allowedOrigins: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (allowedOrigins.includes(parsed.origin)) return true;
  return host !== undefined && parsed.host.toLowerCase() === host.toLowerCase();
}

// Blocks cross-site requests that change state or open a console: a request whose Origin does not
// match the Host (or the allowlist) is rejected. Requests without Origin (curl, scripts) pass.
export function registerOriginGuard(app: FastifyInstance, allowedOrigins: readonly string[]): void {
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin === undefined) return;
    if (SAFE_METHODS.has(request.method) && !isUpgradeRequest(request)) return;
    if (!isOriginAllowed(origin, request.headers.host, allowedOrigins)) {
      dropUpgradeAfterResponse(request, reply);
      throw new AppError(403, 'ORIGIN_FORBIDDEN', 'The request comes from a disallowed origin and was rejected.');
    }
  });
}
