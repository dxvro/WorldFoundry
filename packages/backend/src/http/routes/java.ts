import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import type { JavaInstallResponse, ManagedJavaDto } from '../../contract.js';
import { servers } from '../../db/schema.js';
import { describeOrigin, describeOriginMsg } from '../../java/managed.js';
import { AppError } from '../errors.js';

const majorParams = z.object({ major: z.coerce.number().int().min(8).max(99) });
const runtimesQuery = z.object({ rescan: z.enum(['true', 'false']).default('false') });

export function registerJavaRoutes(app: FastifyInstance, { services, db }: AppContext): void {
  const { java, manager } = services;

  // the servers that currently depend on a runtime below `dir` (or wait for it to be installed)
  async function usersOf(dir: string, major: number): Promise<Array<{ id: string; name: string }>> {
    const root = dir + path.sep;
    const rows = await db.select({ id: servers.id, name: servers.name }).from(servers);
    const names = new Map(rows.map((row) => [row.id, row.name]));
    return manager
      .javaUsage()
      .filter((usage) => usage.preparingMajor === major || (usage.javaPath !== null && usage.javaPath.startsWith(root)))
      .map((usage) => ({ id: usage.serverId, name: names.get(usage.serverId) ?? usage.serverId }));
  }

  app.get('/api/java/runtimes', async (request) => {
    const { rescan } = runtimesQuery.parse(request.query);
    const managed: ManagedJavaDto[] = [];
    for (const info of await java.listManaged()) {
      managed.push({
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
        inUseBy: (await usersOf(info.dir, info.major)).map((user) => user.id),
      });
    }
    return { runtimes: await java.detect(rescan === 'true'), managed, installs: java.activeInstalls(), autoInstall: java.autoInstallEnabled };
  });

  app.post('/api/java/runtimes/:major/install', async (request): Promise<JavaInstallResponse> => {
    const { major } = majorParams.parse(request.params);
    if (!java.canInstall) {
      throw new AppError(409, 'JAVA_INSTALL_UNAVAILABLE', 'Java installation is not available in this configuration.');
    }
    const alreadyInstalled = (await java.listManaged()).some((info) => info.major === major);
    return { runtime: await java.ensureManaged(major), alreadyInstalled };
  });

  app.delete('/api/java/runtimes/:major', async (request) => {
    const { major } = majorParams.parse(request.params);
    const info = (await java.listManaged()).find((entry) => entry.major === major);
    if (info === undefined) {
      throw new AppError(404, 'JAVA_RUNTIME_NOT_FOUND', `There is no Java runtime ${major} installed by WorldFoundry.`, undefined, { major });
    }
    const users = await usersOf(info.dir, major);
    if (users.length > 0) {
      throw new AppError(409, 'JAVA_IN_USE', `Java ${major} is currently used by servers: ${users.map((user) => user.name).join(', ')}. Please stop the servers first.`, { servers: users }, { major, servers: users.map((user) => user.name).join(', ') });
    }
    await java.removeManaged(major);
    return { removed: true };
  });
}
