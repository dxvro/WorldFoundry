import type { FastifyReply, FastifyRequest } from 'fastify';

export const isUpgradeRequest = (request: FastifyRequest): boolean => request.headers.upgrade?.toLowerCase() === 'websocket';

// A rejected WebSocket handshake must not leave its connection open: once a request went through the
// upgrade path the HTTP server no longer tracks the socket, so nobody else would close it.
export function dropUpgradeAfterResponse(request: FastifyRequest, reply: FastifyReply): void {
  if (!isUpgradeRequest(request)) return;
  reply.raw.once('finish', () => request.raw.socket.destroy());
}
