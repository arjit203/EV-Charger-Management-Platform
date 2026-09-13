/**
 * Process entry point.
 *
 * Responsibilities, in order:
 *   1. create the HTTP server from the Express app
 *   2. start listening immediately (so the API is reachable even with no database)
 *   3. attempt the MongoDB connection in the background
 *   4. shut down cleanly on Ctrl+C / SIGTERM
 *
 * The `httpServer` created here is the seam that Module 6 (OCPP WebSocket gateway)
 * and Module 8 (Socket.IO) will attach to. It is created now, even though nothing
 * else uses it yet, so that neither module requires restructuring this file.
 */

import http from 'http';

import app from './app';
import { env } from './config/env';
import { connectDatabase, disconnectDatabase } from './config/db';
import { attachOcppGateway, shutdownOcppGateway } from './ocpp/gateway';
import { attachRealtime, closeRealtime } from './realtime';
import { logger } from './utils/logger';

const SCOPE = 'server';

const httpServer = http.createServer(app);

/**
 * MODULE 6 — the OCPP WebSocket gateway attaches to the SAME HTTP server as Express.
 *
 * This is exactly why `app.ts` never calls `listen()` and this file creates the server
 * explicitly. The gateway claims only paths under `/ocpp/`, leaving `/socket.io` free for
 * Module 8 so both real-time systems can share one port without renegotiation.
 */
attachOcppGateway(httpServer);

/*
 * Both real-time systems bind to the SAME http.Server, which is the whole reason this file has
 * never used `app.listen()`. The OCPP gateway claims `/ocpp/*` and ignores everything else;
 * Socket.IO takes `/socket.io`. Chargers and browsers therefore share a port and nothing more.
 */
attachRealtime(httpServer);

httpServer.listen(env.port, () => {
  logger.info(SCOPE, `EV-CMS backend listening on http://localhost:${env.port}`);
  logger.info(SCOPE, `Health check: http://localhost:${env.port}${env.apiPrefix}/health`);
  logger.info(SCOPE, `Environment: ${env.nodeEnv}`);
  logger.info(SCOPE, `Allowed CORS origins: ${env.corsOrigins.join(', ') || '(none)'}`);
  logger.info(SCOPE, `OCPP endpoint: ws://localhost:${env.port}/ocpp/<ocppId>`);
});

httpServer.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(SCOPE, `Port ${env.port} is already in use.`);
    logger.error(SCOPE, 'Stop the process using it, or change PORT in backend/.env.');
    process.exit(1);
  }
  logger.error(SCOPE, 'HTTP server error', error);
  process.exit(1);
});

// Connect to MongoDB without blocking startup. A failure here is logged and
// reflected in /health; it does not take the API down.
void connectDatabase();

/** Close the HTTP server and database connection before exiting. */
async function shutdown(signal: string): Promise<void> {
  logger.info(SCOPE, `Received ${signal}. Shutting down...`);

  // Give in-flight requests a chance to finish, but never hang forever.
  const forceExit = setTimeout(() => {
    logger.error(SCOPE, 'Shutdown timed out after 10s. Forcing exit.');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  httpServer.close(async () => {
    try {
      await shutdownOcppGateway();
      await closeRealtime();
      await disconnectDatabase();
    } catch (error) {
      logger.error(SCOPE, 'Error while closing the database connection', error);
    }
    logger.info(SCOPE, 'Shutdown complete.');
    process.exit(0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// A bug that escapes every handler should be loud, not silent.
process.on('unhandledRejection', (reason) => {
  logger.error(SCOPE, 'Unhandled promise rejection', reason);
});

process.on('uncaughtException', (error) => {
  logger.error(SCOPE, 'Uncaught exception — exiting', error);
  process.exit(1);
});

export { httpServer };
