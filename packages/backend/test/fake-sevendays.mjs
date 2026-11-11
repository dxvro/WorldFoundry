// Stand-in for 7DaysToDieServer: reads serverconfig.xml, prints the ready line, answers the telnet console
// (password, lp, saveworld, shutdown) and writes a save into UserDataFolder.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const args = process.argv.slice(2);
writeFileSync('fake-sevendays-args.json', JSON.stringify({ args, ld: process.env.LD_LIBRARY_PATH }));
const configFile = args.find((arg) => arg.startsWith('-configfile=')).slice('-configfile='.length);
const xml = readFileSync(configFile, 'utf8');
const prop = (name) => new RegExp(`name="${name}"\\s+value="([^"]*)"`).exec(xml)?.[1];
let saved = false;
const save = () => {
  const dir = path.join(prop('UserDataFolder'), 'Saves', prop('GameWorld'), prop('GameName'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'main.ttw'), 'world');
  saved = true;
};
net
  .createServer((socket) => {
    let authed = false;
    socket.write('Please enter password:\r\n');
    let line = '';
    socket.on('data', (chunk) => {
      line += chunk.toString();
      let index;
      while ((index = line.indexOf('\n')) >= 0) {
        const text = line.slice(0, index).trim();
        line = line.slice(index + 1);
        if (!authed) {
          authed = text === prop('TelnetPassword');
          socket.write(authed ? 'Logon successful.\r\n\r\n*** Connected with 7DTD server.\r\n' : 'Password incorrect, please enter password:\r\n');
          continue;
        }
        if (text === 'exit') socket.end();
        else if (text === 'lp') socket.write("0. id=171, Bob, pos=(1.0, 2.0, 3.0), rot=(0.0, 0.0, 0.0), remote=True, health=100\r\nTotal of 1 in the game\r\n");
        else if (text === 'saveworld') {
          save();
          socket.write('World saved\r\n');
        } else if (text === 'shutdown') {
          socket.write('Shutting server down...\r\n');
          setTimeout(() => process.exit(saved ? 0 : 3), 30);
        } else socket.write(`Executed ${text}\r\n`);
      }
    });
  })
  .listen(Number(prop('TelnetPort')), '127.0.0.1', () => {
    console.log('2026-12-31T00:00:00 1.000 INF GameServer.Init successful');
    console.log("2026-12-31T00:00:01 2.000 INF PlayerSpawnedInWorld (reason: JoinMultiplayer, position: 1, 2, 3): EntityID=171, PltfmId='Steam_1', CrossId='EOS_1', OwnerID='Steam_1', PlayerName='Bob', ClientNumber='1'");
  });
