// Stand-in for valheim_server: logs like the real one, writes the world into -savedir on SIGINT and quits.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
writeFileSync('fake-valheim-args.json', JSON.stringify({ args, env: { SteamAppId: process.env.SteamAppId, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } }));
const arg = (name) => args[args.indexOf(name) + 1];
console.log('12/31/2026 00:00:00: Valheim version: l-0.219.16');
setTimeout(() => console.log('12/31/2026 00:00:01: Game server connected'), 30);
setTimeout(() => console.log('12/31/2026 00:00:02: Got character ZDOID from Ragnar : 12345:1'), 60);
process.on('SIGINT', () => {
  const worlds = path.join(arg('-savedir'), 'worlds_local');
  mkdirSync(worlds, { recursive: true });
  writeFileSync(path.join(worlds, `${arg('-world')}.db`), 'world');
  writeFileSync(path.join(worlds, `${arg('-world')}.fwl`), 'meta');
  console.log('12/31/2026 00:00:03: World saved ( 1.000ms )');
  process.exit(0);
});
setInterval(() => undefined, 1000);
