// Creates the configuration file on first installation (with a random AUTH_TOKEN).
// If the file already exists, nothing happens: configuration and token are kept on updates.
//
//   node setup-config.mjs --config <Datei> --data-dir <Ordner> --servers-dir <Ordner>
//        [--port 3000] [--host 0.0.0.0] [--hostname <Name>] [--credentials-file <Datei>] [--print-token]
//
// Output (stdout, one line of JSON): {"created":true|false,"url":"http://<name>:<port>"[,"token":"..."]}
// The token only appears with --print-token (for install.sh), never in the installer log.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { configValues, formatCredentials, generateToken, parsePort, renderTemplate, webUrl } from './config.mjs';
import { detectAddresses, formatText } from './lan.mjs';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    'data-dir': { type: 'string' },
    'servers-dir': { type: 'string' },
    port: { type: 'string', default: '3000' },
    host: { type: 'string', default: '0.0.0.0' },
    hostname: { type: 'string' },
    'credentials-file': { type: 'string' },
    'print-token': { type: 'boolean', default: false },
  },
  strict: true,
});

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const configFile = values.config;
if (configFile === undefined) fail('--config is missing.');
const dataDir = values['data-dir'] ?? 'data';
const serversDir = values['servers-dir'] ?? 'servers';
const port = parsePort(values.port);
const hostname = values.hostname ?? os.hostname();
const url = webUrl(hostname, port);

if (existsSync(configFile)) {
  console.log(JSON.stringify({ created: false, url }));
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const template = readFileSync(path.join(here, 'worldfoundry.env.template'), 'utf8');
const token = generateToken();
const content = renderTemplate(template, configValues({ token, dataDir, serversDir, port, host: values.host }));

mkdirSync(path.dirname(configFile), { recursive: true });
// 'wx': never overwrite an existing file, not even on a concurrent call
writeFileSync(configFile, content, { encoding: 'utf8', mode: 0o640, flag: 'wx' });
if (process.platform !== 'win32') chmodSync(configFile, 0o640);

if (values['credentials-file'] !== undefined) {
  const credentials = formatCredentials({
    url,
    localUrl: webUrl('localhost', port),
    lanText: formatText(detectAddresses(), port, hostname),
    token,
    configFile,
    dataDir: path.resolve(dataDir),
    serversDir: path.resolve(serversDir),
  });
  mkdirSync(path.dirname(values['credentials-file']), { recursive: true });
  // UTF-8 with BOM so that older editors (Notepad) detect the encoding correctly
  writeFileSync(values['credentials-file'], `﻿${credentials}`, { encoding: 'utf8', mode: 0o600 });
}

console.log(JSON.stringify({ created: true, url, ...(values['print-token'] ? { token } : {}) }));
