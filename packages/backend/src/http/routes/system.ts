import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import type { ManagedJavaDto, SystemInfo } from '../../contract.js';
import { LOADERS } from '../../db/enums.js';
import { describeOrigin, describeOriginMsg } from '../../java/managed.js';

const systemQuery = z.object({ rescan: z.enum(['true', 'false']).default('false') });
const loaderParams = z.object({ loader: z.enum(LOADERS) });
const mcVersionsQuery = z.object({ snapshots: z.enum(['true', 'false']).default('false') });
const versionsQuery = z.object({ mcVersion: z.string().trim().min(1).max(64) });

export function registerSystemRoutes(app: FastifyInstance, { services }: AppContext): void {
  const { java, catalog, manager } = services;

  async function managedJava(): Promise<ManagedJavaDto[]> {
    const usage = manager.javaUsage();
    return (await java.listManaged()).map((info) => ({
      major: info.major,
      version: info.version,
      release: info.release,
      image: info.image,
      sha256: info.sha256,
      installedAt: info.installedAt,
      sizeBytes: info.sizeBytes,
      javaPath: info.javaPath,
      origin: describeOrigin(info),
      originRef: describeOriginMsg(info).ref,
      inUseBy: usage
        .filter((entry) => entry.preparingMajor === info.major || entry.javaPath?.startsWith(info.dir + path.sep) === true)
        .map((entry) => entry.serverId),
    }));
  }

  app.get('/api/system', async (request): Promise<SystemInfo> => {
    const { rescan } = systemQuery.parse(request.query);
    return {
      totalMemoryMb: Math.floor(os.totalmem() / (1024 * 1024)),
      freeMemoryMb: Math.floor(os.freemem() / (1024 * 1024)),
      cpuCount: os.cpus().length,
      platform: process.platform,
      arch: process.arch,
      javaRuntimes: await java.detect(rescan === 'true'),
      javaAutoInstall: java.autoInstallEnabled,
      managedJava: await managedJava(),
      javaInstalls: java.activeInstalls(),
    };
  });

  app.get('/api/loaders', async () => ({ loaders: catalog.loaders() }));

  app.get('/api/loaders/:loader/mc-versions', async (request) => {
    const { loader } = loaderParams.parse(request.params);
    const { snapshots } = mcVersionsQuery.parse(request.query);
    return { mcVersions: await catalog.mcVersions(loader, snapshots === 'true') };
  });

  app.get('/api/loaders/:loader/versions', async (request) => {
    const { loader } = loaderParams.parse(request.params);
    const { mcVersion } = versionsQuery.parse(request.query);
    return { versions: await catalog.versions(loader, mcVersion) };
  });
}
