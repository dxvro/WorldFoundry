// Stand-in for the Project Zomboid dedicated server started by start-server.sh.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
writeFileSync('fake-zomboid-args.json', JSON.stringify(args));
const cache = args.find((arg) => arg.startsWith('-cachedir='))?.slice('-cachedir='.length);
const profile = args[args.indexOf('-servername') + 1];
console.log(`LOG  : General     , 1700000000000> command line: ${args.join(' ')}`);
setTimeout(() => {
  if (cache !== undefined) {
    mkdirSync(path.join(cache, 'db'), { recursive: true });
    writeFileSync(path.join(cache, 'db', `${profile}.db`), 'db');
  }
  console.log('LOG  : General     , 1700000000100> *** SERVER STARTED ****');
  console.log('LOG  : Network     , 1700000000200> ConnectionManager: [fully-connected] "" connection: guid=1 ip=1.2.3.4 steam-id=7 access="" username="Rick" connection-type="UDPRakNet"');
}, 30);
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line === 'quit') {
    console.log('LOG  : General     , 1700000000300> Saving and quitting');
    process.exit(0);
  }
});
