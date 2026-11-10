// Stand-in for SteamCMD: parses +force_install_dir and +app_update, prints Valve-like progress and success lines and
// leaves the files of a Project Zomboid dedicated server behind. FAKE_STEAM=fail ends without the success line.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dir = args[args.indexOf('+force_install_dir') + 1];
const appId = args[args.indexOf('+app_update') + 1];
writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '.last-steamcmd-args.json'), JSON.stringify(args));
console.log('Steam Console Client (c) Valve Corporation - version 1700000000');
console.log("Connecting anonymously to Steam Public...OK");
console.log(` Update state (0x61) downloading, progress: 12.50 (100 / 800)`);
console.log(` Update state (0x61) downloading, progress: 87.50 (700 / 800)`);
if (process.env.FAKE_STEAM === 'fail') {
  console.log(`Error! App '${appId}' state is 0x602 after update job.`);
  process.exit(8);
}
mkdirSync(dir, { recursive: true });
const server = path.join(path.dirname(new URL(import.meta.url).pathname), 'fake-zomboid.mjs');
writeFileSync(path.join(dir, 'start-server.sh'), `#!/bin/bash\nexec "${process.execPath}" "${server}" "$@"\n`);
chmodSync(path.join(dir, 'start-server.sh'), 0o755);
writeFileSync(path.join(dir, 'ProjectZomboid64.json'), JSON.stringify({ mainClass: 'zombie/network/GameServer', vmArgs: ['-Djava.awt.headless=true', '-Xmx8g'] }));
console.log(`Success! App '${appId}' fully installed.`);
