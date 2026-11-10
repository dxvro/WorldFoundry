import type { Server } from '../db/schema.js';

// Every port a server holds: the game port of the row and the second port some games need
// (Project Zomboid: UDPPort, Satisfactory: ReliablePort, ARK: peer, query and RCON port). Used so a new server never takes a port of another one.
export function portsOf(server: Pick<Server, 'port' | 'gameSettings'>): number[] {
  const ports = [server.port];
  try {
    const settings = JSON.parse(server.gameSettings) as Record<string, unknown>;
    for (const key of ['udpPort', 'reliablePort', 'peerPort', 'queryPort', 'rconPort']) {
      const value = settings[key];
      if (typeof value === 'number' && Number.isInteger(value)) ports.push(value);
    }
  } catch {
    // a damaged value is reported where the settings are read
  }
  return ports;
}

export const takenPorts = (others: readonly Pick<Server, 'id' | 'port' | 'gameSettings'>[], except?: string): Set<number> =>
  new Set(others.filter((other) => other.id !== except).flatMap((other) => portsOf(other)));
