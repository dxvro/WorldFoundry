import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renameWithRetry } from '../lib/fs-retry.js';
import { removeQuietly } from '../mods/files.js';
import { rethrowFsError } from '../mods/fs-errors.js';
import { decodeProperties, PropertiesDocument } from './parser.js';

export const PROPERTIES_FILE = 'server.properties';

export interface LoadedProperties {
  doc: PropertiesDocument;
  exists: boolean;
}

export async function loadProperties(serverDir: string): Promise<LoadedProperties> {
  try {
    const { text, encoding } = decodeProperties(await readFile(path.join(serverDir, PROPERTIES_FILE)));
    return { doc: PropertiesDocument.parse(text, encoding), exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { doc: PropertiesDocument.empty(), exists: false };
    rethrowFsError(error, PROPERTIES_FILE);
  }
}

export async function saveProperties(serverDir: string, doc: PropertiesDocument): Promise<void> {
  await mkdir(serverDir, { recursive: true });
  const target = path.join(serverDir, PROPERTIES_FILE);
  const temp = path.join(serverDir, `${PROPERTIES_FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, Buffer.from(doc.serialize(), doc.encoding));
    await renameWithRetry(temp, target);
  } catch (error) {
    await removeQuietly(temp);
    rethrowFsError(error, PROPERTIES_FILE);
  }
}
