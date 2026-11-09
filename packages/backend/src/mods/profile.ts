import type { Loader } from '../db/enums.js';
import { AppError } from '../http/errors.js';

export interface LoaderProfile {
  contentDir: 'mods' | 'plugins';
  backupDir: 'mods_backup' | 'plugins_backup';
  projectType: 'mod' | 'plugin';
  loaders: readonly string[];
}

export function getLoaderProfile(loader: Loader): LoaderProfile | null {
  switch (loader) {
    case 'fabric':
    case 'forge':
    case 'neoforge':
      return { contentDir: 'mods', backupDir: 'mods_backup', projectType: 'mod', loaders: [loader] };
    case 'paper':
      return {
        contentDir: 'plugins',
        backupDir: 'plugins_backup',
        projectType: 'plugin',
        loaders: ['paper', 'spigot', 'bukkit'],
      };
    case 'vanilla':
      return null;
  }
}

export function requireLoaderProfile(loader: Loader): LoaderProfile {
  const profile = getLoaderProfile(loader);
  if (profile === null) {
    throw new AppError(409, 'MODS_NOT_SUPPORTED', 'Vanilla servers do not support mods or plugins.');
  }
  return profile;
}
