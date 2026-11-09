import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { targetsApi } from './auth.js';
import { notFoundHandler } from './errors.js';

const SPA_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

const HINT_PAGE = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WorldFoundry: web interface missing</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;background:#12151b;color:#e6e9ef}code{background:#232833;padding:.1em .4em;border-radius:4px}</style>
</head>
<body>
<h1>The web interface has not been built yet</h1>
<p>The server is running and the API is available at <code>/api</code>. The interface is missing because it has not been built yet.</p>
<p>Please run <code>npm run build</code> in the project folder and then restart the server (<code>npm start</code>).</p>
</body>
</html>
`;

// A path that names a file (has an extension) must never fall back to index.html; a missing script or image
// has to stay a 404 instead of arriving as HTML.
function isPageRequest(request: FastifyRequest): boolean {
  if (!SPA_METHODS.has(request.method) || targetsApi(request.url)) return false;
  const pathname = request.url.split('?')[0] ?? '';
  return !(pathname.split('/').pop() ?? '').includes('.');
}

export function isFrontendBuilt(dir: string): boolean {
  return existsSync(path.join(dir, 'index.html'));
}

// CSP for HTML responses. connect-src names the request's own host explicitly because not every browser
// counts ws:// and wss:// as 'self'; the Host header was validated by the host guard before this runs.
export function contentSecurityPolicy(host: string | undefined): string {
  const socketHosts = host === undefined ? '' : ` ws://${host} wss://${host}`;
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' https://cdn.modrinth.com",
    "font-src 'self'",
    `connect-src 'self'${socketHosts}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function applySecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    void reply.header('X-Content-Type-Options', 'nosniff');
    const type = reply.getHeader('content-type');
    if (typeof type === 'string' && type.toLowerCase().startsWith('text/html')) {
      void reply.header('X-Frame-Options', 'DENY');
      void reply.header('Content-Security-Policy', contentSecurityPolicy(request.headers.host));
      void reply.header('Referrer-Policy', 'no-referrer');
    }
    return payload;
  });
}

export interface FrontendRegistration {
  notFound: (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply>;
}

// Serves the built frontend. The catch-all route is public (see PUBLIC_ROUTES) but the auth hook still
// treats anything that decodes to /api/... as protected, so only real files and page routes are open.
export function registerFrontend(app: FastifyInstance, dir: string): FrontendRegistration {
  applySecurityHeaders(app);
  if (!isFrontendBuilt(dir)) {
    app.log.warn(`The web interface was not found (${dir}). Please run "npm run build".`);
    const hint = (_request: FastifyRequest, reply: FastifyReply): FastifyReply =>
      reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(HINT_PAGE);
    app.get('/', hint);
    return {
      notFound: async (request, reply) => {
        if (isPageRequest(request)) return hint(request, reply);
        notFoundHandler(request, reply);
        return reply;
      },
    };
  }
  void app.register(fastifyStatic, {
    root: dir,
    index: 'index.html',
    dotfiles: 'ignore',
    redirect: false,
    cacheControl: false,
    setHeaders: (reply, filePath) => {
      const immutable = filePath.split(path.sep).join('/').includes('/assets/');
      void reply.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
  return {
    notFound: async (request, reply) => {
      if (isPageRequest(request)) return reply.sendFile('index.html');
      notFoundHandler(request, reply);
      return reply;
    },
  };
}
