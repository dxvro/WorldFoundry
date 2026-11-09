import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { probePort } from '../src/process/ports.js';

const hold = (host: string): Promise<net.Server> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ port: 0, host }, () => resolve(server));
  });

const portOf = (server: net.Server): number => (server.address() as net.AddressInfo).port;

describe('probePort', () => {
  it('reports a free port as free', async () => {
    const server = await hold('127.0.0.1');
    const port = portOf(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(probePort(port)).resolves.toBe('free');
  });

  it('detects a foreign listener that is bound to loopback only', async () => {
    const server = await hold('127.0.0.1');
    try {
      await expect(probePort(portOf(server))).resolves.toBe('in-use');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
