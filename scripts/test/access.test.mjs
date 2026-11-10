// Access on the home network, the "not an official product" notices and password reset in the installation packages
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DISCLAIMER, formatCredentials } from '../lib/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = async (...parts) => (await readFile(path.join(ROOT, ...parts), 'utf8')).replace(/\r\n/g, '\n');

test('Notice: the text appears everywhere people see it', async () => {
  assert.equal(DISCLAIMER, 'NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.');
  const places = [
    ['README.md'],
    ['TRADEMARKS.md'],
    ['installer', 'windows', 'worldfoundry.iss'],
    ['installer', 'windows', 'README.txt'],
    ['installer', 'windows', 'start-portable.cmd'],
    ['installer', 'linux', 'README.txt'],
    ['installer', 'linux', 'install.sh'],
    ['.github', 'workflows', 'release.yml'],
  ];
  for (const parts of places) assert.ok((await read(...parts)).includes(DISCLAIMER), parts.join('/'));
  // The interface carries a general disclaimer that names every rights holder; the sentence of each game comes from
  // the registry and must be in README.md and TRADEMARKS.md word for word (Minecraft in capitals, as its owner asks).
  const enCommon = await read('packages', 'frontend', 'src', 'i18n', 'locales', 'en', 'common.ts');
  for (const owner of ['Mojang', 'Microsoft', 'The Indie Stone', 'Coffee Stain', 'Studio Wildcard', 'Snail Games', 'Valve']) assert.ok(enCommon.includes(owner), `general disclaimer names ${owner}`);
  const registry = await read('packages', 'backend', 'src', 'games', 'registry.ts');
  const sentences = [...registry.matchAll(/disclaimer: notA\('([^']+)', '([^']+)'\)/g)].map((match) => `Not an official ${match[1]} product. Not approved by or associated with ${match[2]}.`);
  assert.equal(sentences.length, 4, 'one disclaimer per game in the registry');
  assert.ok(sentences[0].toUpperCase() === DISCLAIMER, 'the Minecraft sentence of the registry is the notice of the installers');
  for (const file of ['README.md', 'TRADEMARKS.md']) {
    const text = (await read(file)).toUpperCase();
    for (const sentence of sentences) assert.ok(text.includes(sentence.toUpperCase()), `${file}: ${sentence}`);
  }
  // Welcome and finish page of the installer carry the general notice and the Minecraft one
  const iss = await read('installer', 'windows', 'worldfoundry.iss');
  for (const key of ['WelcomeLabel2', 'FinishedLabel', 'FinishedLabelNoIcons', 'Disclaimer']) {
    assert.match(iss, new RegExp(`^english\\.${key}=.*not an official product of any game publisher.*NOT AN OFFICIAL MINECRAFT PRODUCT`, 'm'), key);
  }
});

test('Installer: English only, and every custom message the script uses exists', async () => {
  const iss = await read('installer', 'windows', 'worldfoundry.iss');
  const languages = [...iss.matchAll(/^Name: "(\w+)"; MessagesFile:/gm)].map((match) => match[1]);
  assert.deepEqual(languages, ['english']);
  assert.doesNotMatch(iss, /^german\./m);
  const custom = new Set([...iss.matchAll(/^english\.(\w+)=/gm)].map((match) => match[1]));
  for (const match of iss.matchAll(/(?:CustomMessage\('|\{cm:)(\w+)/g)) assert.ok(custom.has(match[1]), `custom message ${match[1]}`);
  // the firewall task opens the ports of every game, not only Minecraft
  assert.match(iss, /#define TcpPortRange "25565-25575,7777-7790,8888-8899"/);
  assert.match(iss, /#define UdpPortRange "7777-7790,16261-16280,27015-27030"/);
});

test('Credentials: home network addresses, password notice and the Minecraft notice', () => {
  const text = formatCredentials({
    url: 'http://pc:3000',
    token: 'SECRET',
    configFile: 'C:\\c.env',
    dataDir: 'C:\\d',
    lanText: '   http://192.168.178.20:3000\r\n   http://pc:3000   (host name)',
  });
  for (const part of ['Addresses on the home network', 'http://192.168.178.20:3000', 'also the first password', 'README.txt', DISCLAIMER]) assert.ok(text.includes(part), part);
});

test('File names: credentials.txt and README.txt', async () => {
  const iss = await read('installer', 'windows', 'worldfoundry.iss');
  assert.match(iss, /Result := DataDir \+ '\\credentials\.txt';/);
  // only administrators can read the credentials file
  assert.match(iss, /procedure SecureCredentialsFile;[\s\S]*?RunIcacls\('"' \+ CredentialsFile \+ '" \/inheritance:r/);
  assert.match(iss, /Excludes: "\\start-portable\.cmd,\\README\.txt"/);
  assert.match(iss, /\{#StartMenuFolder\}\\Reset Password\.lnk/, 'the shortcuts are removed on uninstall');
  const install = await read('installer', 'linux', 'install.sh');
  assert.match(install, /THIRD-PARTY-NOTICES\.txt README\.txt uninstall\.sh/);
  for (const unit of ['worldfoundry.service', 'worldfoundry-update.service', 'worldfoundry-update.path']) {
    assert.match(await read('installer', 'linux', unit), /^Documentation=file:\/\/\/opt\/worldfoundry\/README\.txt$/m, unit);
  }
  const packager = await read('scripts', 'package.mjs');
  assert.match(packager, /'README\.txt'/);
  // portable ZIP: data, servers and configuration live in "data" next to the scripts
  for (const script of ['start-portable.cmd', 'reset-password.cmd']) {
    const cmd = await read('installer', 'windows', script);
    assert.match(cmd, /set "DATAROOT=%~dp0data"/, script);
  }
  const portable = await read('installer', 'windows', 'start-portable.cmd');
  assert.match(portable, /--credentials-file "%DATAROOT%\\credentials\.txt"/);
  assert.doesNotMatch(portable, /daten|Zugangsdaten/);
});

test('Restart: exit code 75 in the application, the systemd unit and the portable start', async () => {
  assert.match(await read('packages', 'backend', 'src', 'system', 'restart.ts'), /RESTART_EXIT_CODE = 75;/);
  const unit = await read('installer', 'linux', 'worldfoundry.service');
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^RestartForceExitStatus=75$/m);
  assert.match(await read('installer', 'windows', 'start-portable.cmd'), /%errorlevel%==75/);
  assert.match(await read('installer', 'windows', 'worldfoundry-service.xml'), /<onfailure action="restart"/);
});

test('Password reset: Linux command and Windows Start menu', async () => {
  const wrapper = await read('installer', 'linux', 'worldfoundry');
  assert.match(wrapper, /^#!\/bin\/sh/);
  assert.match(wrapper, /runuser -u "\$SERVICE_USER"/);
  assert.match(wrapper, /dist\/cli\.js/);
  assert.match(wrapper, /id -u/);
  const check = spawnSync('sh', ['-n', path.join(ROOT, 'installer', 'linux', 'worldfoundry')], { encoding: 'utf8' });
  if (check.error === undefined) assert.equal(check.status, 0, check.stderr);
  const install = await read('installer', 'linux', 'install.sh');
  assert.match(install, /CLI_LINK=\/usr\/local\/bin\/worldfoundry/);
  assert.match(install, /tools\/lan\.mjs/);
  assert.match(await read('installer', 'linux', 'uninstall.sh'), /rm -f \/usr\/local\/bin\/worldfoundry/);

  const cmdRaw = await readFile(path.join(ROOT, 'installer', 'windows', 'reset-password.cmd'), 'utf8');
  assert.ok(!/[^\r]\n/.test(cmdRaw), 'batch file with CRLF');
  assert.match(cmdRaw, /cli\.js" reset-password/);
  assert.match(cmdRaw, /-Verb RunAs/);
  assert.ok(!/[^\x00-\x7f]/.test(cmdRaw), 'ASCII only');
  const portableRaw = await readFile(path.join(ROOT, 'installer', 'windows', 'start-portable.cmd'), 'utf8');
  assert.ok(!/[^\r]\n/.test(portableRaw), 'batch file with CRLF');
  assert.ok(!/[^\x00-\x7f]/.test(portableRaw), 'ASCII only');
  const iss = await read('installer', 'windows', 'worldfoundry.iss');
  assert.match(iss, /Name: "\{group\}\\\{cm:IconResetPassword\}"; Filename: "\{app\}\\reset-password\.cmd"/);
  assert.match(iss, /function LanAddressText/);
  const packager = await read('scripts', 'package.mjs');
  assert.match(packager, /lan\.mjs/);
  assert.match(packager, /reset-password\.cmd/);
  assert.match(packager, /'worldfoundry', 'worldfoundry\.service'/);
});
