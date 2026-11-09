// Target platforms of the package and argument handling (pure logic, no side effects).

export const TARGETS = {
  'win-x64': {
    name: 'win-x64',
    platform: 'win32',
    arch: 'x64',
    nodeDist: 'win-x64',
    nodeArchiveExt: 'zip',
    nodeBinaryName: 'node.exe',
    // Package with the native libsql library for this platform
    libsql: '@libsql/win32-x64-msvc',
    archiveKind: 'zip',
    machine: { format: 'pe', value: 0x8664 },
  },
  'linux-x64': {
    name: 'linux-x64',
    platform: 'linux',
    arch: 'x64',
    nodeDist: 'linux-x64',
    nodeArchiveExt: 'tar.gz',
    nodeBinaryName: 'node',
    libsql: '@libsql/linux-x64-gnu',
    archiveKind: 'tar.gz',
    machine: { format: 'elf', value: 0x3e },
  },
  'linux-arm64': {
    name: 'linux-arm64',
    platform: 'linux',
    arch: 'arm64',
    nodeDist: 'linux-arm64',
    nodeArchiveExt: 'tar.gz',
    nodeBinaryName: 'node',
    libsql: '@libsql/linux-arm64-gnu',
    archiveKind: 'tar.gz',
    machine: { format: 'elf', value: 0xb7 },
  },
};

export const TARGET_NAMES = Object.keys(TARGETS);

export function getTarget(name) {
  const target = TARGETS[name];
  if (target === undefined) {
    throw new Error(`Unknown target "${name}". Allowed: ${TARGET_NAMES.join(', ')}.`);
  }
  return target;
}

// All @libsql platform packages that are not needed for a different target
export function foreignLibsqlPackages(installed, target) {
  return installed.filter((name) => /^@libsql\/(darwin|linux|win32)-/.test(name) && name !== target.libsql);
}

export function hostTargetName(platform = process.platform, arch = process.arch) {
  return TARGET_NAMES.find((name) => TARGETS[name].platform === platform && TARGETS[name].arch === arch) ?? null;
}

export function nodeArchiveName(version, target) {
  return `node-${version}-${target.nodeDist}.${target.nodeArchiveExt}`;
}

export function releaseBaseName(version, target) {
  return `worldfoundry-${version}-${target.name}`;
}

export function parseArgs(argv) {
  const options = { target: null, skipBuild: false, skipSmoke: false, noArchive: false, nodeVersion: null, help: false, outDir: null, versionOverride: null, testUpdateApi: null, testUpdateKey: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value.`);
      i += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--skip-build') options.skipBuild = true;
    else if (arg === '--skip-smoke') options.skipSmoke = true;
    else if (arg === '--no-archive') options.noArchive = true;
    else if (arg === '--target') options.target = takeValue();
    else if (arg.startsWith('--target=')) options.target = arg.slice('--target='.length);
    else if (arg === '--node-version') options.nodeVersion = takeValue();
    else if (arg.startsWith('--node-version=')) options.nodeVersion = arg.slice('--node-version='.length);
    else if (arg === '--out') options.outDir = takeValue();
    else if (arg === '--version-override') options.versionOverride = takeValue();
    else if (arg === '--test-update-api') options.testUpdateApi = takeValue();
    else if (arg === '--test-update-key') options.testUpdateKey = takeValue();
    else throw new Error(`Unknown option "${arg}". Use --help for help.`);
  }
  if (!options.help) {
    if (options.target === null) throw new Error(`Please specify --target (${TARGET_NAMES.join('|')}).`);
    getTarget(options.target);
  }
  if (options.nodeVersion !== null && !/^v\d+\.\d+\.\d+$/.test(options.nodeVersion)) {
    throw new Error('--node-version must have the form v22.11.0.');
  }
  if (options.versionOverride !== null && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.versionOverride)) {
    throw new Error('--version-override must be a version like 0.1.1.');
  }
  if ((options.testUpdateApi === null) !== (options.testUpdateKey === null)) {
    throw new Error('--test-update-api and --test-update-key belong together (only for the update test in CI).');
  }
  return options;
}
