// Stand-in for TerrariaServer: reads -config, prints the ready line, a join and a leave, and saves on "exit".
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
writeFileSync('fake-terraria-args.json', JSON.stringify(args));
const config = Object.fromEntries(readFileSync(args[args.indexOf('-config') + 1], 'utf8').split('\n').filter((line) => line.includes('=')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
writeFileSync('fake-terraria-config.json', JSON.stringify(config));
console.log('Terraria Server v1.4.5.8');
setTimeout(() => {
  console.log('Server started');
  console.log('Guide has joined.');
  console.log('Merchant has left.');
}, 30);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === 'exit') {
    mkdirSync(path.dirname(config.world), { recursive: true });
    writeFileSync(config.world, 'world');
    console.log('Saving world data: 100%');
    process.exit(0);
  }
  console.log(`: ${line}`);
});
