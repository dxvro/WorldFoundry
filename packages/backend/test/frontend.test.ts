import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../src/http/frontend.js';
import { allowedImageUrl } from '../src/lib/images.js';
import { ServerEnv, scratchDir } from './server-env.js';

const TOKEN = 'a-secret-token';
const INDEX = '<!doctype html><html><head><title>WorldFoundry</title></head><body><div id="root"></div></body></html>';
const SECRET = 'SECRET-OUTSIDE-OF-DIST';

interface RawResponse {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

// light-my-request normalises paths, so probes with encoded segments go over a real socket
function rawRequest(port: number, requestPath: string, headers: Record<string, string> = {}, method = 'GET'): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method, agent: false, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function makeDist(): Promise<string> {
  const root = await scratchDir('frontend-');
  const dist = path.join(root, 'dist');
  await mkdir(path.join(dist, 'assets'), { recursive: true });
  await writeFile(path.join(dist, 'index.html'), INDEX);
  await writeFile(path.join(dist, 'assets', 'app-abc123.js'), 'console.log(1);');
  await writeFile(path.join(root, 'secret.txt'), SECRET);
  await writeFile(path.join(dist, '.env'), SECRET);
  return dist;
}

async function listening(options: Parameters<typeof ServerEnv.create>[0]): Promise<{ env: ServerEnv; port: number }> {
  const env = await ServerEnv.create(options);
  await env.app.listen({ host: '127.0.0.1', port: 0 });
  return { env, port: (env.app.server.address() as { port: number }).port };
}

describe('static frontend without login', () => {
  let env: ServerEnv;
  let port: number;
  beforeEach(async () => {
    ({ env, port } = await listening({ frontendDir: await makeDist() }));
  });
  afterEach(async () => {
    await env.close();
  });

  it('serves index.html with security headers on HTML only', async () => {
    const res = await rawRequest(port, '/');
    expect(res.status).toBe(200);
    expect(res.body).toBe(INDEX);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-cache');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("img-src 'self' https://cdn.modrinth.com https://storage.ficsit.app");
    expect(csp).toContain(`ws://127.0.0.1:${port}`);
    expect(csp).not.toContain('unsafe-inline');
  });

  it('serves hashed assets as immutable and without a CSP', async () => {
    const res = await rawRequest(port, '/assets/app-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['content-type']).toMatch(/javascript/);
  });

  it('falls back to index.html for page routes and keeps 404s for files', async () => {
    for (const route of ['/servers/abc', '/servers/abc/mods', '/new', '/servers/abc?tab=x']) {
      const res = await rawRequest(port, route);
      expect([route, res.status, res.body]).toEqual([route, 200, INDEX]);
    }
    const missing = await rawRequest(port, '/assets/missing.js');
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body)).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect((await rawRequest(port, '/favicon.ico')).status).toBe(404);
  });

  it('keeps the JSON behaviour of the API, including unknown API paths', async () => {
    const health = await rawRequest(port, '/api/health');
    expect(JSON.parse(health.body)).toMatchObject({ status: 'ok' });
    expect(health.headers['content-security-policy']).toBeUndefined();
    for (const route of ['/api/nope', '/api', '/api/servers/x/nope', '/%61pi/nope', '/API/nope']) {
      const res = await rawRequest(port, route);
      expect([route, res.status]).toEqual([route, 404]);
      expect(res.headers['content-type']).toContain('application/json');
      expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
  });

  it('does not serve dotfiles or anything outside the dist folder', async () => {
    const routes = [
      '/.env',
      '/%2e%2e/secret.txt',
      '/..%2fsecret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/..\\secret.txt',
      '/%2e%2e%5csecret.txt',
      '/assets/../../secret.txt',
      '/%2e%2e/%2e%2e/secret.txt',
      '/%2e%2e/%2e%2e/%2e%2e/%2e%2e/secret.txt',
    ];
    for (const route of routes) {
      const res = await rawRequest(port, route);
      expect([route, res.body.includes(SECRET)]).toEqual([route, false]);
      expect([route, res.status === 200 && res.body !== INDEX]).toEqual([route, false]);
      // refused with a client error, never a 500
      expect([route, res.status >= 500]).toEqual([route, false]);
    }
  });

  it('still applies the Host and Origin guards', async () => {
    const badHost = await rawRequest(port, '/', { Host: 'evil.example.com' });
    expect(badHost.status).toBe(403);
    expect(JSON.parse(badHost.body)).toMatchObject({ error: { code: 'HOST_FORBIDDEN' } });
    expect((await rawRequest(port, '/assets/app-abc123.js', { Host: 'evil.example.com' })).status).toBe(403);
    const crossSite = await rawRequest(port, '/api/servers/x/stop', { Origin: 'http://evil.example.com' }, 'POST');
    expect(crossSite.status).toBe(403);
    expect(JSON.parse(crossSite.body)).toMatchObject({ error: { code: 'ORIGIN_FORBIDDEN' } });
  });
});

describe('static frontend with login', () => {
  let env: ServerEnv;
  let port: number;
  beforeEach(async () => {
    ({ env, port } = await listening({ frontendDir: await makeDist(), authToken: TOKEN }));
  });
  afterEach(async () => {
    await env.close();
  });

  it('serves the shell and assets without login', async () => {
    for (const route of ['/', '/assets/app-abc123.js', '/servers/abc', '/new']) {
      expect([route, (await rawRequest(port, route)).status]).toEqual([route, 200]);
    }
  });

  it('keeps every API path protected, whatever its spelling', async () => {
    const server = await env.addServer();
    const routes = [
      '/api/servers',
      '/%61pi/servers',
      '/api/%73ervers',
      '/%61pi/%73ervers',
      '/API/servers',
      `/api/servers/${server.id}`,
      '/api/system',
      '/api/events',
      '/%61pi/events',
      '/api/nope',
      '/api',
      '/%61pi',
      '//api/servers',
      '/./api/servers',
      '/x/../api/servers',
      '/api/servers/../system',
      '/assets/../api/servers',
      '/api/servers?x=/index.html',
    ];
    for (const route of routes) {
      const res = await rawRequest(port, route);
      expect([route, res.status === 401 || res.status === 404 ? 'blocked' : res.status]).toEqual([route, 'blocked']);
      expect([route, res.body.includes('"servers"')]).toEqual([route, false]);
      expect([route, res.body.includes(server.id)]).toEqual([route, false]);
    }
    // a double-encoded spelling is just an unknown page name (the shell), never the API
    const doubled = await rawRequest(port, '/%2561pi/servers');
    expect([doubled.status, doubled.body]).toEqual([200, INDEX]);
    for (const route of ['/api/servers', '/%61pi/servers', '/api/nope', '/api']) {
      expect([route, (await rawRequest(port, route)).status]).toEqual([route, 401]);
    }
  });

  it('serves the API again with a valid token', async () => {
    const res = await rawRequest(port, '/api/servers', { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    const unknown = await rawRequest(port, '/api/nope', { Authorization: `Bearer ${TOKEN}` });
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body)).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('frontend not built', () => {
  let env: ServerEnv;
  let port: number;
  beforeEach(async () => {
    const root = await scratchDir('frontend-missing-');
    ({ env, port } = await listening({ frontendDir: path.join(root, 'dist') }));
  });
  afterEach(async () => {
    await env.close();
  });

  it('keeps the API running and explains the missing build at /', async () => {
    const page = await rawRequest(port, '/');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.body).toContain('npm run build');
    expect((await rawRequest(port, '/servers/x')).body).toContain('npm run build');
    expect((await rawRequest(port, '/api/health')).status).toBe(200);
    expect((await rawRequest(port, '/api/nope')).status).toBe(404);
    expect((await rawRequest(port, '/missing.js')).status).toBe(404);
  });
});

describe('contentSecurityPolicy', () => {
  it('limits sources to the page itself and the mod sites for images', () => {
    const csp = contentSecurityPolicy('192.168.1.20:3000');
    expect(csp).toContain("connect-src 'self' ws://192.168.1.20:3000 wss://192.168.1.20:3000");
    expect(csp).toContain("script-src 'self'");
    expect(contentSecurityPolicy(undefined)).toContain("connect-src 'self'");
  });

  it('allows the pictures of every mod source and nothing else', () => {
    const csp = contentSecurityPolicy(undefined);
    expect(csp).toContain("img-src 'self' https://cdn.modrinth.com https://storage.ficsit.app https://images.steamusercontent.com https://steamuserimages-a.akamaihd.net");
    expect(allowedImageUrl('https://storage.ficsit.app/file/smr-prod-s3/images/mods/jYntLCZw3stSG/logo.webp')).toBe('https://storage.ficsit.app/file/smr-prod-s3/images/mods/jYntLCZw3stSG/logo.webp');
    expect(allowedImageUrl('https://images.steamusercontent.com/ugc/1/ABC/')).toBe('https://images.steamusercontent.com/ugc/1/ABC/');
    // ficsit.app answers "" for a mod without a logo: no broken picture
    expect(allowedImageUrl('')).toBeNull();
    expect(allowedImageUrl(null)).toBeNull();
    expect(allowedImageUrl('http://storage.ficsit.app/logo.webp')).toBeNull();
    expect(allowedImageUrl('https://evil.example/logo.webp')).toBeNull();
    expect(allowedImageUrl('javascript:alert(1)')).toBeNull();
  });
});
