// Creates the configuration file and the credentials on first installation.
// Shipped with the package (tools/config.mjs) and used by setup-config.mjs, install.sh and the
// Windows installer; therefore only Node built-ins and pure functions.
import { randomBytes } from 'node:crypto';

// 24 random bytes give 32 characters from A-Z a-z 0-9 - _ (192 bits)
export function generateToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

// Values for files in .env format: single quotes, because Node (util.parseEnv)
// does not evaluate escape sequences in them, so backslashes on Windows are preserved.
export function quoteEnvValue(value) {
  if (/[\r\n']/.test(value)) throw new Error(`Invalid configuration value: ${JSON.stringify(value)}`);
  return `'${value}'`;
}

// Replace @NAME@ placeholders in the template text; unknown placeholders are an error
export function renderTemplate(template, values) {
  return template.replace(/@([A-Z_]+)@/g, (_match, key) => {
    if (!(key in values)) throw new Error(`Placeholder @${key}@ has no value.`);
    return values[key];
  });
}

export function configValues({ token, dataDir, serversDir, port, host }) {
  return {
    HOST: host,
    PORT: String(port),
    AUTH_TOKEN: quoteEnvValue(token),
    DATA_DIR: quoteEnvValue(dataDir),
    SERVERS_DIR: quoteEnvValue(serversDir),
  };
}

export function parsePort(text) {
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${text}`);
  return port;
}

export function webUrl(hostname, port) {
  return `http://${hostname}:${port}`;
}

export const DISCLAIMER = 'NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.';

// lanText: the addresses on the home network (installer/common/lan.mjs), multi-line; if missing, only the one address is shown
export function formatCredentials({ url, token, configFile, dataDir, serversDir, localUrl, notice, lanText }) {
  const lines = [
    'WorldFoundry - Credentials',
    '==================================',
    '',
    `Address:       ${url}`,
    ...(localUrl === undefined ? [] : [`On this PC:    ${localUrl}`]),
    ...(lanText === undefined || lanText === '' ? [] : ['', 'Addresses on the home network (from other devices):', ...lanText.split(/\r?\n/)]),
    `Access token:  ${token}`,
    '',
    'Use this token to sign in to the web interface. It is also the first password;',
    'you can set your own password there under "System". Forgot the password: see README.txt (reset-password).',
    `The token is also stored in the configuration file:`,
    `  ${configFile}`,
    `Data (database, backups, Java) is stored in:`,
    `  ${dataDir}`,
    ...(serversDir === undefined ? [] : [`Minecraft servers are stored in:`, `  ${serversDir}`]),
    '',
    ...(notice === undefined ? [] : [notice, '']),
    'This file contains a secret. It is readable by administrators only.',
    'After you have noted the token, you can delete it.',
    '',
    DISCLAIMER,
    '',
  ];
  return lines.join('\r\n');
}
