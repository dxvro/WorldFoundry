// Server log lines look like
//   vanilla/Fabric  [12:00:00] [Server thread/INFO]: message
//   Forge/NeoForge  [12:00:00] [Server thread/INFO] [net.minecraft.server.dedicated.DedicatedServer/]: message
//   Paper           [12:00:00 INFO]: message
//   Fabric (logger) [12:00:00] [Server thread/INFO] (Minecraft) message   (the colon after the logger is optional)
// The patterns are anchored at the log prefix and at the start of the message, so a chat line such as
// "<Bob> Done (1.0s)! For help" or "[Server] Steve joined the game" can never match.

const TIME = String.raw`(?:\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}:\d{2}(?:[.,]\d{1,3})?`;
const LEVEL = String.raw`(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)`;

const VANILLA_PREFIX = String.raw`\[${TIME}\] \[[^\]\r\n/]{1,64}/${LEVEL}\](?: \[[^\]\r\n]{0,200}\])*(?:: | \([^)\r\n]{0,100}\):? )`;
const PAPER_PREFIX = String.raw`\[${TIME} ${LEVEL}\]: `;
const PREFIX = `(?:${VANILLA_PREFIX}|${PAPER_PREFIX})`;
const NAME = String.raw`[A-Za-z0-9_.]{1,32}`;

const DONE = new RegExp(String.raw`^${PREFIX}Done \(\d+(?:[.,]\d+)?s\)! For help, type "help"(?: or "\?")?$`);
const JOINED = new RegExp(String.raw`^${PREFIX}(${NAME}) joined the game$`);
const LEFT = new RegExp(String.raw`^${PREFIX}(${NAME}) left the game$`);

export type LineEvent = { type: 'done' } | { type: 'join'; name: string } | { type: 'leave'; name: string };

export function classifyLine(line: string): LineEvent | null {
  if (line.length > 400) return null;
  if (DONE.test(line)) return { type: 'done' };
  const joined = JOINED.exec(line)?.[1];
  if (joined !== undefined) return { type: 'join', name: joined };
  const left = LEFT.exec(line)?.[1];
  if (left !== undefined) return { type: 'leave', name: left };
  return null;
}

// ---- save commands ------------------------------------------------------------------------------
// Feedback of save-off, save-all and save-on. Wording differs between versions (1.12 says "Turned off world
// auto-saving" and "Saved the world", 1.13+ "Automatic saving is now disabled" and "Saved the game"), and
// the console may wrap the text as "[Server: ...]". The patterns are anchored like the ones above, so chat
// lines cannot trigger them.
const WRAPPED = (text: string): string => String.raw`(?:\[(?:Server|Rcon): )?${text}\]?\.?\s*`;
const SAVE_OFF = new RegExp(`^${PREFIX}${WRAPPED('(?:Automatic saving is now disabled|Saving is already turned off|Turned off world auto-saving)')}$`, 'i');
const SAVE_FLUSHED = new RegExp(`^${PREFIX}${WRAPPED('(?:Saved the (?:game|world)|Save complete)')}$`, 'i');
const SAVE_ON = new RegExp(`^${PREFIX}${WRAPPED('(?:Automatic saving is now enabled|Saving is already turned on|Turned on world auto-saving)')}$`, 'i');
const SAVE_FAILED = new RegExp(`^${PREFIX}${WRAPPED(String.raw`Could not save the game(?: \(is there enough disk space\?\))?`)}$`, 'i');
const SAVE_UNSUPPORTED = new RegExp(`^${PREFIX}${WRAPPED('(?:Unknown or incomplete command.*|Incorrect argument for command.*|Usage: /?save-all.*)')}$`, 'i');

export type SaveEvent = 'off' | 'flushed' | 'on' | 'failed' | 'unsupported';

export function classifySaveLine(line: string): SaveEvent | null {
  if (line.length > 400) return null;
  if (SAVE_OFF.test(line)) return 'off';
  if (SAVE_FLUSHED.test(line)) return 'flushed';
  if (SAVE_ON.test(line)) return 'on';
  if (SAVE_FAILED.test(line)) return 'failed';
  if (SAVE_UNSUPPORTED.test(line)) return 'unsupported';
  return null;
}
