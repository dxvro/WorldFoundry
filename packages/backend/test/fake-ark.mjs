// Stand-in for ShooterGameServer: parses the ?Key=Value line, answers Source RCON on RCONPort with the admin
// password, writes a world into ShooterGame/Saved/SavedArks and leaves after SaveWorld + DoExit.
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const args = process.argv.slice(2);
writeFileSync('fake-ark-args.json', JSON.stringify(args));
const values = Object.fromEntries(args[0].split('?').slice(1).map((part) => part.split('=')));
const saved = path.join(process.cwd(), '..', '..', 'Saved');
let savedWorld = false;
console.log('[2026.01.01-00.00.00:000][  0]Server: "Fake" has successfully started!');

const packet = (id, type, body) => {
  const text = Buffer.from(body, 'utf8');
  const out = Buffer.alloc(14 + text.length);
  out.writeInt32LE(10 + text.length, 0);
  out.writeInt32LE(id, 4);
  out.writeInt32LE(type, 8);
  text.copy(out, 12);
  return out;
};
const answer = (command) => {
  if (command === 'ListPlayers') return '\n0. Bob, 76561198000000001\n1. Alice Smith, 76561198000000002\n ';
  if (command === 'SaveWorld') {
    mkdirSync(path.join(saved, 'SavedArks'), { recursive: true });
    writeFileSync(path.join(saved, 'SavedArks', `${args[0].split('?')[0]}.ark`), 'world');
    savedWorld = true;
    return 'World Saved';
  }
  if (command === 'DoExit') {
    setTimeout(() => process.exit(savedWorld ? 0 : 3), 20);
    return 'Exiting...';
  }
  if (command.startsWith('KickPlayer ')) return `Kicked ${command.slice(11)}`;
  return 'Server received, But no response!! ';
};
setTimeout(() => {
  net
    .createServer((socket) => {
      let buffer = Buffer.alloc(0);
      let authed = false;
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4 && buffer.length >= buffer.readInt32LE(0) + 4) {
          const size = buffer.readInt32LE(0);
          const id = buffer.readInt32LE(4);
          const type = buffer.readInt32LE(8);
          const body = buffer.toString('utf8', 12, 4 + size - 2);
          buffer = buffer.subarray(size + 4);
          if (type === 3) {
            authed = body === values.ServerAdminPassword;
            socket.write(packet(authed ? id : -1, 2, ''));
          } else if (type === 2 && authed) {
            socket.write(packet(id, 0, answer(body)));
          }
        }
      });
    })
    .listen(Number(values.RCONPort), '127.0.0.1');
}, 30);
