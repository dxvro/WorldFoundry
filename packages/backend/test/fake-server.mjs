// Stand-in for a Minecraft server, started with `node fake-server.mjs <java args...>` by the fake spawner.
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const mode = process.env.FAKE_MODE ?? 'normal';
const format = process.env.FAKE_FORMAT ?? 'vanilla';
const startDelay = Number(process.env.FAKE_START_DELAY ?? 30);
const marker = process.env.FAKE_MARKER ?? '';
// how the fake answers save-off / save-all flush / save-on: ok, old (1.12 wording), no-off, flush-fail, flush-silent,
// flush-slow, no-on, no-flush-arg (like servers that know no "flush")
const saveMode = process.env.FAKE_SAVE ?? 'ok';
let saving = true;

writeFileSync('fake-args.json', JSON.stringify({ args: process.argv.slice(2), pid: process.pid, marker }));

const note = (text) => {
  if (process.env.FAKE_EVENTS_FILE) appendFileSync(process.env.FAKE_EVENTS_FILE, `${new Date().toISOString()} ${text}\n`);
};
note(`started pid ${process.pid} mode ${mode}`);
process.on('exit', (code) => note(`exit ${code}`));

const log = (message, level = 'INFO') =>
  format === 'ansi'
    ? `\x1b[0;37m[12:00:00 \x1b[32m${level}\x1b[0;37m]\x1b[m: ${message}\x1b[m`
    : format === 'paper'
      ? `[12:00:00 ${level}]: ${message}`
      : format === 'forge'
        ? `[12:00:00] [Server thread/${level}] [net.minecraft.server.dedicated.DedicatedServer/]: ${message}`
        : `[12:00:00] [Server thread/${level}]: ${message}`;
const out = (message, level) => process.stdout.write(`${log(message, level)}\n`);

out('Starting minecraft server version 1.21.1');

if (mode === 'crash-early') {
  setTimeout(() => {
    out('Failed to start the server', 'ERROR');
    process.exit(3);
  }, startDelay);
} else if (mode !== 'silent') {
  setTimeout(() => {
    out('Done (1.234s)! For help, type "help"');
    if (mode === 'crash') {
      setTimeout(() => {
        out('Exception in server tick loop', 'ERROR');
        process.exit(1);
      }, 120);
    }
  }, startDelay);
}

if (mode === 'ctrlc') {
  process.on('SIGINT', () => {
    note('SIGINT received');
    out('Stopping the server (Ctrl+C)');
    setTimeout(() => process.exit(0), 50);
  });
}

if (mode === 'busy') {
  const end = Date.now() + 120_000;
  setImmediate(function spin() {
    if (Date.now() < end) {
      for (let i = 0; i < 2e6; i++);
      setImmediate(spin);
    }
  });
}

// Player lists like a real server: loaded at start, kept in memory, the whole file rewritten on every change.
// FAKE_PLAYERS=silent: the commands are accepted but nothing is written (a server that is slow to save).
const listFiles = { whitelist: 'whitelist.json', ops: 'ops.json', bans: 'banned-players.json', ips: 'banned-ips.json' };
const lists = Object.fromEntries(
  Object.entries(listFiles).map(([key, file]) => {
    try {
      return [key, existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []];
    } catch {
      return [key, []];
    }
  }),
);
const saveList = (key) => {
  if (process.env.FAKE_PLAYERS !== 'silent') writeFileSync(listFiles[key], JSON.stringify(lists[key], null, 2));
};
const fakeUuid = (name) => `00000000-0000-0000-0000-${Buffer.from(name.toLowerCase()).toString('hex').padStart(12, '0').slice(0, 12)}`;
const byName = (key, name) => lists[key].findIndex((entry) => entry.name.toLowerCase() === name.toLowerCase());
const created = '2026-01-01 00:00:00 +0000';
function playerCommand(command, text) {
  const [first, ...more] = text.split(' ');
  if (command === 'whitelist' && (first === 'on' || first === 'off')) {
    // like a real server, the switch is written to server.properties
    if (process.env.FAKE_PLAYERS !== 'silent') {
      const file = 'server.properties';
      const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : [];
      const entry = `white-list=${first === 'on'}`;
      const index = lines.findIndex((line) => line.startsWith('white-list='));
      if (index >= 0) lines[index] = entry;
      else lines.push(entry);
      writeFileSync(file, lines.join('\n'));
    }
  } else if (command === 'whitelist') {
    const name = more.join(' ');
    if (first === 'add' && byName('whitelist', name) < 0) lists.whitelist.push({ uuid: fakeUuid(name), name });
    else if (first === 'remove' && byName('whitelist', name) >= 0) lists.whitelist.splice(byName('whitelist', name), 1);
    else return out('Nothing changed');
    saveList('whitelist');
  } else if (command === 'op') {
    if (byName('ops', text) >= 0) return out('Nothing changed. The player already is an operator');
    lists.ops.push({ uuid: fakeUuid(text), name: text, level: 4, bypassesPlayerLimit: false });
    saveList('ops');
  } else if (command === 'deop') {
    if (byName('ops', text) < 0) return out('Nothing changed. The player is not an operator');
    lists.ops.splice(byName('ops', text), 1);
    saveList('ops');
  } else if (command === 'ban') {
    if (byName('bans', first) >= 0) return out('Nothing changed. The player is already banned');
    lists.bans.push({ uuid: fakeUuid(first), name: first, created, source: 'Server', expires: 'forever', reason: more.join(' ') || 'Banned by an operator.' });
    saveList('bans');
  } else if (command === 'pardon') {
    if (byName('bans', text) < 0) return out('Nothing changed. The player is not banned');
    lists.bans.splice(byName('bans', text), 1);
    saveList('bans');
  } else if (command === 'ban-ip') {
    lists.ips.push({ ip: first, created, source: 'Server', expires: 'forever', reason: more.join(' ') || 'Banned by an operator.' });
    saveList('ips');
  } else if (command === 'pardon-ip') {
    lists.ips = lists.ips.filter((entry) => entry.ip !== text);
    saveList('ips');
  }
  out('Done');
}
const playerCommands = new Set(['whitelist', 'op', 'deop', 'ban', 'pardon', 'ban-ip', 'pardon-ip']);

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const [command, ...rest] = line.split(' ');
  const text = rest.join(' ');
  switch (command) {
    case 'stop':
      note('stop command received');
      if (mode === 'ignore-stop') return;
      out('Stopping the server');
      out('Saving worlds');
      setTimeout(() => process.exit(0), 40);
      break;
    case 'save-off':
      note('save-off');
      saving = false;
      if (saveMode !== 'no-off') out(saveMode === 'old' ? 'Turned off world auto-saving' : 'Automatic saving is now disabled');
      break;
    case 'save-on':
      note('save-on');
      saving = true;
      if (saveMode !== 'no-on') out(saveMode === 'old' ? 'Turned on world auto-saving' : 'Automatic saving is now enabled');
      break;
    case 'save-all': {
      const flush = text === 'flush';
      note(`save-all${flush ? ' flush' : ''} (saving ${saving ? 'on' : 'off'})`);
      if (flush && saveMode === 'no-flush-arg') {
        out('Unknown or incomplete command, see below for error', 'WARN');
        break;
      }
      if (saveMode === 'flush-silent') break;
      if (saveMode === 'flush-fail') {
        out('Could not save the game (is there enough disk space?)');
        break;
      }
      out('Saving the game (this may take a moment!)');
      setTimeout(() => out(saveMode === 'old' ? 'Saved the world' : 'Saved the game'), saveMode === 'flush-slow' ? 400 : 5);
      break;
    }
    case 'say':
      out(`[Server] ${text}`);
      break;
    case 'join':
      out(`${text} joined the game`);
      break;
    case 'leave':
      out(`${text} left the game`);
      break;
    case 'chat':
      out(`<${text.split(' ')[0]}> ${rest.slice(1).join(' ')}`);
      break;
    case 'stderr':
      process.stderr.write(`${text}\n`);
      break;
    case 'crlf':
      process.stdout.write('crlf one\r\ncrlf two\r\n');
      break;
    case 'utf8': {
      const bytes = Buffer.from('Grüße ☃ 😀 done\n', 'utf8');
      for (let i = 0; i < bytes.length; i++) process.stdout.write(bytes.subarray(i, i + 1));
      break;
    }
    case 'long':
      process.stdout.write(`${'x'.repeat(20_000)}\n`);
      break;
    case 'raw':
      process.stdout.write(`${text}\n`);
      break;
    case 'exit':
      process.exit(Number(text || 0));
      break;
    default:
      if (playerCommands.has(command)) playerCommand(command, text);
      else out(`Unknown command: ${line}`);
  }
});
rl.on('close', () => {
  if (mode === 'exit-on-eof') process.exit(0);
});
