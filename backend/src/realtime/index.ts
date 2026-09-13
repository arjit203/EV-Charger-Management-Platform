/**
 * Socket.IO server — the browser half of the project's real-time story.
 *
 * THE TWO REAL-TIME SYSTEMS SHARE ONE HTTP SERVER AND NOTHING ELSE:
 *
 *   /ocpp/<ocppId>   raw `ws`, OCPP-J frames, chargers      (Module 6)
 *   /socket.io       Socket.IO, app events, browsers        (this file)
 *
 * They coexist because `server.ts` has used `http.createServer(app)` since Module 0, and the
 * OCPP gateway's upgrade handler returns early for any path that is not under `/ocpp/`. That
 * early return was written in Module 6 specifically to leave this path free.
 *
 * The separation is not cosmetic. A charger speaks a published protocol we do not control and
 * authenticates with a per-charger token; a browser speaks events we define and authenticates
 * with a user's JWT. Neither could use the other's transport: no charger implements Socket.IO,
 * and a browser has no business speaking OCPP.
 */

import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';

import { env } from '../config/env';
import { logger } from '../utils/logger';
import { authenticateSocket, type AppSocket } from './auth';
import { setServer } from './publisher';
import { roomsFor } from './rooms';

const SCOPE = 'realtime';

let io: Server | null = null;

export function attachRealtime(httpServer: HttpServer): void {
  io = new Server(httpServer, {
    path: '/socket.io',
    // The same allowlist Express uses. Two lists would eventually drift, and a socket
    // permitted from an origin REST refuses would be a hole.
    cors: { origin: env.corsOrigins, credentials: true },
  });

  // Runs before a connection is established, so an unauthenticated socket never exists.
  io.use((socket, next) => {
    void authenticateSocket(socket as AppSocket, next);
  });

  io.on('connection', (socket) => {
    const appSocket = socket as AppSocket;
    const user = appSocket.data.user;

    // ROOMS ARE ASSIGNED HERE, FROM THE VERIFIED IDENTITY, AND NOWHERE ELSE.
    //
    // Note what this handler does NOT register: any listener for a client-sent "join". There is
    // no validated join path because there is no join path at all — the safest check is one
    // that cannot be reached. A client emitting `join` gets silence.
    const rooms = roomsFor(user);
    if (rooms.length > 0) void socket.join(rooms);

    logger.info(SCOPE, `Socket connected: ${user.email} (${user.role}) -> [${rooms.join(', ')}]`);

    socket.on('disconnect', (reason) => {
      logger.info(SCOPE, `Socket disconnected: ${user.email} (${reason})`);
    });

    // A malformed frame or a handler throwing must not take the process down. Socket.IO
    // surfaces those here rather than as an uncaught exception.
    socket.on('error', (error: unknown) => {
      logger.error(SCOPE, `Socket error for ${user.email}`, error);
    });
  });

  setServer(io);

  logger.info(SCOPE, 'Socket.IO listening on /socket.io');
}

/** Close every browser socket cleanly. Called during shutdown, beside the OCPP gateway's. */
export async function closeRealtime(): Promise<void> {
  if (!io) return;

  const server = io;
  io = null;
  setServer(null);

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
