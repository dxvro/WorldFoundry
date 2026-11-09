import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/http/errors.js';
import { JavaDetector, collectCandidates, defaultStandardRoots, probeJava } from '../src/java/detect.js';
import { parseJavaVersion } from '../src/java/parse.js';
import { chooseRuntime, javaRequirement, type JavaRuntime } from '../src/java/select.js';
import { JavaService } from '../src/java/service.js';
import { JAVA_OUTPUT, scratchDir } from './server-env.js';

describe('parseJavaVersion', () => {
  it.each([
    ['openjdk version "21.0.1" 2023-10-17 LTS', 21, '21.0.1'],
    ['java version "1.8.0_392"', 8, '1.8.0_392'],
    ['openjdk version "1.8.0_402"', 8, '1.8.0_402'],
    ['openjdk version "17" 2021-09-14', 17, '17'],
    ['openjdk version "25-ea" 2025-09-16', 25, '25-ea'],
    ['java version "1.7.0_80"', 7, '1.7.0_80'],
    ['openjdk version "11.0.21" 2023-10-17', 11, '11.0.21'],
    ['openjdk version "9.0.4"', 9, '9.0.4'],
  ])('parses %s', (line, major, version) => {
    const parsed = parseJavaVersion(`${line}\nOpenJDK Runtime Environment Temurin-x (build y)\nOpenJDK 64-Bit Server VM (build z, mixed mode)\n`);
    expect(parsed).toMatchObject({ major, version });
    expect(parsed?.name).toContain('Runtime Environment');
  });

  it('handles CRLF, leading noise (JAVA_TOOL_OPTIONS) and rejects garbage', () => {
    expect(parseJavaVersion('Picked up JAVA_TOOL_OPTIONS: -Xmx1g\r\nopenjdk version "21.0.1" 2023\r\n')?.major).toBe(21);
    expect(parseJavaVersion('')).toBeNull();
    expect(parseJavaVersion('command not found')).toBeNull();
    expect(parseJavaVersion('version "abc"')).toBeNull();
  });
});

describe('requirements and selection', () => {
  const rt = (major: number, name = `j${major}`): JavaRuntime => ({ path: `/${name}/bin/java`, major, version: String(major), name, source: 'PATH', origin: null });

  it('limits Forge up to 1.12.2 to Java 8 and warns for 1.13-1.16.5', () => {
    expect(javaRequirement('forge', '1.12.2', 8)).toEqual({ min: 8, max: 8, note: null });
    expect(javaRequirement('forge', '1.7.10', 8)).toMatchObject({ max: 8 });
    expect(javaRequirement('forge', '1.16.5', 8)).toMatchObject({ min: 8, max: null });
    expect(javaRequirement('forge', '1.16.5', 8).note?.text).toContain('Java 8');
    expect(javaRequirement('forge', '1.20.1', 17)).toEqual({ min: 17, max: null, note: null });
    expect(javaRequirement('forge', '26.1', 25)).toEqual({ min: 25, max: null, note: null });
    expect(javaRequirement('fabric', '1.12.2', 8)).toEqual({ min: 8, max: null, note: null });
    expect(javaRequirement('neoforge', '1.21.1', null)).toMatchObject({ min: 8 });
  });

  it('picks the lowest suitable major', () => {
    const all = [rt(21), rt(8), rt(17), rt(25)];
    expect(chooseRuntime(all, { min: 17, max: null, note: null })?.major).toBe(17);
    expect(chooseRuntime(all, { min: 8, max: null, note: null })?.major).toBe(8);
    expect(chooseRuntime(all, { min: 21, max: null, note: null })?.major).toBe(21);
    expect(chooseRuntime(all, { min: 8, max: 8, note: null })?.major).toBe(8);
    expect(chooseRuntime([rt(21), rt(17)], { min: 8, max: 8, note: null })).toBeNull();
    expect(chooseRuntime([rt(17)], { min: 21, max: null, note: null })).toBeNull();
  });
});

function service(versions: Record<string, string>, calls: string[] = []): { java: JavaService; detector: JavaDetector } {
  const detector = new JavaDetector({
    env: {},
    standardRoots: [],
    probe: async (javaPath) => {
      calls.push(javaPath);
      const version = versions[javaPath];
      return version === undefined ? null : JAVA_OUTPUT(version);
    },
  });
  return { java: new JavaService(detector), detector };
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected a failure');
}

describe('JavaService', () => {
  const needs = { loader: 'vanilla' as const, mcVersion: '1.21.1', requiredMajor: 21, javaPath: null };

  it('validates user-supplied paths by basename and by running -version', async () => {
    const { java } = service({ '/opt/jdk21/bin/java': '21.0.1', 'C:\\Java\\bin\\JAVA.EXE': '17.0.9', '/opt/x/bin/javaw': '21.0.1' });
    expect((await java.validatePath('/opt/jdk21/bin/java')).major).toBe(21);
    expect((await java.validatePath('C:\\Java\\bin\\JAVA.EXE')).major).toBe(17);
    for (const bad of ['/opt/x/bin/javaw', '/bin/sh', 'C:\\Windows\\notepad.exe', 'C:\\Java\\bin\\javaw.exe', 'C:\\Java\\bin\\', '', '   ', '/opt/jdk21/bin/']) {
      const error = await failure(java.validatePath(bad));
      expect(error, bad).toMatchObject({ statusCode: 422, code: 'JAVA_INVALID' });
    }
    // right name, but it does not behave like java
    expect(await failure(java.validatePath('/opt/fake/bin/java'))).toMatchObject({ code: 'JAVA_INVALID' });
  });

  it('answers JAVA_NOT_FOUND without any runtime, with required and found in details', async () => {
    const { java } = service({});
    const error = await failure(java.select(needs));
    expect(error).toMatchObject({ statusCode: 422, code: 'JAVA_NOT_FOUND', details: { required: 21, found: [] } });
    expect(error.message).toContain('Java 21');
  });

  it('answers JAVA_VERSION_INCOMPATIBLE naming required and found versions', async () => {
    // detection is injected through the detector's scan, so give it candidates via PATH
    const dir = await scratchDir('jv-');
    const bin = path.join(dir, 'jdk8', 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, 'java'), '');
    const detector = new JavaDetector({ env: { PATH: bin }, platform: 'linux', standardRoots: [], probe: async () => JAVA_OUTPUT('1.8.0_392') });
    const java = new JavaService(detector);
    const error = await failure(java.select(needs));
    expect(error).toMatchObject({ statusCode: 422, code: 'JAVA_VERSION_INCOMPATIBLE', details: { required: 21, requiredMax: null, found: [8] } });
    expect(error.message).toContain('21');
    expect(error.message).toContain('8');
    const ok = await java.select({ ...needs, requiredMajor: 8 });
    expect(ok.runtime.major).toBe(8);
  });

  it('refuses Java 21 for Forge 1.12.2 and explains the exact range', async () => {
    const dir = await scratchDir('jv-');
    const bin = path.join(dir, 'jdk21', 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, 'java'), '');
    const java = new JavaService(new JavaDetector({ env: { PATH: bin }, platform: 'linux', standardRoots: [], probe: async () => JAVA_OUTPUT('21.0.1') }));
    const error = await failure(java.select({ loader: 'forge', mcVersion: '1.12.2', requiredMajor: 8, javaPath: null }));
    expect(error).toMatchObject({ code: 'JAVA_VERSION_INCOMPATIBLE', details: { required: 8, requiredMax: 8, found: [21] } });
    expect(error.message).toContain('Java 8,');
  });

  it('checks an explicit path against the requirement and reports missing files as JAVA_NOT_FOUND', async () => {
    const { java } = service({ '/j/21/java': '21.0.1', '/j/8/java': '1.8.0_1' });
    expect((await java.select({ ...needs, javaPath: '/j/21/java' })).runtime.major).toBe(21);
    expect(await failure(java.select({ ...needs, javaPath: '/j/8/java' }))).toMatchObject({
      code: 'JAVA_VERSION_INCOMPATIBLE',
      details: { required: 21, found: [8] },
    });
    expect(await failure(java.select({ ...needs, javaPath: '/gone/java' }))).toMatchObject({ code: 'JAVA_NOT_FOUND' });
  });
});

describe('JavaDetector', () => {
  it('finds JAVA_HOME, PATH and vendor directories, deduplicates and sorts', async () => {
    const root = await scratchDir('jd-');
    const make = async (...parts: string[]): Promise<string> => {
      const bin = path.join(root, ...parts, 'bin');
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(bin, 'java.exe'), '');
      return path.join(bin, 'java.exe');
    };
    const adoptium = await make('pf', 'Eclipse Adoptium', 'jdk-21.0.1.12-hotspot');
    const oracle = await make('pf', 'Java', 'jre1.8.0_392');
    const ms = await make('pf', 'Microsoft', 'jdk-17.0.9');
    await make('pf', 'Zulu', 'zulu-11');
    await make('pf', 'Amazon Corretto', 'jdk25');
    await make('pf', 'Semeru', 'jdk-17');
    await make('pf', 'BellSoft', 'jdk-21');
    const home = await make('custom', 'jdk-22');
    const versionOf = (file: string): string => {
      if (file.includes('jre1.8')) return '1.8.0_392';
      const match = /jdk-?(\d+)|zulu-(\d+)/.exec(file);
      return `${match?.[1] ?? match?.[2] ?? '21'}.0.1`;
    };
    const probed: string[] = [];
    const detector = new JavaDetector({
      env: { JAVA_HOME: path.dirname(path.dirname(home)), PATH: [path.dirname(adoptium), path.join(root, 'empty')].join(path.delimiter), ProgramFiles: path.join(root, 'pf') },
      platform: 'win32',
      probe: async (file) => {
        probed.push(file);
        return file === path.join(root, 'pf', 'Semeru', 'jdk-17', 'bin', 'java.exe') ? null : JAVA_OUTPUT(versionOf(file));
      },
    });
    const runtimes = await detector.detect();
    expect(runtimes.map((r) => r.major)).toEqual([8, 11, 17, 21, 21, 22, 25]);
    expect(runtimes.find((r) => r.path === adoptium)).toBeDefined();
    expect(runtimes.find((r) => r.path === oracle)?.source).toBe('standard');
    expect(runtimes.find((r) => r.path === ms)).toBeDefined();
    expect(runtimes.find((r) => r.path === home)?.source).toBe('JAVA_HOME');
    // the PATH entry that equals an adoptium install is probed once only
    expect(probed.filter((p) => p === adoptium)).toHaveLength(1);
  });

  it('caches for a short time and rescans on demand', async () => {
    const root = await scratchDir('jc-');
    const bin = path.join(root, 'jdk', 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, 'java'), '');
    let now = 0;
    let probes = 0;
    const detector = new JavaDetector({
      env: { PATH: bin },
      platform: 'linux',
      standardRoots: [],
      cacheTtlMs: 1000,
      now: () => now,
      probe: async () => (probes++, JAVA_OUTPUT('21.0.1')),
    });
    await detector.detect();
    await detector.detect();
    expect(probes).toBe(1);
    await detector.detect(true);
    expect(probes).toBe(2);
    now = 5000;
    await detector.detect();
    expect(probes).toBe(3);
    await Promise.all([detector.detect(true), detector.detect(true)]);
    expect(probes).toBe(4);
  });

  it('collects the standard candidates per platform without throwing for missing directories', async () => {
    const own = async (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => (await collectCandidates(env, platform, [])).filter((c) => c.source !== 'standard');
    expect(await own({}, 'linux')).toEqual([]);
    const withHome = await own({ JAVA_HOME: '/opt/j', PATH: ['/usr/bin', '/bin'].join(path.delimiter) }, 'linux');
    expect(withHome.map((c) => c.source)).toEqual(['JAVA_HOME', 'PATH', 'PATH']);
    expect(withHome[0]?.path).toBe(path.join('/opt/j', 'bin', 'java'));
    expect(await own({}, 'darwin')).toEqual([]);
  });

  it('scans exactly the given standard roots: a JDK below one is found, none is found without roots', async () => {
    const root = await scratchDir('sr-');
    const bin = path.join(root, 'jvm', 'temurin-21', 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, 'java'), '');
    const options = { env: {}, platform: 'linux' as const, probe: async () => JAVA_OUTPUT('21.0.1') };
    const withRoot = await new JavaDetector({ ...options, standardRoots: [path.join(root, 'jvm')] }).detect();
    expect(withRoot.map((r) => [r.major, r.source, r.path])).toEqual([[21, 'standard', path.join(bin, 'java')]]);
    expect(await new JavaDetector({ ...options, standardRoots: [] }).detect()).toEqual([]);
    expect(await new JavaDetector({ ...options, standardRoots: [path.join(root, 'does-not-exist')] }).detect()).toEqual([]);
    expect(defaultStandardRoots({}, 'linux')).toEqual(['/usr/lib/jvm']);
    expect(defaultStandardRoots({}, 'darwin')).toEqual(['/Library/Java/JavaVirtualMachines']);
    expect(defaultStandardRoots({ ProgramFiles: '/pf' }, 'win32')).toContain(path.join('/pf', 'Java'));
  });

  it('runs the real probe and survives a missing binary', async () => {
    expect(await probeJava(path.join(await scratchDir('nj-'), 'java.exe'))).toBeNull();
    const node = await probeJava(process.execPath);
    expect(node === null || typeof node === 'string').toBe(true);
  });
});
