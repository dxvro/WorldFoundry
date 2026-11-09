import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

export const DISABLED_SUFFIX = '.disabled';

export interface HashedFile {
  // name without the .disabled suffix: the identity of the mod in the database
  fileName: string;
  diskName: string;
  enabled: boolean;
  sha512: string;
  size: number;
}

export function hashFile(filePath: string): Promise<{ sha512: string; size: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    let size = 0;
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve({ sha512: hash.digest('hex'), size }));
  });
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface ModFileName {
  fileName: string;
  enabled: boolean;
}

// "a.jar" is an active mod, "a.jar.disabled" the same mod switched off (loaders ignore it)
export function parseModFileName(diskName: string): ModFileName | null {
  if (/\.jar$/i.test(diskName)) return { fileName: diskName, enabled: true };
  if (/\.jar\.disabled$/i.test(diskName)) return { fileName: diskName.slice(0, -DISABLED_SUFFIX.length), enabled: false };
  return null;
}

export const diskNameOf = (mod: { fileName: string; enabled: boolean }): string => (mod.enabled ? mod.fileName : `${mod.fileName}${DISABLED_SUFFIX}`);

export async function listModFiles(dir: string): Promise<Array<ModFileName & { diskName: string }>> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .flatMap((entry) => {
        const parsed = parseModFileName(entry.name);
        return parsed === null ? [] : [{ ...parsed, diskName: entry.name }];
      })
      .sort((a, b) => a.diskName.localeCompare(b.diskName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function removeQuietly(...files: string[]): Promise<void> {
  await Promise.all(files.map((file) => rm(file, { force: true }).catch(() => undefined)));
}

export const baseName = (fileName: string): string => path.basename(fileName).replace(/\.jar$/i, '');
