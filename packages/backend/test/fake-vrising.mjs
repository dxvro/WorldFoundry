// Stand-in for VRisingServer.exe behind Proton: started as `proton run VRisingServer.exe <args>`, it records how it
// was started, answers Source RCON with -rconPassword and writes a save into -persistentDataPath on SIGINT.
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const all = process.argv.slice(2);
const args = all[0] === 'run' ? all.slice(2) : all;
const arg = (name) => args[args.indexOf(name) + 1];
const data = arg('-persistentDataPath');
mkdirSync(data, { recursive: true });
writeFileSync(path.join(data, 'fake-vrising-start.json'), JSON.stringify({ proton: all[0] === 'run', exe: all[1], args, env: { STEAM_COMPAT_DATA_PATH: process.env.STEAM_COMPAT_DATA_PATH } }));
console.log('Bootstrap - Fake V Rising server');

const packet = (id, type, body) => {
  const text = Buffer.from(body, 'utf8');
  const out = Buffer.alloc(14 + text.length);
  out.writeInt32LE(10 + text.length, 0);
  out.writeInt32LE(id, 4);
  out.writeInt32LE(type, 8);
  text.copy(out, 12);
  return out;
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
            authed = body === arg('-rconPassword');
            socket.write(packet(authed ? id : -1, 2, ''));
          } else if (type === 2 && authed) {
            socket.write(packet(id, 0, body === 'version' ? 'V Rising 1.1.0' : `Unknown command ${body}`));
          }
        }
      });
    })
    .listen(Number(arg('-rconPort')), '127.0.0.1');
}, 30);
process.on('SIGINT', () => {
  const save = path.join(data, 'Saves', 'v4', arg('-saveName'), 'AutoSave_1');
  mkdirSync(save, { recursive: true });
  writeFileSync(path.join(save, 'SaveGame.save'), 'world');
  process.exit(0);
});
setInterval(() => undefined, 1000);
