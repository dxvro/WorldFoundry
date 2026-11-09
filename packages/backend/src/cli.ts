import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePassword, hashPassword, validateNewPassword } from './auth/password.js';
import { PasswordStore } from './auth/store.js';
import { ConfigError, loadConfig, loadDotEnv } from './config/env.js';
import { openDb } from './db/client.js';

// Local administration of an installed WorldFoundry. It works on the database file directly, so it needs the same
// rights as the application itself (root / the service account / an administrator) and never opens a network port:
// a forgotten password can only be reset by someone who controls the machine.
//
//   node cli.js reset-password [--password-stdin]

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  // the first line of standard input (for --password-stdin)
  readStdin: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
}

const USAGE = `WorldFoundry - administration on the server machine

  worldfoundry reset-password [--password-stdin]

    Resets the password of the web interface and signs out all existing sessions.
    Without an option, a random new password is generated and shown.
    --password-stdin   reads the new password from standard input (first line, at least 10 characters)

    The access token (AUTH_TOKEN) in the configuration file stays unchanged; it keeps working for scripts.
`;

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

async function resetPassword(args: string[], io: CliIo): Promise<number> {
  const unknown = args.filter((arg) => arg !== '--password-stdin' && arg !== '--stdin');
  if (unknown.length > 0) {
    io.err(`Unknown option: ${unknown[0]}\n\n${USAGE}`);
    return 2;
  }
  const fromStdin = args.length > 0;

  let password: string;
  if (fromStdin) {
    password = ((await io.readStdin()).split(/\r?\n/)[0] ?? '').replace(/\r$/, '');
    const problem = validateNewPassword(password);
    if (problem !== null) {
      io.err(`Error: ${problem}`);
      return 1;
    }
  } else {
    password = generatePassword();
  }

  const env = io.env ?? process.env;
  let dataDir: string;
  try {
    loadDotEnv(env);
    dataDir = loadConfig(env).dataDir;
  } catch (error) {
    io.err(error instanceof ConfigError ? error.message : `Error: The configuration could not be read (${error instanceof Error ? error.message : String(error)}).`);
    return 1;
  }
  const dbFile = path.join(dataDir, 'worldfoundry.db');
  if (!existsSync(dbFile)) {
    io.err(`Error: The database ${dbFile} does not exist. Has WorldFoundry been started before, and does CONFIG_FILE point to the right configuration?`);
    return 1;
  }

  const handle = await openDb(dbFile);
  try {
    const store = new PasswordStore(handle.db);
    try {
      await store.load();
    } catch {
      io.err('Error: The database has not been set up yet. Please start WorldFoundry once and then run the command again.');
      return 1;
    }
    await store.save(await hashPassword(password));
  } catch (error) {
    io.err(`Error: The password could not be saved (${error instanceof Error ? error.message : String(error)}). Are the permissions on ${dataDir} missing? Run as administrator or root.`);
    return 1;
  } finally {
    handle.close();
  }

  io.out('The web interface password has been reset. All existing sessions have been ended.');
  if (!fromStdin) {
    io.out('');
    io.out(`  New password: ${password}`);
    io.out('');
    io.out('After signing in, please set your own password under System > Password.');
  }
  io.out('The access token (AUTH_TOKEN) for scripts and the API is unchanged.');
  return 0;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'reset-password':
      return resetPassword(rest, io);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      io.out(USAGE);
      return 0;
    default:
      io.err(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli(process.argv.slice(2), {
    out: (text) => console.log(text),
    err: (text) => console.error(text),
    readStdin: readAllStdin,
  }).then(
    (code) => {
      // no process.exit: let the output drain first
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error('Error:', error);
      process.exitCode = 1;
    },
  );
}
