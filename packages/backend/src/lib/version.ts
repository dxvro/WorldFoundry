import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// packages/backend/package.json is one level above both src/ and dist/
export function readVersion(): string {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
  return z.object({ version: z.string() }).parse(JSON.parse(readFileSync(file, 'utf8'))).version;
}
