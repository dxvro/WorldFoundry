import { vi } from 'vitest';

export const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export interface Call {
  method: string;
  url: string;
  body: unknown;
}

export type Handler = (call: Call) => Response | { status?: number; body: unknown };

export interface MockApi {
  calls: Call[];
  set: (route: string, handler: Handler) => void;
  callsTo: (route: string) => Call[];
}

export const offline = { state: 'offline', pid: null, startedAt: null, exitCode: null, message: null, messageRef: null, players: [], port: null, cpuPercent: null, rssBytes: null };

export const serverFixture = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'srv-1',
  name: 'Survival',
  game: 'minecraft',
  gameSettings: '{}',
  loader: 'fabric',
  mcVersion: '1.21.1',
  loaderVersion: '0.16.0',
  installState: 'installed',
  installError: null,
  launchSpec: null,
  requiredJavaMajor: 21,
  port: 25565,
  javaPath: null,
  minRamMb: 1024,
  maxRamMb: 2048,
  useAikarFlags: false,
  extraJvmArgs: '',
  eulaAccepted: true,
  autoStart: false,
  backupIntervalHours: null,
  backupKeepLast: 7,
  backupIncludeConfig: false,
  backupScheduleSince: null,
  lastStartedAt: null,
  lastExitCode: null,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  status: offline,
  ...overrides,
});

export const systemFixture = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  totalMemoryMb: 16384,
  freeMemoryMb: 8000,
  cpuCount: 8,
  platform: 'win32',
  arch: 'x64',
  javaRuntimes: [],
  javaAutoInstall: true,
  managedJava: [],
  javaInstalls: [],
  ...overrides,
});

export const networkFixture = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  hostname: 'MCPC',
  hostnameUrl: 'http://MCPC:3000',
  lan: [{ address: '192.168.178.20', interfaceName: 'Ethernet', url: 'http://192.168.178.20:3000', private: true }],
  virtual: [{ address: '172.28.16.1', interfaceName: 'vEthernet (WSL)', url: 'http://172.28.16.1:3000', private: true }],
  active: { host: '0.0.0.0', port: 3000, allowedHosts: [], urls: ['http://192.168.178.20:3000'] },
  settings: { bindHost: null, port: null, allowedHosts: [], publicAddress: null },
  defaults: { host: '0.0.0.0', port: 3000, allowedHosts: [] },
  pending: { host: '0.0.0.0', port: 3000, allowedHosts: [], urls: ['http://192.168.178.20:3000'] },
  publicUrl: null,
  restartRequired: false,
  warnings: [],
  restart: { automatic: true, note: 'The service starts WorldFoundry again by itself after it exits.' },
  ...overrides,
});

const game = (id: string, name: string, availability: string, disclaimer: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name,
  availability,
  rightsHolders: ['Owner of ' + name],
  disclaimer,
  eula: { name: 'License of ' + name, url: 'https://example.invalid/eula' },
  delivery: { kind: 'steamcmd', appId: 1, anonymous: true },
  platforms: ['win32', 'linux'],
  ports: [{ purpose: 'Game', port: 7777, protocol: 'udp' }],
  modSources: [{ id: 'workshop', name: 'Steam Workshop', url: 'https://example.invalid/workshop', requiresKey: false }],
  ...extra,
});

// what GET /api/games answers: two available games and one planned
export const gamesFixture = (): Record<string, unknown> => ({
  games: [
    game('minecraft', 'Minecraft: Java Edition', 'available', 'Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.', {
      delivery: { kind: 'vendor-download' },
      ports: [{ purpose: 'Game', port: 25565, protocol: 'tcp' }],
      modSources: [
        { id: 'modrinth', name: 'Modrinth', url: 'https://modrinth.com', requiresKey: false },
        { id: 'curseforge', name: 'CurseForge', url: 'https://www.curseforge.com/minecraft', requiresKey: true, inProgress: true, note: 'In progress.' },
      ],
    }),
    game('zomboid', 'Project Zomboid', 'available', 'Not an official Project Zomboid product. Not approved by or associated with The Indie Stone.'),
    game('ark', 'ARK: Survival Evolved', 'planned', 'Not an official ARK product. Not approved by or associated with Studio Wildcard or Snail Games.'),
  ],
});

// Routes are "METHOD /path-prefix"; the longest matching prefix wins. Unknown requests answer 404.
export function mockApi(routes: Record<string, Handler>): MockApi {
  const table = new Map(Object.entries(routes));
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      const path = url.split('?')[0] ?? url;
      const call: Call = { method, url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) };
      calls.push(call);
      const key = [...table.keys()]
        .filter((candidate) => {
          const [m, prefix] = candidate.split(' ');
          return m === method && prefix !== undefined && path.startsWith(prefix);
        })
        .sort((a, b) => b.length - a.length)[0];
      if (key === undefined) return json(404, { error: { code: 'NOT_FOUND', message: `not found: ${method} ${url}` } });
      const result = (table.get(key) as Handler)(call);
      return result instanceof Response ? result : json(result.status ?? 200, result.body);
    }),
  );
  return {
    calls,
    set: (route, handler) => void table.set(route, handler),
    callsTo: (route) => {
      const [m, prefix] = route.split(' ');
      return calls.filter((call) => call.method === m && (call.url.split('?')[0] ?? '').startsWith(prefix ?? ''));
    },
  };
}

export const baseRoutes = (server: Record<string, unknown>, system: Record<string, unknown> = systemFixture()): Record<string, Handler> => ({
  'GET /api/auth/status': () => ({ body: { authRequired: false, authenticated: true } }),
  'GET /api/health': () => ({ body: { status: 'ok', database: 'ok', lanUrls: [] } }),
  'GET /api/games': () => ({ body: gamesFixture() }),
  'GET /api/servers': () => ({ body: { servers: [server] } }),
  'GET /api/system': () => ({ body: system }),
  // no update information unless a test asks for it (otherwise the longer /api/system route would answer)
  'GET /api/system/network': () => ({ body: networkFixture() }),
  'GET /api/system/update': () => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'not found' } } }),
});
