import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CODE_ROOT, isRepoLayout, type AppConfig } from '../config/env.js';
import type { TrustedKey } from './keys.js';
import { requestDirOf } from './protocol.js';
import type { InstallMode } from './types.js';

// <install>/app/backend -> <install>; in a checkout this is the repository root
export const installRootOf = (codeRoot: string = CODE_ROOT): string => path.resolve(codeRoot, '..', '..');

const testMarkerSchema = z.object({
  apiBase: z.url().optional(),
  trustedKeys: z.array(z.object({ id: z.string().min(1).max(64), publicKey: z.string().min(40).max(2000) })).max(5).default([]),
});

export interface TestMarker {
  apiBase?: string;
  trustedKeys: TrustedKey[];
}

// Marks a package that was built for the end-to-end update test (`package.mjs --test-update ...`). The file lives
// in the install folder (root-owned, the application cannot create it), so it cannot be switched on by a normal
// configuration: UPDATE_API_BASE and additional keys are ignored without it.
export function readTestMarker(root: string): TestMarker | null {
  try {
    const file = path.join(root, 'tools', 'update-test.json');
    if (!existsSync(file)) return null;
    const parsed = testMarkerSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (!parsed.success) return null;
    return { ...(parsed.data.apiBase === undefined ? {} : { apiBase: parsed.data.apiBase }), trustedKeys: parsed.data.trustedKeys };
  } catch {
    return null;
  }
}

export const NOTE_PORTABLE =
  'This installation runs without an update service (portable ZIP or an older installation). New versions are shown but not installed automatically: please download the new package and install it as described in the README (Installation section).';
export const NOTE_DEV = 'WorldFoundry is running from source code. Please apply updates with git pull, npm install and npm run build.';

export interface ModeInfo {
  mode: InstallMode;
  note: string | null;
}

// service: installed by the Windows setup / install.sh, so a privileged updater exists (UPDATE_DIR is set by the
// service definition); dev: a checkout; portable: everything else
export function detectInstallMode(config: Pick<AppConfig, 'updateDir'>, codeRoot: string = CODE_ROOT, platform: NodeJS.Platform = process.platform): ModeInfo {
  if (isRepoLayout(codeRoot)) return { mode: 'dev', note: NOTE_DEV };
  if ((platform === 'win32' || platform === 'linux') && config.updateDir !== undefined) {
    try {
      if (statSync(requestDirOf(config.updateDir)).isDirectory()) return { mode: 'service', note: null };
    } catch {
      // the request folder is missing: the updater is not installed
    }
  }
  return { mode: 'portable', note: NOTE_PORTABLE };
}
