/**
 * Environment loading and validation.
 *
 * This is the ONLY place in the backend that reads `process.env`. Everything else
 * imports the typed `env` object from here. That keeps missing/misspelled variables
 * a startup-time failure instead of an `undefined` that surfaces deep inside a
 * request handler three modules later.
 */

import dotenv from 'dotenv';
import path from 'path';
import { logger } from '../utils/logger';

// Load `backend/.env` regardless of which directory the process was started from.
// `quiet: true` suppresses dotenv's promotional startup banner so the terminal
// shows only our own logs.
dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const SCOPE = 'config:env';

/** Read a variable that must exist, failing loudly at boot if it does not. */
function required(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') {
    logger.error(SCOPE, `Missing required environment variable: ${key}`);
    logger.error(SCOPE, 'Copy backend/.env.example to backend/.env and fill it in.');
    process.exit(1);
  }
  return value.trim();
}

/** Read an optional variable, falling back to a default. */
function optional(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

const nodeEnv = optional('NODE_ENV', 'development');

const rawPort = optional('PORT', '5000');
const port = Number.parseInt(rawPort, 10);
if (Number.isNaN(port) || port <= 0 || port > 65535) {
  logger.error(SCOPE, `PORT must be a number between 1 and 65535, received: "${rawPort}"`);
  process.exit(1);
}

export const env = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isDevelopment: nodeEnv !== 'production',

  port,
  apiPrefix: optional('API_PREFIX', '/api/v1'),

  /** Allowed browser origins for CORS, parsed from a comma-separated list. */
  corsOrigins: optional('CORS_ORIGIN', 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  /**
   * MongoDB connection string.
   *
   * Intentionally NOT `required()`: the user wires up their own MongoDB, and the API
   * must still boot and tell them the truth on /health when the database is missing.
   * An empty string here is a valid, reported state — not a crash.
   */
  mongodbUri: optional('MONGODB_URI', ''),

  /* --- Module 1: authentication --- */

  /**
   * JWT signing key. Required — unlike the database, there is no safe degraded mode
   * for auth, so a missing secret must stop the process rather than silently produce
   * unverifiable tokens.
   */
  jwtSecret: required('JWT_SECRET'),

  /** Access-token lifetime, e.g. "7d", "12h", "30m". */
  jwtExpiresIn: optional('JWT_EXPIRES_IN', '7d'),

  /** bcrypt cost factor. 10 is a sensible default; higher is slower but stronger. */
  bcryptSaltRounds: Number.parseInt(optional('BCRYPT_SALT_ROUNDS', '10'), 10),

  /* --- Module 6: OCPP gateway --- */

  /**
   * Seconds of heartbeat silence before a charger is marked offline.
   *
   * Default 90 = three missed 30-second beats, so one lost packet is not a false alarm.
   * Configurable mainly so tests can exercise the timeout path without waiting 90 seconds.
   */
  ocppOfflineAfterSeconds: Number.parseInt(optional('OCPP_OFFLINE_AFTER_SECONDS', '90'), 10),

  /**
   * How long a charging session may wait for the charger to confirm a start (Module 7).
   *
   * Default 20 = the 10-second OCPP command timeout plus room for the charger to lock the
   * cable and run Authorize. Configurable for the same reason as the value above: the timeout
   * path is a real behaviour that needs testing, and a test should not sit idle for it.
   */
  sessionStartTimeoutSeconds: Number.parseInt(optional('SESSION_START_TIMEOUT_SECONDS', '20'), 10),
} as const;

// Keep `required` referenced for use by later modules (JWT_SECRET in Module 1, etc.)
export { required as requiredEnv };
