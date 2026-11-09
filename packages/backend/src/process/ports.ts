import net from 'node:net';

export type PortState = 'free' | 'in-use' | 'denied';

export type PortProbe = (port: number) => Promise<PortState>;

// The JVM binds exclusively, but a Node bind on 0.0.0.0 still succeeds next to a listener on one specific address
// (Windows, and Linux through SO_REUSEADDR). Loopback is probed as well, because that is where local tools listen.
const PROBE_HOSTS = ['0.0.0.0', '127.0.0.1'] as const;

const probeHost = (port: number, host: string): Promise<PortState> =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code === 'EACCES' ? 'denied' : 'in-use');
    });
    probe.listen({ port, host, exclusive: true }, () => {
      probe.close(() => resolve('free'));
    });
  });

// A real bind: the only reliable way to know whether the server could listen there
export const probePort: PortProbe = async (port) => {
  for (const host of PROBE_HOSTS) {
    const state = await probeHost(port, host);
    if (state !== 'free') return state;
  }
  return 'free';
};
