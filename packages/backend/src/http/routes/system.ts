import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import { count, sum } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import type { DiskInfo, ManagedJavaDto, SystemInfo, UsageResponse } from '../../contract.js';
import { backups } from '../../db/schema.js';
import { LOADERS } from '../../db/enums.js';
import { describeOrigin, describeOriginMsg } from '../../java/managed.js';
import { diskUsage } from '../../lib/disk.js';

const systemQuery = z.object({ rescan: z.enum(['true', 'false']).default('false') });
const loaderParams = z.object({ loader: z.enum(LOADERS) });
const mcVersionsQuery = z.object({ snapshots: z.enum(['true', 'false']).default('false') });
const versionsQuery = z.object({ mcVersion: z.string().trim().min(1).max(64) });

export function registerSystemRoutes(app: FastifyInstance, { services, db, config }: AppContext): void {
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

  app.get('/api/system/usage', async (): Promise<UsageResponse> => services.usage.snapshot());

  app.get('/api/system/disk', async (): Promise<DiskInfo> => {
    const usage = await diskUsage(config.dataDir);
    const rows = await db
      .select({ serverId: backups.serverId, bytes: sum(backups.sizeBytes), count: count() })
      .from(backups)
      .groupBy(backups.serverId);
    return {
      totalBytes: usage?.totalBytes ?? null,
      freeBytes: usage?.freeBytes ?? null,
      backups: rows.map((row) => ({ serverId: row.serverId, bytes: Number(row.bytes ?? 0), count: row.count })).sort((a, b) => b.bytes - a.bytes),
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
