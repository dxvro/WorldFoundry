import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readZipFile, zipDirectory } from '../archive/zip-read.js';

export type JarLoader = 'fabric' | 'quilt' | 'forge' | 'neoforge' | 'paper';
export type ModSide = 'both' | 'server' | 'client' | 'unknown';

export interface JarMeta {
  // loaders whose metadata files the jar carries (multi-loader jars have several)
  loaders: JarLoader[];
  modId: string | null;
  // further mod ids when one jar holds several mods
  extraIds: string[];
  name: string | null;
  version: string | null;
  // raw version requirement for Minecraft as the jar states it, e.g. "~1.20.1" or "[1.20.1,1.21)"
  minecraft: string | null;
  side: ModSide;
  description: string | null;
}

const MAX_META_BYTES = 2 * 1024 * 1024;

// ---- tiny TOML subset (enough for mods.toml / neoforge.mods.toml) ---------------------------

interface TomlTable {
  name: string;
  values: Record<string, string>;
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote !== null) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function tomlValue(raw: string): string {
  const text = raw.trim();
  if (text.startsWith('"""') || text.startsWith("'''")) return text.slice(3).replace(/("""|''')\s*$/, '');
  if ((text.startsWith('"') && text.endsWith('"') && text.length >= 2) || (text.startsWith("'") && text.endsWith("'") && text.length >= 2)) {
    const inner = text.slice(1, -1);
    return text.startsWith('"') ? inner.replace(/\\(["\\])/g, '$1').replace(/\\n/g, '\n') : inner;
  }
  return text;
}

export function parseTomlTables(text: string): TomlTable[] {
  const tables: TomlTable[] = [{ name: '', values: {} }];
  let multiline: { key: string; close: string; parts: string[] } | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    if (multiline !== null) {
      const end = rawLine.indexOf(multiline.close);
      if (end === -1) multiline.parts.push(rawLine);
      else {
        multiline.parts.push(rawLine.slice(0, end));
        const table = tables[tables.length - 1];
        if (table !== undefined) table.values[multiline.key] = multiline.parts.join('\n').trim();
        multiline = null;
      }
      continue;
    }
    const line = stripComment(rawLine).trim();
    if (line === '') continue;
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (header?.[1] !== undefined) {
      tables.push({ name: header[1].replace(/\s+/g, ''), values: {} });
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, '');
    const value = line.slice(eq + 1).trim();
    const table = tables[tables.length - 1];
    if (table === undefined) continue;
    const open = value.startsWith("'''") ? "'''" : value.startsWith('"""') ? '"""' : null;
    if (open !== null && !value.slice(3).includes(open)) {
      multiline = { key, close: open, parts: [value.slice(3)] };
      continue;
    }
    table.values[key] = tomlValue(value);
  }
  return tables;
}

// ---- helpers --------------------------------------------------------------------------------

function parseJson(buffer: Buffer | null): unknown {
  if (buffer === null) return undefined;
  try {
    return JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

function manifestVersion(buffer: Buffer | null): string | null {
  if (buffer === null) return null;
  const match = /^Implementation-Version:\s*(.+?)\s*$/im.exec(buffer.toString('utf8'));
  return match?.[1] ?? null;
}

function rangeText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string').join(' || ') || null;
  return null;
}

function yamlValue(text: string, key: string): string | null {
  const match = new RegExp(`^${key}:\\s*['"]?(.+?)['"]?\\s*$`, 'im').exec(text);
  return match?.[1] ?? null;
}

const empty = (): JarMeta => ({ loaders: [], modId: null, extraIds: [], name: null, version: null, minecraft: null, side: 'unknown', description: null });

// Reads the metadata files of a mod or plugin jar. Returns an object without loaders when the jar has none
// of the known descriptors (a library, or not a mod at all).
export async function readJarMeta(jarPath: string): Promise<JarMeta> {
  const dir = await zipDirectory(jarPath);
  const read = (name: string): Promise<Buffer | null> => readZipFile(jarPath, dir, name, MAX_META_BYTES);
  const meta = empty();
  const setIf = <K extends keyof JarMeta>(key: K, value: JarMeta[K] | null): void => {
    if (value !== null && meta[key] === (empty()[key] as JarMeta[K])) meta[key] = value;
  };

  const fabric = parseJson(await read('fabric.mod.json'));
  if (isRecord(fabric)) {
    meta.loaders.push('fabric');
    setIf('modId', str(fabric['id']));
    setIf('name', str(fabric['name']));
    setIf('version', str(fabric['version']));
    setIf('description', str(fabric['description']));
    const depends = fabric['depends'];
    if (isRecord(depends)) setIf('minecraft', rangeText(depends['minecraft']));
    const env = str(fabric['environment']);
    if (env === 'client') meta.side = 'client';
    else if (env === 'server') meta.side = 'server';
    else if (env === '*') meta.side = 'both';
  }

  const quilt = parseJson(await read('quilt.mod.json'));
  if (isRecord(quilt) && isRecord(quilt['quilt_loader'])) {
    const loader = quilt['quilt_loader'];
    meta.loaders.push('quilt');
    setIf('modId', str(loader['id']));
    setIf('version', str(loader['version']));
    if (isRecord(loader['metadata'])) {
      setIf('name', str(loader['metadata']['name']));
      setIf('description', str(loader['metadata']['description']));
    }
    if (Array.isArray(loader['depends'])) {
      for (const dep of loader['depends']) if (isRecord(dep) && dep['id'] === 'minecraft') setIf('minecraft', rangeText(dep['versions']));
    }
    const env = isRecord(quilt['minecraft']) ? str(quilt['minecraft']['environment']) : null;
    if (meta.side === 'unknown') meta.side = env === 'client' ? 'client' : env === 'dedicated_server' ? 'server' : 'both';
  }

  for (const [file, loader] of [
    ['META-INF/neoforge.mods.toml', 'neoforge'],
    ['META-INF/mods.toml', 'forge'],
  ] as const) {
    const raw = await read(file);
    if (raw === null) continue;
    const tables = parseTomlTables(raw.toString('utf8'));
    const mods = tables.filter((table) => table.name === 'mods');
    if (mods.length === 0 && !tables.some((table) => table.values['modLoader'] !== undefined)) continue;
    meta.loaders.push(loader);
    const first = mods[0];
    if (first !== undefined) {
      setIf('modId', str(first.values['modId']));
      setIf('name', str(first.values['displayName']));
      setIf('version', str(first.values['version']));
      setIf('description', str(first.values['description']));
    }
    for (const extra of mods.slice(1)) {
      const id = str(extra.values['modId']);
      if (id !== null && id !== meta.modId && !meta.extraIds.includes(id)) meta.extraIds.push(id);
    }
    for (const table of tables) {
      if (!table.name.startsWith('dependencies.') || table.values['modId'] !== 'minecraft') continue;
      setIf('minecraft', str(table.values['versionRange']));
      const side = str(table.values['side'])?.toUpperCase();
      if (meta.side === 'unknown' && side !== undefined) meta.side = side === 'CLIENT' ? 'client' : side === 'SERVER' ? 'server' : 'both';
    }
  }

  const mcmod = parseJson(await read('mcmod.info'));
  const mcmodList = Array.isArray(mcmod) ? mcmod : isRecord(mcmod) && Array.isArray(mcmod['modList']) ? mcmod['modList'] : [];
  const firstInfo = mcmodList.find(isRecord);
  if (firstInfo !== undefined && !meta.loaders.includes('forge') && !meta.loaders.includes('neoforge')) {
    meta.loaders.push('forge');
    setIf('modId', str(firstInfo['modid']));
    setIf('name', str(firstInfo['name']));
    setIf('version', str(firstInfo['version']));
    setIf('minecraft', str(firstInfo['mcversion']));
    setIf('description', str(firstInfo['description']));
    for (const extra of mcmodList.filter(isRecord).slice(1)) {
      const id = str(extra['modid']);
      if (id !== null && id !== meta.modId && !meta.extraIds.includes(id)) meta.extraIds.push(id);
    }
  }

  for (const file of ['paper-plugin.yml', 'plugin.yml']) {
    const raw = await read(file);
    if (raw === null) continue;
    const text = raw.toString('utf8');
    const name = yamlValue(text, 'name');
    if (name === null) continue;
    meta.loaders.push('paper');
    setIf('modId', name);
    setIf('name', name);
    setIf('version', yamlValue(text, 'version'));
    setIf('minecraft', yamlValue(text, 'api-version'));
    setIf('description', yamlValue(text, 'description'));
    if (meta.side === 'unknown') meta.side = 'server';
    break;
  }

  if (meta.version !== null && /\$\{[^}]*\}/.test(meta.version)) {
    meta.version = manifestVersion(await read('META-INF/MANIFEST.MF'));
  }
  return meta;
}

export interface FileHashes {
  sha1: string;
  sha512: string;
  size: number;
}

export function hashFileBoth(file: string): Promise<FileHashes> {
  return new Promise((resolve, reject) => {
    const sha1 = createHash('sha1');
    const sha512 = createHash('sha512');
    let size = 0;
    const stream = createReadStream(file);
    stream.on('data', (chunk) => {
      size += chunk.length;
      sha1.update(chunk);
      sha512.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve({ sha1: sha1.digest('hex'), sha512: sha512.digest('hex'), size }));
  });
}
