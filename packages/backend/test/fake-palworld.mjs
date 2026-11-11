// Stand-in for PalServer.sh: reads PalWorldSettings.ini, answers the REST API with Basic auth and leaves on /shutdown.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const args = process.argv.slice(2);
writeFileSync('fake-palworld-args.json', JSON.stringify(args));
const ini = readFileSync(path.join(process.cwd(), 'Pal', 'Saved', 'Config', 'LinuxServer', 'PalWorldSettings.ini'), 'utf8');
const option = (key) => new RegExp(`[(,]${key}=("([^"]*)"|[^,)]*)`).exec(ini);
const admin = option('AdminPassword')?.[2];
const restPort = Number(option('RESTAPIPort')?.[1]);
let saved = false;
http
  .createServer((request, response) => {
    if (request.headers.authorization !== `Basic ${Buffer.from(`admin:${admin}`).toString('base64')}`) {
      response.writeHead(401).end();
      return;
    }
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const route = request.url.replace('/v1/api/', '');
      if (route === 'info') response.end(JSON.stringify({ version: 'v0.6', servername: 'fake' }));
      else if (route === 'players') response.end(JSON.stringify({ players: [{ name: 'Pal Fan', userId: 'steam_42', playerId: 'abc' }] }));
      else if (route === 'save') {
        const dir = path.join(process.cwd(), 'Pal', 'Saved', 'SaveGames', '0', '0123456789ABCDEF0123456789ABCDEF');
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'Level.sav'), 'world');
        saved = true;
        response.end();
      } else if (route === 'shutdown') {
        response.end();
        setTimeout(() => process.exit(saved ? 0 : 3), 30);
      } else if (route === 'kick' || route === 'ban' || route === 'announce') {
        writeFileSync(`fake-palworld-${route}.json`, body);
        response.end();
      } else response.writeHead(404).end();
    });
  })
  .listen(restPort, '127.0.0.1', () => console.log('[2026-12-31 00:00:00] [LOG] Running Palworld dedicated server on :8211'));
