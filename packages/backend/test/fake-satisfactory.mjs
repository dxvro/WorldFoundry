// Stand-in for the Satisfactory dedicated server binary. Writes its arguments and home folder, a save game below
// $HOME/.config/Epic, marks itself ready for the fake health check, and saves and exits on SIGINT.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const home = process.env.HOME ?? '';
writeFileSync('fake-satisfactory.json', JSON.stringify({ args: process.argv.slice(2), home, xdg: process.env.XDG_CONFIG_HOME ?? null }));
const saves = path.join(home, '.config', 'Epic', 'FactoryGame', 'Saved', 'SaveGames');
console.log('LogInit: Display: Starting Game.');
setTimeout(() => {
  mkdirSync(path.join(saves, 'server'), { recursive: true });
  writeFileSync(path.join(saves, 'server', 'Factory_autosave_0.sav'), 'world');
  writeFileSync(path.join(saves, 'ServerSettings.7777.sav'), 'settings');
  writeFileSync('fake-satisfactory.ready', 'yes');
}, 30);
process.on('SIGINT', () => {
  console.log('LogExit: Exiting.');
  process.exit(0);
});
setInterval(() => undefined, 1000);
