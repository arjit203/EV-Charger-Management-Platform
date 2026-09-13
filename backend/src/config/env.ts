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
} as const;

// Keep `required` referenced for use by later modules (JWT_SECRET in Module 1, etc.)
export { required as requiredEnv };
