import websocket, { type WebSocket } from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import type { ConsoleServerMessage, EventsServerMessage } from '../contract.js';
import { AppError } from './errors.js';

export const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024;
const HEARTBEAT_MS = 30_000;
const WS_OPEN = 1;

export type SendTarget = Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send' | 'close'>;

// Sends unless the client cannot keep up: a socket with too much unsent data is closed instead of
// letting the server buffer without bound.
export function safeSend(socket: SendTarget, message: unknown): boolean {
  try {
    if (socket.readyState !== WS_OPEN) return false;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      socket.close(1013, 'Client too slow');
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

const serverParams = z.object({ serverId: z.string().min(1).max(100) });
const consoleQuery = z.object({ history: z.coerce.number().int().min(0).max(2000).default(1000) });
const clientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('command'), command: z.string(), id: z.string().max(64).optional() }),
  z.object({ type: z.literal('ping') }),
]);

const errorMessage = (code: string, message: string, id?: string): Extract<ConsoleServerMessage, { type: 'error' }> => ({
  type: 'error',
  code,
  message,
  ...(id === undefined ? {} : { id }),
});

function keepAlive(socket: WebSocket): () => void {
  let alive = true;
  socket.on('pong', () => {
    alive = true;
  });
  const timer = setInterval(() => {
    try {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    } catch {
      clearInterval(timer);
    }
  }, HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

const sendConsole = (socket: SendTarget, message: ConsoleServerMessage): boolean => safeSend(socket, message);
const sendEvent = (socket: SendTarget, message: EventsServerMessage): boolean => safeSend(socket, message);

export function registerWebSocketRoutes(app: FastifyInstance, { services }: AppContext): void {
  const { manager, bus, servers } = services;
  void app.register(websocket, { options: { maxPayload: MAX_MESSAGE_BYTES } });

  void app.register(async (scope) => {
    scope.get(
      '/api/servers/:serverId/console',
      {
        websocket: true,
        // runs before the upgrade, so bad input is answered with a plain HTTP 400 and an unknown server with a 404
        preHandler: async (request) => {
          const { serverId } = serverParams.parse(request.params);
          consoleQuery.parse(request.query);
          await servers.get(serverId);
        },
      },
      (socket, request) => {
        const { serverId } = serverParams.parse(request.params);
        const { history } = consoleQuery.parse(request.query);
        const stopBeat = keepAlive(socket);
        // status and history go out in the same tick the listener is added, so no line can slip between them
        sendConsole(socket, { type: 'status', status: manager.status(serverId) });
        sendConsole(socket, { type: 'history', lines: manager.history(serverId, history) });
        const unsubscribe = manager.subscribe(serverId, {
          onLine: (line) => sendConsole(socket, { type: 'line', line }),
          onStatus: (status) => sendConsole(socket, { type: 'status', status }),
        });
        let cleaned = false;
        const cleanup = (): void => {
          if (cleaned) return;
          cleaned = true;
          unsubscribe();
          stopBeat();
        };
        socket.on('close', cleanup);
        socket.on('error', cleanup);
        socket.on('message', (data, isBinary) => {
          handleMessage(socket, serverId, data, isBinary).catch((error: unknown) => {
            app.log.error({ err: error, serverId }, 'WebSocket message could not be processed');
          });
        });
      },
    );

    scope.get('/api/events', { websocket: true }, (socket) => {
      const stopBeat = keepAlive(socket);
      sendEvent(socket, { type: 'snapshot', serverTime: Date.now(), servers: manager.statuses() });
      const unsubscribe = bus.subscribe((event) => {
        sendEvent(socket, event);
      });
      let cleaned = false;
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        unsubscribe();
        stopBeat();
      };
      socket.on('close', cleanup);
      socket.on('error', cleanup);
      socket.on('message', (data, isBinary) => {
        const parsed = parseMessage(data, isBinary);
        if (parsed.type === 'ping') sendEvent(socket, { type: 'pong' });
        else if (parsed.type === 'invalid') sendEvent(socket, errorMessage('INVALID_MESSAGE', parsed.message));
      });
    });
  });

  type Parsed = { type: 'ping' } | { type: 'command'; command: string; id?: string } | { type: 'invalid'; message: string };

  function parseMessage(data: unknown, isBinary: boolean): Parsed {
    if (isBinary) return { type: 'invalid', message: 'Binary messages are not supported.' };
    let raw: unknown;
    try {
      raw = JSON.parse(String(data));
    } catch {
      return { type: 'invalid', message: 'The message is not valid JSON.' };
    }
    const parsed = clientMessage.safeParse(raw);
    return parsed.success ? parsed.data : { type: 'invalid', message: 'Unknown or incomplete message.' };
  }

  async function handleMessage(socket: WebSocket, serverId: string, data: unknown, isBinary: boolean): Promise<void> {
    const parsed = parseMessage(data, isBinary);
    if (parsed.type === 'invalid') {
      sendConsole(socket, errorMessage('INVALID_MESSAGE', parsed.message));
    } else if (parsed.type === 'ping') {
      sendConsole(socket, { type: 'pong' });
    } else {
      try {
        await manager.sendCommand(serverId, parsed.command);
        sendConsole(socket, { type: 'ack', ...(parsed.id === undefined ? {} : { id: parsed.id }) });
      } catch (error) {
        if (error instanceof AppError) sendConsole(socket, errorMessage(error.code, error.message, parsed.id));
        else sendConsole(socket, errorMessage('INTERNAL_ERROR', 'The command could not be sent.', parsed.id));
      }
    }
  }
}
