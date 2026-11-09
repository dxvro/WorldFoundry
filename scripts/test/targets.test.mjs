import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foreignLibsqlPackages, getTarget, hostTargetName, nodeArchiveName, parseArgs, releaseBaseName, TARGET_NAMES } from '../lib/targets.mjs';

test('Target system: all three targets are defined', () => {
  assert.deepEqual(TARGET_NAMES, ['win-x64', 'linux-x64', 'linux-arm64']);
  assert.equal(getTarget('win-x64').nodeBinaryName, 'node.exe');
  assert.equal(getTarget('linux-arm64').libsql, '@libsql/linux-arm64-gnu');
  assert.equal(getTarget('linux-x64').archiveKind, 'tar.gz');
  assert.equal(getTarget('win-x64').archiveKind, 'zip');
});

test('Target system: an unknown target is rejected with a message', () => {
  assert.throws(() => getTarget('macos-arm64'), /Unknown target/);
});

test('Target system: the build machine is recognised', () => {
  assert.equal(hostTargetName('win32', 'x64'), 'win-x64');
  assert.equal(hostTargetName('linux', 'arm64'), 'linux-arm64');
  assert.equal(hostTargetName('darwin', 'arm64'), null);
});

test('File names: Node archive and package name', () => {
  assert.equal(nodeArchiveName('v26.13.0', getTarget('win-x64')), 'node-v26.13.0-win-x64.zip');
  assert.equal(nodeArchiveName('v26.13.0', getTarget('linux-arm64')), 'node-v26.13.0-linux-arm64.tar.gz');
  assert.equal(releaseBaseName('0.1.0', getTarget('linux-x64')), 'worldfoundry-0.1.0-linux-x64');
});

test('libsql: foreign platform packages are recognised, the own one stays', () => {
  const installed = ['@libsql/client', '@libsql/core', '@libsql/linux-x64-gnu', '@libsql/linux-x64-musl', '@libsql/win32-x64-msvc', '@libsql/darwin-arm64'];
  assert.deepEqual(foreignLibsqlPackages(installed, getTarget('linux-x64')), ['@libsql/linux-x64-musl', '@libsql/win32-x64-msvc', '@libsql/darwin-arm64']);
  assert.deepEqual(foreignLibsqlPackages(installed, getTarget('win-x64')), ['@libsql/linux-x64-gnu', '@libsql/linux-x64-musl', '@libsql/darwin-arm64']);
});

test('Arguments: valid calls', () => {
  assert.equal(parseArgs(['--target', 'win-x64']).target, 'win-x64');
  assert.equal(parseArgs(['--target=linux-x64', '--skip-build', '--no-archive']).skipBuild, true);
  assert.equal(parseArgs(['--target', 'linux-x64', '--node-version', 'v24.1.0']).nodeVersion, 'v24.1.0');
  assert.equal(parseArgs(['--help']).help, true);
});

test('Arguments: errors', () => {
  assert.throws(() => parseArgs([]), /specify --target/);
  assert.throws(() => parseArgs(['--target']), /needs a value/);
  assert.throws(() => parseArgs(['--target', 'bsd-x64']), /Unknown target/);
  assert.throws(() => parseArgs(['--target', 'win-x64', '--bogus']), /Unknown option/);
  assert.throws(() => parseArgs(['--target', 'win-x64', '--node-version', '26']), /v22\.11\.0/);
});
