import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { renameWithRetry } from '../lib/fs-retry.js';
import { rethrowFsError } from '../mods/fs-errors.js';

const exists = (file: string): Promise<boolean> => lstat(file).then(() => true, () => false);

// Exchanges world folders inside one server directory by renames only: what is in the way is moved into `trash`
// first, then the new folders are moved in. If any step fails everything is moved back, so the server keeps
// exactly the world it had. `replaced` lists every folder name that must not survive (stale Nether/End folders).
export async function swapWorlds(serverDir: string, incomingDir: string, trashDir: string, incoming: readonly string[], replaced: readonly string[]): Promise<void> {
  const aside: Array<{ from: string; to: string }> = [];
  const placed: Array<{ from: string; to: string }> = [];
  try {
    await mkdir(trashDir, { recursive: true });
    for (const name of new Set([...replaced, ...incoming])) {
      const source = path.join(serverDir, name);
      if (!(await exists(source))) continue;
      const target = path.join(trashDir, name);
      await renameWithRetry(source, target);
      aside.push({ from: source, to: target });
    }
    for (const name of incoming) {
      const from = path.join(incomingDir, name);
      const to = path.join(serverDir, name);
      await renameWithRetry(from, to);
      placed.push({ from, to });
    }
  } catch (error) {
    for (const move of [...placed].reverse()) await renameWithRetry(move.to, move.from).catch(() => undefined);
    for (const move of [...aside].reverse()) await renameWithRetry(move.to, move.from).catch(() => undefined);
    rethrowFsError(error, path.basename(serverDir));
  }
}
