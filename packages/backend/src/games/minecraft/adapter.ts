import { access, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Server } from '../../db/schema.js';
import { AppError } from '../../http/errors.js';
import type { LoaderCatalog } from '../../installer/catalog.js';
import { LOADER_INFO } from '../../installer/catalog.js';
import { detectForgeLaunch } from '../../installer/detect-launch.js';
import { launchTarget, parseLaunchSpec, serializeLaunchSpec, type LaunchSpec } from '../../installer/launch-spec.js';
import type { InstallerRunner } from '../../installer/runner.js';
import type { ResolvedInstall } from '../../installer/types.js';
import type { JavaService } from '../../java/service.js';
import { silentLogger, type Logger } from '../../lib/logger.js';
import { msg } from '../../messages.js';
import { downloadToTmp } from '../../mods/downloader.js';
import { removeQuietly } from '../../mods/files.js';
import { rethrowFsError } from '../../mods/fs-errors.js';
import { buildJavaArgs } from '../../process/command.js';
import { EULA_URL, writeEulaFile } from '../../process/eula.js';
import { classifyLine } from '../../process/patterns.js';
import { loadProperties, saveProperties } from '../../properties/store.js';
import { DEFAULT_PORT, readTyped } from '../../properties/typed.js';
import { gameDefinition } from '../registry.js';
import type { GameAdapter, InstallContext, StartPlan } from '../types.js';

const INSTALLER_TIMEOUT_MS = 10 * 60_000;
const TAIL_LINES = 15;
const PROGRESS_INTERVAL_MS = 250;

export interface MinecraftAdapterOptions {
  catalog: LoaderCatalog;
  java: JavaService;
  runner: InstallerRunner;
  platform?: NodeJS.Platform;
  installerTimeoutMs?: number;
  // saves a port found in server.properties into the server row
  savePort: (serverId: string, port: number) => Promise<void>;
  logger?: Logger;
}

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

const aborted = (): AppError => new AppError(500, 'INSTALL_ABORTED', 'The installation was interrupted (the application is shutting down).');

// Minecraft: Java Edition. Server files come from the official source of the loader; a loader with an installer
// (Forge, NeoForge) runs it with Java. The process is Java with the start file of the loader.
export class MinecraftAdapter implements GameAdapter {
  readonly definition = gameDefinition('minecraft');
  readonly stopCommand = 'stop';
  private readonly platform: NodeJS.Platform;
  private readonly logger: Logger;

  constructor(private readonly options: MinecraftAdapterOptions) {
    this.platform = options.platform ?? process.platform;
    this.logger = options.logger ?? silentLogger;
  }

  classifyLine(line: string): ReturnType<typeof classifyLine> {
    return classifyLine(line);
  }

  installTitle(server: Server): string {
    return `${server.loader} ${server.mcVersion}${server.loaderVersion === null ? '' : ` ${server.loaderVersion}`}`;
  }

  async validateInstall(server: Server, options: { checkJava: boolean }): Promise<void> {
    if (!options.checkJava || !LOADER_INFO[server.loader].requiresInstallerJava) return;
    // a missing runtime is installed by the job itself when automatic installation is on; otherwise this throws
    await this.options.java.plan({ javaPath: server.javaPath, loader: server.loader, mcVersion: server.mcVersion, requiredMajor: server.requiredJavaMajor });
  }

  async install(server: Server, ctx: InstallContext): Promise<Partial<Server>> {
    const { catalog, java } = this.options;
    const { dir, signal, log, progress } = ctx;
    const checkAborted = (): void => {
      if (signal.aborted) throw aborted();
    };

    progress('resolve', null, msg('INSTALL_STEP_RESOLVE'));
    log('Querying the version at the source ...');
    const plan = await catalog.resolve(server.loader, server.mcVersion, server.loaderVersion);
    for (const note of plan.notes) log(`Note: ${note}`);
    log(`Source: ${plan.artifact.url}`);
    checkAborted();

    let javaPath = '';
    if (plan.mode.kind === 'installer') {
      let javaStep = '';
      const selection = await java.acquire(
        { javaPath: server.javaPath, loader: server.loader, mcVersion: server.mcVersion, requiredMajor: plan.requiredJavaMajor },
        {
          signal,
          onProgress: (step) => {
            progress('java', step.percent, step.ref === undefined ? step.message : { text: step.message, ref: step.ref });
            if (step.phase !== javaStep) log(step.message);
            javaStep = step.phase;
          },
        },
      );
      javaPath = selection.runtime.path;
      log(`Using Java ${selection.runtime.major} (${selection.runtime.path})`);
      for (const warning of selection.warnings) log(`Note: ${warning.text}`);
    }

    const tmpDir = path.join(dir, '.tmp');
    await rm(tmpDir, { recursive: true, force: true });
    let lastReport = 0;
    const part = await downloadToTmp(
      {
        url: plan.artifact.url,
        fileName: plan.artifact.fileName,
        ...(plan.artifact.hash === undefined ? {} : { hash: plan.artifact.hash }),
        ...(plan.artifact.size === undefined ? {} : { size: plan.artifact.size }),
        allowedHosts: plan.artifact.allowedHosts,
        requireZip: plan.artifact.requireZip,
        onProgress: (received, total) => {
          const now = Date.now();
          if (now - lastReport < PROGRESS_INTERVAL_MS && received !== total) return;
          lastReport = now;
          const percent = total === null || total === 0 ? null : Math.min(99, Math.floor((received / total) * 100));
          progress('download', percent, msg('INSTALL_STEP_DOWNLOAD', { fileName: plan.artifact.fileName, kib: Math.round(received / 1024) }));
        },
      },
      tmpDir,
      catalog.downloader,
    );
    log(`Download finished${plan.artifact.hash === undefined ? '' : ` (${plan.artifact.hash.algorithm} verified)`}`);
    const target = path.join(dir, plan.artifact.fileName);
    try {
      await rename(part, target);
    } catch (error) {
      await removeQuietly(part);
      rethrowFsError(error, plan.artifact.fileName);
    }
    checkAborted();

    let launch: LaunchSpec;
    if (plan.mode.kind === 'jar') {
      launch = { kind: 'jar', jar: plan.mode.launchJar };
    } else {
      try {
        launch = await this.runInstaller(server, plan, javaPath, ctx);
      } finally {
        await rm(target, { force: true }).catch(() => undefined);
      }
    }
    log(`Start file: ${launch.kind === 'jar' ? launch.jar : launch.unixFile}`);
    return { launchSpec: serializeLaunchSpec(launch), requiredJavaMajor: plan.requiredJavaMajor, loaderVersion: plan.loaderVersion };
  }

  private async runInstaller(server: Server, plan: ResolvedInstall, javaPath: string, ctx: InstallContext): Promise<LaunchSpec> {
    if (plan.mode.kind !== 'installer') throw new AppError(500, 'INTERNAL_ERROR', 'Invalid installation mode.');
    ctx.progress('install', null, msg('INSTALL_STEP_INSTALLER'));
    ctx.log(`Running installer: java -jar ${plan.artifact.fileName} ${plan.mode.arguments.join(' ')}`);
    const tail: string[] = [];
    const timeoutMs = this.options.installerTimeoutMs ?? INSTALLER_TIMEOUT_MS;
    let result;
    try {
      result = await this.options.runner({
        javaPath,
        args: ['-jar', plan.artifact.fileName, ...plan.mode.arguments],
        cwd: ctx.dir,
        timeoutMs,
        signal: ctx.signal,
        onLine: (line) => {
          ctx.log(line);
          tail.push(line);
          if (tail.length > TAIL_LINES) tail.shift();
        },
      });
    } catch (error) {
      this.logger.error({ err: error }, 'The installer could not be started');
      throw new AppError(500, 'INSTALLER_FAILED', 'The installer could not be started. Is the Java file valid?', undefined, { reason: 'not-started' });
    }
    const output = tail.length === 0 ? '' : `\nLast output:\n${tail.join('\n')}`;
    if (result.aborted) throw aborted();
    if (result.timedOut) {
      throw new AppError(500, 'INSTALLER_TIMEOUT', `The installer was cancelled after ${Math.round(timeoutMs / 60_000)} minutes.${output}`, undefined, {
        minutes: Math.round(timeoutMs / 60_000),
        output: tail.join('\n'),
      });
    }
    if (result.exitCode !== 0) {
      throw new AppError(500, 'INSTALLER_FAILED', `The installer failed with exit code ${result.exitCode ?? 'unknown'}.${output}`, undefined, {
        reason: 'exit',
        exitCode: result.exitCode ?? 'unknown',
        output: tail.join('\n'),
      });
    }
    if (server.loader !== 'forge' && server.loader !== 'neoforge') throw new AppError(500, 'INTERNAL_ERROR', 'Invalid installation mode.');
    return detectForgeLaunch(ctx.dir, server.loader, server.mcVersion, plan.loaderVersion);
  }

  async planStart(server: Server, dir: string, options: { resumed: boolean }): Promise<StartPlan> {
    if (!server.eulaAccepted) {
      throw new AppError(
        409,
        'EULA_NOT_ACCEPTED',
        `The Minecraft EULA (${EULA_URL}) has not been accepted for this server yet. Acceptance is required before the server can start.`,
      );
    }
    const launch = parseLaunchSpec(server.launchSpec);
    const target = launch === null ? null : launchTarget(launch, this.platform);
    if (launch === null || target === null || !(await exists(path.join(dir, target.file)))) {
      throw new AppError(409, 'SERVER_FILES_MISSING', 'The start file of the server is missing. Please start the installation again.');
    }

    const java = this.options.java;
    const plan = await java.plan({ javaPath: server.javaPath, loader: server.loader, mcVersion: server.mcVersion, requiredMajor: server.requiredJavaMajor });
    if (plan.kind === 'install') {
      const { major } = plan;
      const stillMissing = (): AppError =>
        new AppError(422, 'JAVA_NOT_FOUND', `Java ${major} was installed but cannot be found. Please check the Java list under Configuration.`, undefined, { major });
      if (options.resumed) throw stillMissing();
      return {
        kind: 'prepare',
        port: server.port,
        notes: plan.warnings,
        task: {
          javaMajor: major,
          notice: msg('JAVA_AUTO_INSTALL_NOTICE', { major }),
          status: (percent) => (percent === null ? msg('JAVA_INSTALLING', { major }) : msg('JAVA_INSTALLING_PERCENT', { major, percent })),
          run: async (signal, onProgress) => {
            await java.ensureManaged(major, {
              signal,
              onProgress: (progress) =>
                onProgress({ phase: progress.phase, percent: progress.percent, text: progress.ref === undefined ? progress.message : { text: progress.message, ref: progress.ref } }),
            });
          },
          done: msg('JAVA_INSTALLED_STARTING', { major }),
          cancelled: msg('START_CANCELLED_JAVA'),
          failed: msg('JAVA_INSTALL_FAILED_GENERIC'),
          stillMissing,
        },
      };
    }
    const { runtime, warnings } = plan;
    const port = await this.resolvePort(server, dir);
    return {
      kind: 'launch',
      plan: {
        command: runtime.path,
        args: buildJavaArgs({
          minRamMb: server.minRamMb,
          maxRamMb: server.maxRamMb,
          useAikarFlags: server.useAikarFlags,
          extraJvmArgs: server.extraJvmArgs,
          launch,
          platform: this.platform,
        }),
        port,
        startLine: msg('SERVER_STARTING', { major: runtime.major, port }),
        notes: warnings,
        beforeSpawn: () => writeEulaFile(dir, true),
        javaPath: runtime.path,
      },
    };
  }

  // server.properties decides the port; a missing file is created with the port of the server row
  private async resolvePort(server: Server, dir: string): Promise<number> {
    const { doc, exists: hasFile } = await loadProperties(dir);
    let port: number;
    if (!hasFile) {
      doc.set('server-port', String(server.port));
      await saveProperties(dir, doc);
      port = server.port;
    } else {
      port = doc.get('server-port') === undefined ? DEFAULT_PORT : readTyped(doc)['server-port'];
    }
    if (port !== server.port) await this.options.savePort(server.id, port);
    return port;
  }
}
