import type { Loader } from '../db/enums.js';
import { AppError } from '../http/errors.js';
import type { MessageRef, Msg } from '../messages.js';
import { JavaDetector } from './detect.js';
import type { EnsureOptions, JavaInstallEvent, ManagedRuntimeInfo, ManagedRuntimes } from './managed.js';
import {
  chooseRuntime,
  javaRequirement,
  meetsRequirement,
  pickInstallMajor,
  type JavaRequirement,
  type JavaRuntime,
} from './select.js';

// file name of a user-supplied path; splits on both separators because a Windows path may reach a Linux host (and vice versa)
export const fileNameOf = (filePath: string): string => filePath.split(/[\\/]/).pop() ?? '';

export interface JavaSelection {
  runtime: JavaRuntime;
  warnings: Msg[];
}

export interface JavaNeeds {
  javaPath: string | null;
  loader: Loader;
  mcVersion: string;
  requiredMajor: number | null;
}

// What to do for a server: use a runtime that exists, or install this major first
export type JavaPlan = ({ kind: 'ready' } & JavaSelection) | { kind: 'install'; major: number; warnings: Msg[] };

interface Range {
  min: number;
  max: number | null;
}

export class JavaService {
  constructor(
    private readonly detector: JavaDetector = new JavaDetector(),
    private readonly managed: ManagedRuntimes | null = null,
    private readonly autoInstall = false,
  ) {}

  get autoInstallEnabled(): boolean {
    return this.autoInstall && this.managed !== null;
  }

  get canInstall(): boolean {
    return this.managed !== null;
  }

  detect(rescan = false): Promise<JavaRuntime[]> {
    return this.detector.detect(rescan);
  }

  // user-supplied path: must be a java executable that answers -version
  async validatePath(javaPath: string): Promise<JavaRuntime> {
    const base = fileNameOf(javaPath).toLowerCase();
    if (javaPath.trim() === '' || (base !== 'java' && base !== 'java.exe')) {
      throw new AppError(422, 'JAVA_INVALID', 'The Java path must point to a file named java or java.exe.');
    }
    const runtime = await this.detector.inspect(javaPath, 'manual');
    if (runtime === null) {
      throw new AppError(
        422,
        'JAVA_INVALID',
        'The given Java file could not be executed or is not a valid Java installation.',
      );
    }
    return runtime;
  }

  // Decides without installing anything. Errors are the classic JAVA_NOT_FOUND / JAVA_VERSION_INCOMPATIBLE
  // whenever a missing runtime may not (or cannot) be installed automatically.
  async plan(needs: JavaNeeds): Promise<JavaPlan> {
    const requirement = javaRequirement(needs.loader, needs.mcVersion, needs.requiredMajor);
    const warnings = requirement.note === null ? [] : [requirement.note];
    if (needs.javaPath !== null) {
      const runtime = await this.detector.inspect(needs.javaPath, 'manual');
      if (runtime === null) {
        throw new AppError(
          422,
          'JAVA_NOT_FOUND',
          `The configured Java installation was not found or does not start: ${needs.javaPath}`,
          { javaPath: needs.javaPath },
        );
      }
      if (!meetsRequirement(runtime.major, requirement)) throw this.incompatible(requirement, [runtime.major]);
      return { kind: 'ready', runtime, warnings };
    }
    const runtimes = await this.detector.detect();
    const runtime = chooseRuntime(runtimes, requirement);
    if (runtime !== null) return { kind: 'ready', runtime, warnings };
    const major = this.autoInstallEnabled ? pickInstallMajor(requirement) : null;
    if (major !== null) return { kind: 'install', major, warnings };
    if (runtimes.length === 0) {
      throw new AppError(
        422,
        'JAVA_NOT_FOUND',
        `No Java installation was found. Java ${this.describe(requirement)} is required. Please install Java or set the Java path in the server settings.`,
        { required: requirement.min, requiredMax: requirement.max, found: [] },
      );
    }
    throw this.incompatible(
      requirement,
      runtimes.map((entry) => entry.major),
    );
  }

  // Never installs: for callers that cannot wait for a download
  async select(needs: JavaNeeds): Promise<JavaSelection> {
    const plan = await this.plan(needs);
    if (plan.kind === 'ready') return { runtime: plan.runtime, warnings: plan.warnings };
    throw new AppError(422, 'JAVA_NOT_FOUND', `Java ${plan.major} is not installed.`, { required: plan.major }, { major: plan.major });
  }

  // Selects a runtime and installs the missing one first (shared per major, progress via options)
  async acquire(needs: JavaNeeds, options: EnsureOptions = {}): Promise<JavaSelection> {
    const plan = await this.plan(needs);
    if (plan.kind === 'ready') return { runtime: plan.runtime, warnings: plan.warnings };
    await this.ensureManaged(plan.major, options);
    const selection = await this.select(needs);
    return { runtime: selection.runtime, warnings: plan.warnings };
  }

  private requireManaged(): ManagedRuntimes {
    if (this.managed === null) {
      throw new AppError(409, 'JAVA_INSTALL_UNAVAILABLE', 'Automatic Java installation is not available in this configuration.');
    }
    return this.managed;
  }

  async ensureManaged(major: number, options: EnsureOptions = {}): Promise<JavaRuntime> {
    const managed = this.requireManaged();
    const info = await managed.ensure(major, options);
    await this.detector.detect(true);
    return managed.toRuntime(info);
  }

  onInstallEvent(listener: (event: JavaInstallEvent) => void): () => void {
    return this.managed === null ? () => undefined : this.managed.onEvent(listener);
  }

  // boot: removes what an interrupted install left behind
  cleanup(): Promise<number> {
    return this.managed === null ? Promise.resolve(0) : this.managed.cleanup();
  }

  shutdown(): void {
    this.managed?.shutdown();
  }

  listManaged(): Promise<ManagedRuntimeInfo[]> {
    return this.managed === null ? Promise.resolve([]) : this.managed.list();
  }

  activeInstalls(): Array<{ major: number; phase: string | null; percent: number | null; message: string | null; messageRef: MessageRef | null }> {
    return (this.managed?.activeInstalls() ?? []).map((entry) => ({
      major: entry.major,
      phase: entry.progress?.phase ?? null,
      percent: entry.progress?.percent ?? null,
      message: entry.progress?.message ?? null,
      messageRef: entry.progress?.ref ?? null,
    }));
  }

  async removeManaged(major: number): Promise<void> {
    await this.requireManaged().remove(major);
    await this.detector.detect(true);
  }

  private describe({ min, max }: Range): string {
    if (max === null) return `${min} or newer`;
    return min === max ? `${min}` : `${min} to ${max}`;
  }

  private incompatible(range: JavaRequirement, found: number[]): AppError {
    return new AppError(
      422,
      'JAVA_VERSION_INCOMPATIBLE',
      `This server requires Java ${this.describe(range)}, but Java ${[...new Set(found)].join(', ')} was found.`,
      { required: range.min, requiredMax: range.max, found },
    );
  }
}
