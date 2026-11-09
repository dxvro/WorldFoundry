import type { DependencyType } from '../db/enums.js';
import type { NewModDependency } from '../db/schema.js';
import type { ModrinthDependency } from '../modrinth/types.js';

const KNOWN_TYPES: readonly string[] = ['required', 'optional', 'incompatible', 'embedded'];

export const isKnownDependencyType = (type: string): type is DependencyType => KNOWN_TYPES.includes(type);

// links to local mods are filled in afterwards by relinkDependencies
export function dependencyRowsFor(modId: string, dependencies: readonly ModrinthDependency[]): NewModDependency[] {
  return dependencies.flatMap((dep) =>
    isKnownDependencyType(dep.dependency_type)
      ? [
          {
            modId,
            dependencyType: dep.dependency_type,
            projectId: dep.project_id ?? null,
            versionId: dep.version_id ?? null,
            fileName: dep.file_name ?? null,
            dependsOnModId: null,
          },
        ]
      : [],
  );
}
