import path from 'node:path';
import { AutostartService } from './autostart/service.js';
import { BackupScheduler } from './backups/scheduler.js';
import { BackupService } from './backups/service.js';
import type { SaveTimings } from './backups/save.js';
import { DEFAULT_IMPORT_MAX_MB, type AppConfig } from './config/env.js';
import type { Db } from './db/client.js';
import { PasswordStore } from './auth/store.js';
import { EventBus } from './events/bus.js';
import { Auth } from './http/auth.js';
import type { ScryptCost } from './auth/password.js';
import { LoaderCatalog } from './installer/catalog.js';
import { createInstallerRunner, type InstallerRunner } from './installer/runner.js';
import { InstallService } from './installer/service.js';
import { GameAdapters } from './games/adapters.js';
import { ConfigFilesService } from './games/config-files.js';
import { SteamWorkshopClient, ZomboidWorkshopService, type WorkshopApi } from './games/zomboid/workshop.js';
import { CurseForgeClient, type CurseForgeApi } from './curseforge/client.js';
import { CurseForgeService } from './curseforge/service.js';
import { MinecraftAdapter } from './games/minecraft/adapter.js';
import { ZomboidAdapter } from './games/zomboid/adapter.js';
import { SteamCmd } from './steam/steamcmd.js';
import { JavaDetector, type JavaProbe } from './java/detect.js';
import { ManagedRuntimes } from './java/managed.js';
import { JavaService } from './java/service.js';
import type { FreeSpaceReader } from './lib/disk.js';
import type { Interfaces } from './lib/network.js';
import { KeyedLock } from './lib/keyed-lock.js';
import { silentLogger, type Logger } from './lib/logger.js';
import { readVersion } from './lib/version.js';
import { msg } from './messages.js';
import type { DownloaderOptions } from './mods/downloader.js';
import { ModService } from './mods/service.js';
import type { ServerRuntimeGuard } from './mods/runtime-guard.js';
import type { ModrinthApi } from './modrinth/types.js';
import { NetworkService } from './network/service.js';
import type { NetworkDefaults } from './network/settings.js';
import { RestartService } from './system/restart.js';
import { ProcessManager } from './process/manager.js';
import type { SampleReader } from './process/metrics.js';
import { probePort as realProbePort, type PortProbe } from './process/ports.js';
import { realSpawner, type ProcessSpawner } from './process/spawner.js';
import { PlayersService, type PlayersOverrides } from './players/service.js';
import { PropertiesService } from './properties/service.js';
import { ServerService } from './servers/service.js';
import { UpdateService, type UpdateServiceOptions } from './update/service.js';
import { backups as backupsTable, servers as serversTable } from './db/schema.js';
import { eq } from 'drizzle-orm';
import { ExportService } from './worldio/export-service.js';
import { ImportService } from './worldio/import-service.js';

export interface ServiceOptions {
  db: Db;
  config: AppConfig;
  modrinth: ModrinthApi;
  // tests pass a fake; the real client talks to api.curseforge.com with the user's own key
  curseforgeApi?: CurseForgeApi;
  // tests pass a SteamCMD that runs a fake program, and a UDP check that needs no free port
  steamCmd?: SteamCmd;
  udpProbe?: (port: number) => Promise<boolean>;
  workshopApi?: WorkshopApi;
  logger?: Logger;
  // Phase 2 compatibility: replaces the process manager as the guard seen by the mod service
  runtimeGuard?: ServerRuntimeGuard;
  downloader?: DownloaderOptions;
  catalog?: LoaderCatalog;
  fetch?: typeof fetch;
  // replaces the default Java service (which detects installed runtimes and installs Eclipse Temurin on demand)
  java?: JavaService;
  javaProbe?: JavaProbe;
  // tests: replaces the standard JDK install directories the default detector scans (production keeps the per-platform defaults)
  javaStandardRoots?: string[];
  freeSpace?: FreeSpaceReader;
  saveTimings?: SaveTimings;
  spawner?: ProcessSpawner;
  installerRunner?: InstallerRunner;
  portProbe?: PortProbe;
  readSamples?: SampleReader;
  platform?: NodeJS.Platform;
  // tests: replaces the Mojang lookup (fetch), the wait for a live change and the clock of the player lists
  players?: PlayersOverrides;
  // tests: replaces parts of the self-update service (keys, API address, timings, install mode)
  update?: Partial<Omit<UpdateServiceOptions, 'db' | 'config' | 'bus' | 'manager' | 'logger'>>;
  // network settings: the config-file values (defaults) and replacements for tests
  network?: { defaults?: NetworkDefaults; interfaces?: () => Interfaces; hostname?: () => string };
  // ends the process for a deliberate restart (absent for embedders and tests: no restart from the UI)
  restart?: { exit?: (code: number) => void; delayMs?: number };
  authOptions?: { cost?: ScryptCost; refreshMs?: number };
  totalMemoryMb?: () => number;
  timings?: {
    startWarningMs?: number;
    closeGraceMs?: number;
    metricsIntervalMs?: number;
    installerTimeoutMs?: number;
    loginFailureDelayMs?: number;
    // 0 switches the periodic backup check off (tests call it directly)
    backupCheckMs?: number;
  };
}

export interface Services {
  lock: KeyedLock;
  bus: EventBus;
  catalog: LoaderCatalog;
  games: GameAdapters;
  curseforge: CurseForgeService;
  configFiles: ConfigFilesService;
  workshop: ZomboidWorkshopService;
  java: JavaService;
  manager: ProcessManager;
  install: InstallService;
  servers: ServerService;
  properties: PropertiesService;
  players: PlayersService;
  mods: ModService;
  backups: BackupService;
  backupScheduler: BackupScheduler;
  autostart: AutostartService;
  update: UpdateService;
  network: NetworkService;
  restart: RestartService;
  auth: Auth;
  // world export and import
  exports: ExportService;
  imports: ImportService;
}

export function createServices(options: ServiceOptions): Services {
  const { db, config } = options;
  const logger = options.logger ?? silentLogger;
  const timings = options.timings ?? {};
  const lock = new KeyedLock();
  const bus = new EventBus();
  const userAgent = config.modrinthUserAgent ?? `WorldFoundry/${readVersion()}`;
  const catalog = options.catalog ?? new LoaderCatalog({ fetch: options.fetch ?? fetch, userAgent });
  const managed = new ManagedRuntimes({
    dir: path.join(config.dataDir, 'runtimes'),
    fetch: options.fetch ?? fetch,
    userAgent,
    lock,
    logger,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.javaProbe === undefined ? {} : { probe: options.javaProbe }),
    ...(options.freeSpace === undefined ? {} : { freeSpace: options.freeSpace }),
  });
  const javaDetector = new JavaDetector({
    managed: { list: () => managed.sources() },
    ...(options.javaProbe === undefined ? {} : { probe: options.javaProbe }),
    ...(options.javaStandardRoots === undefined ? {} : { standardRoots: options.javaStandardRoots }),
  });
  const java = options.java ?? new JavaService(javaDetector, managed, config.javaAutoInstall);
  java.onInstallEvent((event) => bus.emit(event));
  const spawner = options.spawner ?? realSpawner;
  const runner = options.installerRunner ?? createInstallerRunner(spawner);

  const minecraft = new MinecraftAdapter({
    catalog,
    java,
    runner,
    logger,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(timings.installerTimeoutMs === undefined ? {} : { installerTimeoutMs: timings.installerTimeoutMs }),
    savePort: async (serverId, port) => {
      await db.transaction((tx) => tx.update(serversTable).set({ port, updatedAt: new Date() }).where(eq(serversTable.id, serverId)));
    },
  });
  const steam =
    options.steamCmd ??
    new SteamCmd({
      dir: path.join(config.dataDir, 'steamcmd'),
      runner,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(config.steamcmdPath === undefined ? {} : { configuredPath: config.steamcmdPath }),
    });
  const zomboid = new ZomboidAdapter({
    steam,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.udpProbe === undefined ? {} : { probeUdp: options.udpProbe }),
  });
  const games = new GameAdapters([minecraft, zomboid]);

  // the hook is wired after the mod service exists; the manager only calls it once a server has started
  const hooks: { modService?: ModService } = {};
  const manager = new ProcessManager({
    db,
    serversDir: config.serversDir,
    lock,
    spawner,
    games,
    bus,
    logger,
    stopTimeoutMs: config.stopTimeoutMs,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.portProbe === undefined ? {} : { probePort: options.portProbe }),
    ...(options.readSamples === undefined ? {} : { readSamples: options.readSamples }),
    ...(timings.startWarningMs === undefined ? {} : { startWarningMs: timings.startWarningMs }),
    ...(timings.closeGraceMs === undefined ? {} : { closeGraceMs: timings.closeGraceMs }),
    ...(timings.metricsIntervalMs === undefined ? {} : { metricsIntervalMs: timings.metricsIntervalMs }),
    onStarted: (server) => {
      if (server.loader === 'vanilla' || hooks.modService === undefined) return;
      hooks.modService
        .checkUpdates(server.id)
        .then(({ updates }) =>
          bus.emit({
            type: 'mods.updates',
            serverId: server.id,
            ok: true,
            count: updates.length,
            projects: updates.map((update) => update.name),
            error: null,
            errorRef: null,
          }),
        )
        .catch((error: unknown) => {
          logger.error({ err: error, serverId: server.id }, 'Update check after the server start failed');
          bus.emit({
            type: 'mods.updates',
            serverId: server.id,
            ok: false,
            count: 0,
            projects: [],
            error: msg('MODS_UPDATE_CHECK_FAILED').text,
            errorRef: msg('MODS_UPDATE_CHECK_FAILED').ref,
          });
        });
    },
  });

  const guard = options.runtimeGuard ?? manager;
  const mods = new ModService({
    db,
    modrinth: options.modrinth,
    guard,
    serversDir: config.serversDir,
    lock,
    logger,
    backupKeep: config.modBackupKeep,
    ...(options.downloader === undefined ? {} : { downloader: options.downloader }),
  });
  hooks.modService = mods;
  const curseforge = new CurseForgeService(db, options.curseforgeApi ?? new CurseForgeClient({ userAgent, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) }));

  const install = new InstallService({
    db,
    serversDir: config.serversDir,
    lock,
    bus,
    games,
    guard: manager,
    logger,
  });
  const backups = new BackupService({
    db,
    serversDir: config.serversDir,
    backupsDir: path.join(config.dataDir, 'backups'),
    lock,
    bus,
    manager,
    logger,
    layoutOf: (server, dir) => games.forServer(server).backupLayout(server, dir),
    ...(options.freeSpace === undefined ? {} : { freeSpace: options.freeSpace }),
    ...(options.saveTimings === undefined ? {} : { saveTimings: options.saveTimings }),
  });
  const backupScheduler = new BackupScheduler(backups, timings.backupCheckMs, logger);
  const autostart = new AutostartService({ db, manager, logger });
  const servers = new ServerService({
    db,
    serversDir: config.serversDir,
    lock,
    bus,
    catalog,
    java,
    install,
    manager,
    backups,
    games,
    ...(options.totalMemoryMb === undefined ? {} : { totalMemoryMb: options.totalMemoryMb }),
  });
  const properties = new PropertiesService({ db, serversDir: config.serversDir, lock, guard: manager });
  const players = new PlayersService({
    db,
    serversDir: config.serversDir,
    lock,
    runtime: manager,
    userAgent,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...options.players,
  });
  const auth = new Auth({
    token: config.authToken,
    store: new PasswordStore(db),
    ...options.authOptions,
    ...(timings.loginFailureDelayMs === undefined ? {} : { failureDelayMs: timings.loginFailureDelayMs }),
  });
  const tmpDir = path.join(config.dataDir, 'tmp');
  const exportsService = new ExportService({
    db,
    serversDir: config.serversDir,
    tmpDir: path.join(tmpDir, 'exports'),
    lock,
    manager,
    backups,
    version: readVersion(),
    logger,
    ...(options.freeSpace === undefined ? {} : { freeSpace: options.freeSpace }),
    ...(options.saveTimings === undefined ? {} : { saveTimings: options.saveTimings }),
  });
  const imports = new ImportService({
    db,
    serversDir: config.serversDir,
    tmpDir: path.join(tmpDir, 'imports'),
    lock,
    catalog,
    modrinth: options.modrinth,
    servers,
    mods,
    backups,
    manager,
    logger,
    maxUploadBytes: (config.importMaxMb ?? DEFAULT_IMPORT_MAX_MB) * 1024 * 1024,
    ...(options.freeSpace === undefined ? {} : { freeSpace: options.freeSpace }),
  });
  const update = new UpdateService({
    db,
    config,
    bus,
    manager,
    logger,
    currentVersion: readVersion(),
    preflight: async () => {
      const installing = await db.select({ id: serversTable.id }).from(serversTable).where(eq(serversTable.installState, 'installing')).limit(1);
      if (installing.length > 0) return msg('UPDATE_WAIT_INSTALL');
      const running = await db.select({ id: backupsTable.id }).from(backupsTable).where(eq(backupsTable.status, 'running')).limit(1);
      if (running.length > 0) return msg('UPDATE_WAIT_BACKUP');
      if (java.activeInstalls().length > 0) return msg('UPDATE_WAIT_JAVA');
      if (exportsService.busy) return msg('UPDATE_WAIT_EXPORT');
      if (imports.busy) return msg('UPDATE_WAIT_IMPORT');
      return null;
    },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...options.update,
  });
  manager.setStartGuard(() => update.startGuard());
  const network = new NetworkService({
    db,
    active: { host: config.host, port: config.port, allowedHosts: config.allowedHosts },
    defaults: options.network?.defaults ?? { host: config.host, port: config.port, allowedHosts: config.allowedHosts },
    probePort: options.portProbe ?? realProbePort,
    lock,
    logger,
    restartInfo: () =>
      update.mode === 'service'
        ? { automatic: true, note: msg('NETWORK_RESTART_AUTOMATIC') }
        : { automatic: false, note: msg('NETWORK_RESTART_MANUAL') },
    ...(options.network?.interfaces === undefined ? {} : { interfaces: options.network.interfaces }),
    ...(options.network?.hostname === undefined ? {} : { hostname: options.network.hostname }),
  });
  const restart = new RestartService({
    db,
    manager,
    bus,
    network,
    update,
    autostart,
    logger,
    ...(options.restart?.exit === undefined ? {} : { exit: options.restart.exit }),
    ...(options.restart?.delayMs === undefined ? {} : { delayMs: options.restart.delayMs }),
  });
  const configFiles = new ConfigFilesService({ db, serversDir: config.serversDir, lock, bus, games, guard });
  const workshop = new ZomboidWorkshopService({ db, serversDir: config.serversDir, lock, guard, api: options.workshopApi ?? new SteamWorkshopClient(options.fetch ?? fetch) });
  return { lock, bus, catalog, games, curseforge, configFiles, workshop, java, manager, install, servers, properties, players, mods, backups, backupScheduler, autostart, update, network, restart, auth, exports: exportsService, imports };
}
