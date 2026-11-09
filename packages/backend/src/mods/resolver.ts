import type { DependencyType } from '../db/enums.js';
import type { Mod } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { msg, MsgList, type MessageRef } from '../messages.js';
import type { ModrinthApi, Version, VersionFile } from '../modrinth/types.js';
import type { LoaderProfile } from './profile.js';
import { chooseNewest, isCompatible, pickFile } from './versions.js';

export const MAX_PLAN_SIZE = 64;
const KNOWN_TYPES: readonly string[] = ['required', 'optional', 'incompatible', 'embedded'];

export interface InstalledIncompatibility {
  modId: string;
  modName: string;
  projectId: string;
}

export interface ResolverContext {
  modrinth: ModrinthApi;
  profile: LoaderProfile;
  mcVersion: string;
  installed: readonly Mod[];
  installedIncompatibilities: readonly InstalledIncompatibility[];
  // modId -> ids of the installed mods it requires, to follow a chain of switched-off dependencies
  requiredLinks: ReadonlyMap<string, readonly string[]>;
  maxPlanSize?: number;
}

export interface PlannedDependency {
  type: DependencyType;
  projectId: string | null;
  versionId: string | null;
  fileName: string | null;
  linkProjectId: string | null;
}

export interface PlanItem {
  projectId: string;
  version: Version;
  file: VersionFile;
  isDependency: boolean;
  dependencies: PlannedDependency[];
}

export interface InstallPlan {
  items: PlanItem[];
  warnings: string[];
  // parallel to `warnings`
  warningRefs: MessageRef[];
  names: Map<string, string>;
  // installed mods that are switched off but needed by the plan; they are switched on together with it
  reenable: Mod[];
}

export type InstallDecision = { kind: 'flip'; mod: Mod } | { kind: 'install'; plan: InstallPlan };

interface IncompatibleEdge {
  fromProjectId: string;
  targetProjectId: string;
}

class PlanBuilder {
  private readonly planned = new Map<string, PlanItem>();
  private readonly versionCache = new Map<string, Version>();
  private readonly names = new Map<string, string>();
  private readonly installedByProject = new Map<string, Mod>();
  private readonly installedById = new Map<string, Mod>();
  private readonly reenable = new Map<string, Mod>();
  private readonly reenableReasons: Array<{ mod: Mod; requiredBy: { projectId: string } | { name: string } }> = [];
  private readonly installedFiles = new Set<string>();
  private readonly edges: IncompatibleEdge[] = [];
  private readonly incompatibilities: readonly InstalledIncompatibility[];
  private readonly maxSize: number;
  readonly warnings = new MsgList();

  constructor(
    private readonly ctx: ResolverContext,
    replacingModId: string | null,
    // false when the root is a switched-off mod being updated: it needs nothing switched on and conflicts with nothing
    private readonly rootEnabled = true,
  ) {
    for (const mod of ctx.installed) {
      if (mod.id === replacingModId) continue;
      this.installedById.set(mod.id, mod);
      this.installedFiles.add(mod.fileName.toLowerCase());
      if (mod.projectId !== null) {
        this.installedByProject.set(mod.projectId, mod);
        this.names.set(mod.projectId, mod.name);
      }
    }
    this.incompatibilities = ctx.installedIncompatibilities.filter((entry) => entry.modId !== replacingModId);
    this.maxSize = ctx.maxPlanSize ?? MAX_PLAN_SIZE;
  }

  async version(id: string): Promise<Version | null> {
    const cached = this.versionCache.get(id);
    if (cached !== undefined) return cached;
    try {
      const version = await this.ctx.modrinth.getVersion(id);
      this.versionCache.set(id, version);
      return version;
    } catch (error) {
      if (error instanceof AppError && error.code === 'MOD_NOT_FOUND') return null;
      throw error;
    }
  }

  async newestFor(projectId: string, minRank = 0): Promise<Version | null> {
    const versions = await this.ctx.modrinth.listProjectVersions(projectId, this.ctx.profile.loaders, [this.ctx.mcVersion]);
    for (const version of versions) this.versionCache.set(version.id, version);
    return chooseNewest(versions, this.ctx.profile, this.ctx.mcVersion, minRank);
  }

  async addRoot(version: Version, isDependency: boolean): Promise<void> {
    this.rootProjectId = version.project_id;
    await this.add(version, isDependency, [version.project_id]);
  }

  private rootProjectId: string | null = null;

  private isInactiveRoot(projectId: string): boolean {
    return !this.rootEnabled && projectId === this.rootProjectId;
  }

  private async add(version: Version, isDependency: boolean, chain: string[]): Promise<void> {
    if (this.planned.size >= this.maxSize) {
      throw new AppError(422, 'PLAN_TOO_LARGE', `The dependencies include more than ${this.maxSize} mods. The installation was cancelled.`, undefined, { max: this.maxSize });
    }
    const file = pickFile(version);
    if (file === null) {
      throw new AppError(422, 'DEPENDENCY_UNRESOLVABLE', 'The version does not contain a downloadable .jar file.');
    }
    const item: PlanItem = { projectId: version.project_id, version, file, isDependency, dependencies: [] };
    this.planned.set(version.project_id, item);

    for (const dep of version.dependencies) {
      if (!KNOWN_TYPES.includes(dep.dependency_type)) continue;
      const type = dep.dependency_type as DependencyType;
      const entry: PlannedDependency = {
        type,
        projectId: dep.project_id ?? null,
        versionId: dep.version_id ?? null,
        fileName: dep.file_name ?? null,
        linkProjectId: dep.project_id ?? null,
      };
      item.dependencies.push(entry);
      if (type === 'incompatible' && entry.projectId !== null) {
        if (this.isInactiveRoot(version.project_id)) continue;
        this.edges.push({ fromProjectId: version.project_id, targetProjectId: entry.projectId });
      } else if (type === 'required') {
        entry.linkProjectId = await this.resolveRequired(dep, version, chain);
      }
    }
  }

  private async resolveRequired(
    dep: Version['dependencies'][number],
    parent: Version,
    chain: string[],
  ): Promise<string | null> {
    let pinned: Version | null = null;
    let projectId = dep.project_id ?? null;
    if (projectId === null && dep.version_id != null) {
      pinned = await this.version(dep.version_id);
      projectId = pinned?.project_id ?? null;
    }
    if (projectId === null) {
      const fileName = dep.file_name?.toLowerCase();
      const present = fileName !== undefined && (this.installedFiles.has(fileName) || this.plannedFile(fileName));
      if (!present) {
        this.warnings.push(msg('MOD_DEPENDENCY_EXTERNAL', { dependency: dep.file_name ?? 'unknown', parent: parent.name }));
      }
      return null;
    }

    const planned = this.planned.get(projectId);
    if (planned !== undefined) {
      if (dep.version_id != null && dep.version_id !== planned.version.id) {
        this.warnings.push(msg('MOD_DEPENDENCY_VERSION_CLASH', { parent: parent.name, mod: planned.version.name }));
      }
      return projectId;
    }
    const present = this.installedByProject.get(projectId);
    if (present !== undefined) {
      this.requireEnabled(present, { projectId: parent.project_id });
      return projectId;
    }

    let target: Version | null = null;
    if (dep.version_id != null) {
      pinned ??= await this.version(dep.version_id);
      if (pinned !== null && pinned.project_id === projectId && isCompatible(pinned, this.ctx.profile, this.ctx.mcVersion)) {
        target = pinned;
      }
    }
    target ??= await this.newestFor(projectId);
    if (target === null) {
      const names = await this.titles([...chain, projectId]);
      throw new AppError(
        422,
        'DEPENDENCY_UNRESOLVABLE',
        `There is no version of the required dependency "${names[names.length - 1]}" for Minecraft ${this.ctx.mcVersion} with ${this.ctx.profile.loaders.join('/')} (${names.join(' -> ')}).`,
        { chain: names, projectId },
      );
    }
    await this.add(target, true, [...chain, projectId]);
    return projectId;
  }

  // a required mod that is installed but switched off is switched on again, together with what it requires
  private requireEnabled(mod: Mod, requiredBy: { projectId: string } | { name: string }): void {
    if (mod.enabled || this.reenable.has(mod.id) || !this.rootEnabled) return;
    this.reenable.set(mod.id, mod);
    this.reenableReasons.push({ mod, requiredBy });
    for (const id of this.ctx.requiredLinks.get(mod.id) ?? []) {
      const dependency = this.installedById.get(id);
      if (dependency !== undefined) this.requireEnabled(dependency, { name: mod.name });
    }
  }

  private plannedFile(lowerName: string): boolean {
    return [...this.planned.values()].some((item) => item.file.filename.toLowerCase() === lowerName);
  }

  private async titles(projectIds: readonly string[]): Promise<string[]> {
    const missing = projectIds.filter((id) => !this.names.has(id));
    if (missing.length > 0) {
      try {
        for (const project of await this.ctx.modrinth.getProjects(missing)) this.names.set(project.id, project.title);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
      }
    }
    return projectIds.map((id) => this.names.get(id) ?? id);
  }

  async finish(): Promise<InstallPlan> {
    const ids = [...this.planned.keys()];
    await this.titles(ids);
    const name = (id: string): string => this.names.get(id) ?? id;
    for (const { mod, requiredBy } of this.reenableReasons) {
      const by = 'projectId' in requiredBy ? name(requiredBy.projectId) : requiredBy.name;
      this.warnings.push(msg('MOD_REENABLED', { name: mod.name, by }));
    }
    const conflict = (first: string, second: string): AppError =>
      new AppError(409, 'MOD_INCOMPATIBLE', `"${first}" is not compatible with "${second}".`, { mods: [first, second] }, { first, second });

    // only mods that will be switched on can collide: enabled ones, the ones switched on again, and the new ones
    const active = new Set<string>();
    for (const mod of this.installedById.values()) if (mod.enabled || this.reenable.has(mod.id)) active.add(mod.id);
    const activeProjects = new Set<string>();
    for (const id of active) {
      const projectId = this.installedById.get(id)?.projectId;
      if (projectId != null) activeProjects.add(projectId);
    }
    for (const projectId of this.planned.keys()) if (!this.isInactiveRoot(projectId)) activeProjects.add(projectId);
    const reenabledProjects = new Set<string>();
    for (const mod of this.reenable.values()) if (mod.projectId !== null) reenabledProjects.add(mod.projectId);

    for (const edge of this.edges) {
      if (activeProjects.has(edge.targetProjectId) && edge.targetProjectId !== edge.fromProjectId) {
        throw conflict(name(edge.fromProjectId), name(edge.targetProjectId));
      }
    }
    for (const entry of this.incompatibilities) {
      if (!active.has(entry.modId)) continue;
      const plannedTarget = this.planned.has(entry.projectId) && !this.isInactiveRoot(entry.projectId);
      const touchesReenabled = this.reenable.has(entry.modId) ? activeProjects.has(entry.projectId) : reenabledProjects.has(entry.projectId);
      if (plannedTarget || touchesReenabled) throw conflict(entry.modName, name(entry.projectId));
    }
    return { items: [...this.planned.values()], warnings: this.warnings.texts, warningRefs: this.warnings.refs, names: this.names, reenable: [...this.reenable.values()] };
  }
}

export async function planInstall(
  ctx: ResolverContext,
  projectId: string,
  versionId: string | undefined,
): Promise<InstallDecision> {
  const builder = new PlanBuilder(ctx, null);
  let target: Version | null;
  if (versionId !== undefined) {
    target = await builder.version(versionId);
    if (target === null || target.project_id !== projectId) {
      throw new AppError(404, 'MOD_NOT_FOUND', 'The requested version does not belong to this project or does not exist.');
    }
    if (!isCompatible(target, ctx.profile, ctx.mcVersion)) {
      throw new AppError(
        422,
        'VERSION_INCOMPATIBLE',
        `The chosen version is not compatible with Minecraft ${ctx.mcVersion} and ${ctx.profile.loaders.join('/')}.`,
      );
    }
  } else {
    target = await builder.newestFor(projectId);
    if (target === null) {
      throw new AppError(
        422,
        'NO_COMPATIBLE_VERSION',
        `There is no version for Minecraft ${ctx.mcVersion} with ${ctx.profile.loaders.join('/')}.`,
      );
    }
  }

  const existing = ctx.installed.find((mod) => mod.projectId === projectId);
  if (existing !== undefined) {
    if (existing.versionId !== target.id) {
      throw new AppError(
        409,
        'MOD_VERSION_DIFFERS',
        `"${existing.name}" is already installed in a different version. Please use the update function.`,
      );
    }
    if (!existing.enabled) {
      throw new AppError(409, 'MOD_DISABLED', `"${existing.name}" is installed but disabled. Please enable it in the mod list.`, { modId: existing.id }, { name: existing.name });
    }
    if (existing.isDependency) return { kind: 'flip', mod: existing };
    throw new AppError(409, 'MOD_ALREADY_INSTALLED', `"${existing.name}" is already installed.`, undefined, { name: existing.name });
  }

  await builder.addRoot(target, false);
  return { kind: 'install', plan: await builder.finish() };
}

export async function planUpdate(ctx: ResolverContext, mod: Mod, target: Version): Promise<InstallPlan> {
  const builder = new PlanBuilder(ctx, mod.id, mod.enabled);
  await builder.addRoot(target, mod.isDependency);
  return builder.finish();
}
