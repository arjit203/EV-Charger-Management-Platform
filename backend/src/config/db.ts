/**
 * MongoDB connection management.
 *
 * Design decision (Module 0): connecting to MongoDB must NEVER prevent the HTTP
 * server from starting. The API boots first, then attempts the database connection
 * in the background, and `/health` reports the real connection state. This means a
 * missing or wrong MONGODB_URI produces a running server with an honest
 * "disconnected" report, instead of a process that dies before you can debug it.
 */

import mongoose from 'mongoose';
import { env } from './env';
import { logger } from '../utils/logger';

const SCOPE = 'config:db';

/** Human-readable names for mongoose's numeric `connection.readyState`. */
const READY_STATE_LABELS: Record<number, DatabaseState> = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

export type DatabaseState =
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'disconnecting'
  | 'not_configured'
  | 'unknown';

export interface DatabaseStatus {
  state: DatabaseState;
  /** Name of the database we are connected to, once known. */
  name: string | null;
  /** Host we are connected to, once known. Never includes credentials. */
  host: string | null;
  /** Last connection error message, if the most recent attempt failed. */
  lastError: string | null;
}

let lastError: string | null = null;

/** Attach listeners once so connection changes are visible in the terminal. */
function registerConnectionListeners(): void {
  const connection = mongoose.connection;

  connection.on('connected', () => {
    lastError = null;
    logger.info(SCOPE, `MongoDB connected (db: "${connection.name}", host: ${connection.host})`);
  });

  connection.on('error', (error: Error) => {
    lastError = error.message;
    logger.error(SCOPE, `MongoDB connection error: ${error.message}`);
  });

  connection.on('disconnected', () => {
    logger.warn(SCOPE, 'MongoDB disconnected.');
  });

  connection.on('reconnected', () => {
    lastError = null;
    logger.info(SCOPE, 'MongoDB reconnected.');
  });
}

/**
 * Attempt to connect to MongoDB.
 *
 * Resolves to `true` on success and `false` on failure — it never throws, because
 * the caller (server.ts) must keep serving requests either way.
 */
export async function connectDatabase(): Promise<boolean> {
  if (!env.mongodbUri) {
    logger.warn(SCOPE, 'MONGODB_URI is empty — skipping database connection.');
    logger.warn(SCOPE, 'Set MONGODB_URI in backend/.env, then restart the server.');
    return false;
  }

  registerConnectionListeners();

  // Fail fast instead of the 30s default, so a wrong URI is obvious immediately.
  mongoose.set('strictQuery', true);

  try {
    await mongoose.connect(env.mongodbUri, {
      serverSelectionTimeoutMS: 5000,
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastError = message;
    logger.error(SCOPE, `Could not connect to MongoDB: ${message}`);
    logger.error(SCOPE, 'The API is still running. /health will report db.state = "disconnected".');
    return false;
  }
}

/** Current database status, safe to expose over HTTP (no credentials included). */
export function getDatabaseStatus(): DatabaseStatus {
  if (!env.mongodbUri) {
    return { state: 'not_configured', name: null, host: null, lastError: null };
  }

  const connection = mongoose.connection;
  const state = READY_STATE_LABELS[connection.readyState] ?? 'unknown';

  return {
    state,
    name: connection.name ?? null,
    host: connection.host ?? null,
    lastError: state === 'connected' ? null : lastError,
  };
}

/** Close the connection cleanly during shutdown. */
export async function disconnectDatabase(): Promise<void> {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.connection.close();
  logger.info(SCOPE, 'MongoDB connection closed.');
}
