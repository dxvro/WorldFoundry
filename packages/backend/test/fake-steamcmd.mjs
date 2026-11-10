// Stand-in for SteamCMD: parses +force_install_dir and +app_update, prints Valve-like progress and success lines and
// leaves the files of a Project Zomboid dedicated server behind. FAKE_STEAM=fail ends without the success line.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dir = args[args.indexOf('+force_install_dir') + 1];
const appId = args[args.indexOf('+app_update') + 1];
// next to the install folder: <server>/steamcmd-args.json, so parallel tests never share the file
mkdirSync(path.dirname(dir), { recursive: true });
writeFileSync(path.join(path.dirname(dir), 'steamcmd-args.json'), JSON.stringify(args));
console.log('Steam Console Client (c) Valve Corporation - version 1700000000');
console.log("Connecting anonymously to Steam Public...OK");
console.log(` Update state (0x61) downloading, progress: 12.50 (100 / 800)`);
console.log(` Update state (0x61) downloading, progress: 87.50 (700 / 800)`);
if (process.env.FAKE_STEAM === 'fail') {
  console.log(`Error! App '${appId}' state is 0x602 after update job.`);
  process.exit(8);
}
mkdirSync(dir, { recursive: true });
if (appId === '376030') {
  // ARK: Survival Evolved
  const bin = path.join(dir, 'ShooterGame', 'Binaries', 'Linux');
  mkdirSync(bin, { recursive: true });
  const fake = path.join(path.dirname(new URL(import.meta.url).pathname), 'fake-ark.mjs');
  writeFileSync(path.join(bin, 'ShooterGameServer'), `#!/bin/bash\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(path.join(bin, 'ShooterGameServer'), 0o755);
  console.log(`Success! App '${appId}' fully installed.`);
  process.exit(0);
}
if (appId === '1690800') {
  // Satisfactory: the shipping binary is started directly
  const bin = path.join(dir, 'Engine', 'Binaries', 'Linux');
  mkdirSync(bin, { recursive: true });
  const fake = path.join(path.dirname(new URL(import.meta.url).pathname), 'fake-satisfactory.mjs');
  writeFileSync(path.join(bin, 'FactoryServer-Linux-Shipping'), `#!/bin/bash\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(path.join(bin, 'FactoryServer-Linux-Shipping'), 0o755);
  writeFileSync(path.join(bin, 'FactoryServer-Linux-Shipping.version'), JSON.stringify({ MajorVersion: 5, Changelist: 491200 }));
  console.log(`Success! App '${appId}' fully installed.`);
  process.exit(0);
}
const server = path.join(path.dirname(new URL(import.meta.url).pathname), 'fake-zomboid.mjs');
writeFileSync(path.join(dir, 'start-server.sh'), `#!/bin/bash\nexec "${process.execPath}" "${server}" "$@"\n`);
chmodSync(path.join(dir, 'start-server.sh'), 0o755);
writeFileSync(path.join(dir, 'ProjectZomboid64.json'), JSON.stringify({ mainClass: 'zombie/network/GameServer', vmArgs: ['-Djava.awt.headless=true', '-Xmx8g'] }));
console.log(`Success! App '${appId}' fully installed.`);
