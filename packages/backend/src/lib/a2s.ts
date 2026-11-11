import dgram from 'node:dgram';

// Steam server query A2S_INFO (https://developer.valvesoftware.com/wiki/Server_queries): the number of players of a
// game that answers on its query port. Newer servers first answer with a challenge that is sent back once.
const INFO = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]), Buffer.from('Source Engine Query\0', 'latin1')]);

export interface A2sInfo {
  name: string;
  map: string;
  players: number;
  maxPlayers: number;
}

export function parseInfo(packet: Buffer): A2sInfo | null {
  if (packet.length < 6 || packet.readInt32LE(0) !== -1 || packet[4] !== 0x49) return null;
  let offset = 6;
  const text = (): string | null => {
    const end = packet.indexOf(0, offset);
    if (end < 0) return null;
    const value = packet.toString('utf8', offset, end);
    offset = end + 1;
    return value;
  };
  const name = text();
  const map = text();
  if (text() === null || text() === null || name === null || map === null) return null;
  offset += 2;
  if (packet.length < offset + 2) return null;
  return { name, map, players: packet[offset] ?? 0, maxPlayers: packet[offset + 1] ?? 0 };
}

export function a2sInfo(port: number, host = '127.0.0.1', timeoutMs = 2000): Promise<A2sInfo | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const done = (value: A2sInfo | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.on('error', () => done(null));
    socket.on('message', (packet) => {
      if (packet.length >= 9 && packet.readInt32LE(0) === -1 && packet[4] === 0x41) {
        socket.send(Buffer.concat([INFO, packet.subarray(5, 9)]), port, host);
        return;
      }
      done(parseInfo(packet));
    });
    socket.send(INFO, port, host, (error) => {
      if (error !== null) done(null);
    });
  });
}
