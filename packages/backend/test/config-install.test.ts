import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODE_ROOT,
  ConfigError,
  REPO_ROOT,
  defaultFrontendDir,
  defaultHome,
  isRepoLayout,
  loadConfig,
  loadDotEnv,
  resolveConfigFile,
} from '../src/config/env.js';
import { MIGRATIONS_FOLDER } from '../src/db/migrate.js';
import { scratchDir } from './server-env.js';

let dir: string;
beforeEach(async () => {
  dir = await scratchDir('config-');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// an installed copy: <app>/backend (code) and <app>/frontend/dist, nowhere near a repository
const installedCodeRoot = (): string => path.join(dir, 'app', 'backend');

describe('layout detection', () => {
  it('knows the checkout it runs from', () => {
    expect(isRepoLayout()).toBe(true);
    expect(CODE_ROOT).toBe(path.join(REPO_ROOT, 'packages', 'backend'));
    expect(isRepoLayout(installedCodeRoot())).toBe(false);
  });

  it('uses per-user folders when the code does not sit in a checkout', () => {
    const code = installedCodeRoot();
    expect(defaultHome({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'win32', code)).toBe(path.join('C:\\Users\\x\\AppData\\Local', 'WorldFoundry'));
    expect(defaultHome({ XDG_DATA_HOME: '/home/x/.data' }, 'linux', code)).toBe(path.join('/home/x/.data', 'worldfoundry'));
    expect(defaultHome({}, 'linux', code)).toBe(path.join(os.homedir(), '.local', 'share', 'worldfoundry'));
    expect(defaultHome({}, 'darwin', code)).toBe(path.join(os.homedir(), 'Library', 'Application Support', 'WorldFoundry'));
    expect(defaultHome({}, 'linux')).toBe(REPO_ROOT);
  });
});

describe('paths without a repository', () => {
  it('derives every default from the installed code and the user folder', () => {
    const code = installedCodeRoot();
    const config = loadConfig({ LOCALAPPDATA: path.join(dir, 'local') }, { codeRoot: code, platform: 'win32' });
    expect(config.dataDir).toBe(path.join(dir, 'local', 'WorldFoundry', 'data'));
    expect(config.serversDir).toBe(path.join(dir, 'local', 'WorldFoundry', 'servers'));
    expect(config.frontendDir).toBe(path.join(dir, 'app', 'frontend', 'dist'));
    expect(config.frontendDir).toBe(defaultFrontendDir(code));
    expect(config.configFile).toBeUndefined();
  });

  it('keeps the repository defaults when run from a checkout', () => {
    const config = loadConfig({});
    expect(config.dataDir).toBe(path.join(REPO_ROOT, 'data'));
    expect(config.serversDir).toBe(path.join(REPO_ROOT, 'servers'));
    expect(config.frontendDir).toBe(path.join(REPO_ROOT, 'packages', 'frontend', 'dist'));
  });

  it('lets DATA_DIR, SERVERS_DIR and FRONTEND_DIR point anywhere', () => {
    const config = loadConfig({ DATA_DIR: path.join(dir, 'd'), SERVERS_DIR: path.join(dir, 's'), FRONTEND_DIR: path.join(dir, 'f') }, { codeRoot: installedCodeRoot() });
    expect(config).toMatchObject({ dataDir: path.join(dir, 'd'), serversDir: path.join(dir, 's'), frontendDir: path.join(dir, 'f') });
  });

  it('resolves relative paths against the env file when CONFIG_FILE names one', () => {
    const file = path.join(dir, 'etc', 'craft.env');
    const config = loadConfig({ CONFIG_FILE: file, DATA_DIR: 'data', SERVERS_DIR: '../server-folder', FRONTEND_DIR: 'web' });
    expect(config.configFile).toBe(file);
    expect(config.dataDir).toBe(path.join(dir, 'etc', 'data'));
    expect(config.serversDir).toBe(path.join(dir, 'server-folder'));
    expect(config.frontendDir).toBe(path.join(dir, 'etc', 'web'));
  });

  it('finds the migrations next to the code, whatever the working directory is', () => {
    expect(MIGRATIONS_FOLDER).toBe(path.join(CODE_ROOT, 'drizzle'));
    const before = process.cwd();
    process.chdir(dir);
    try {
      expect(loadConfig({}).dataDir).toBe(path.join(REPO_ROOT, 'data'));
      expect(MIGRATIONS_FOLDER).toBe(path.join(CODE_ROOT, 'drizzle'));
    } finally {
      process.chdir(before);
    }
  });
});

describe('the env file', () => {
  it('uses CONFIG_FILE from the real environment and the default name otherwise', () => {
    const file = path.join(dir, 'x.env');
    expect(resolveConfigFile({ CONFIG_FILE: file })).toEqual({ file, explicit: true });
    expect(resolveConfigFile({})).toEqual({ file: path.join(REPO_ROOT, '.env'), explicit: false });
    expect(resolveConfigFile({ CONFIG_FILE: '  ' }).explicit).toBe(false);
  });

  it('reads values without overriding what the environment already sets', async () => {
    const file = path.join(dir, 'craft.env');
    await writeFile(file, '# Comment\nPORT=4100\nDATA_DIR="with spaces"\nJAVA_AUTO_INSTALL=false\nLOG_LEVEL=debug\nCONFIG_FILE=/evil\n');
    const target: NodeJS.ProcessEnv = { CONFIG_FILE: file, LOG_LEVEL: 'warn' };
    expect(loadDotEnv(target)).toBe(file);
    expect(target['PORT']).toBe('4100');
    expect(target['DATA_DIR']).toBe('with spaces');
    expect(target['LOG_LEVEL']).toBe('warn');
    expect(target['CONFIG_FILE']).toBe(file);
    const config = loadConfig(target);
    expect(config).toMatchObject({ port: 4100, javaAutoInstall: false, logLevel: 'warn' });
    expect(config.dataDir).toBe(path.join(dir, 'with spaces'));
  });

  it('runs without any env file, but refuses a CONFIG_FILE that does not exist', () => {
    expect(loadDotEnv({})).toBeNull();
    expect(() => loadDotEnv({ CONFIG_FILE: path.join(dir, 'does-not-exist.env') })).toThrowError(ConfigError);
    expect(() => loadDotEnv({ CONFIG_FILE: path.join(dir, 'does-not-exist.env') })).toThrow(/CONFIG_FILE/);
  });

  it('reports an unreadable env file as a configuration error', async () => {
    const folder = path.join(dir, 'folder.env');
    await mkdir(folder);
    expect(() => loadDotEnv({ CONFIG_FILE: folder })).toThrowError(ConfigError);
  });
});

describe('JAVA_AUTO_INSTALL and MOD_BACKUP_KEEP', () => {
  it('defaults to automatic installation and three mod backups', () => {
    expect(loadConfig({})).toMatchObject({ javaAutoInstall: true, modBackupKeep: 3 });
    expect(loadConfig({ JAVA_AUTO_INSTALL: '' })).toMatchObject({ javaAutoInstall: true });
  });

  it.each([
    ['false', false],
    ['0', false],
    ['no', false],
    ['nein', false],
    ['OFF', false],
    ['true', true],
    ['1', true],
    ['Ja', true],
  ])('reads JAVA_AUTO_INSTALL=%s', (raw, expected) => {
    expect(loadConfig({ JAVA_AUTO_INSTALL: raw }).javaAutoInstall).toBe(expected);
  });

  it('rejects other values and out-of-range backup counts with a readable message', () => {
    expect(() => loadConfig({ JAVA_AUTO_INSTALL: 'maybe' })).toThrow(/JAVA_AUTO_INSTALL: must be true or false/);
    expect(() => loadConfig({ MOD_BACKUP_KEEP: '0' })).toThrow(/MOD_BACKUP_KEEP/);
    expect(() => loadConfig({ MOD_BACKUP_KEEP: '101' })).toThrow(/MOD_BACKUP_KEEP/);
    expect(loadConfig({ MOD_BACKUP_KEEP: '10' }).modBackupKeep).toBe(10);
  });
});
