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
  /*
   * EXPLICIT development only. This gates stack traces in error responses, and "anything but
   * production" leaked them from any server whose NODE_ENV said `staging`, `test` or a typo.
   * Unrecognised values now fail safe.
   */
  isDevelopment: nodeEnv === 'development',

  port,
  apiPrefix: optional('API_PREFIX', '/api/v1'),

  /** Allowed browser origins for CORS, parsed from a comma-separated list. */
  // Trailing slashes stripped: browsers send `https://x.vercel.app`, people paste `https://x.vercel.app/`.
  corsOrigins: optional('CORS_ORIGIN', 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
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

  /* ------------------------- Module 10: payments ------------------------- */

  /**
   * Razorpay TEST credentials.
   *
   * `keyId` is public by design — the browser needs it to open Checkout. `keySecret` and
   * `webhookSecret` are server-only and must never be sent to a client.
   *
   * ALL THREE DEFAULT TO EMPTY, and that is the switch. When `keyId`/`keySecret` are absent the
   * payment provider falls back to a deterministic stub so the check suite can run without
   * anyone needing a Razorpay account. There is deliberately no `PAYMENTS_STUB=true` flag:
   * a flag can be shipped by accident, whereas a real deployment cannot have working
   * credentials AND be in stub mode at the same time.
   */
  razorpayKeyId: optional('RAZORPAY_KEY_ID', ''),
  razorpayKeySecret: optional('RAZORPAY_KEY_SECRET', ''),
  razorpayWebhookSecret: optional('RAZORPAY_WEBHOOK_SECRET', ''),
} as const;

/* -------------------------------------------------------------------------- */
/* Refuse unsafe configuration at boot                                         */
/* -------------------------------------------------------------------------- */

/*
 * A misconfigured deploy must fail in the Render log, not run. Each rule below was a silent
 * failure before: a server that boots, answers, and is wrong. Messages name the problem and
 * never print a value.
 */
const unsafe: string[] = [];

// TEST MODE ONLY, in every environment: a live key would move real money.
if (env.razorpayKeyId.startsWith('rzp_live_')) {
  unsafe.push('RAZORPAY_KEY_ID is a LIVE key. EV-CMS runs Razorpay in test mode only - use an rzp_test_ key.');
}

if (env.isProduction) {
  const database = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/.exec(env.mongodbUri)?.[1] ?? '';
  if (!env.mongodbUri) {
    unsafe.push('MONGODB_URI is not set.');
  } else if (!database) {
    unsafe.push('MONGODB_URI names no database, so the driver would silently use "test". Add /evcms_prod before the query string.');
  } else if (database === 'ev_cms') {
    unsafe.push('MONGODB_URI points at the DEVELOPMENT database "ev_cms". Production must use its own database.');
  }

  if (!process.env.CORS_ORIGIN?.trim()) {
    unsafe.push('CORS_ORIGIN is not set, so it would default to http://localhost:3000. Set it to the deployed frontend origin.');
  }
  for (const origin of env.corsOrigins) {
    if (!origin.startsWith('https://') || /localhost|127\.0\.0\.1/.test(origin)) {
      unsafe.push(`CORS_ORIGIN entry "${origin}" is not an https production origin.`);
    }
  }

  if (env.jwtSecret.length < 32) {
    unsafe.push('JWT_SECRET is shorter than 32 characters. Generate a new random one for production.');
  }

  // Without BOTH, payments silently fall back to a stub whose signing secret is in the public
  // source: anyone could sign their own "payment" and credit a wallet.
  if (!env.razorpayKeyId || !env.razorpayKeySecret) {
    unsafe.push('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are both required in production (stub payments are never allowed there).');
  } else if (!env.razorpayKeyId.startsWith('rzp_test_')) {
    unsafe.push('RAZORPAY_KEY_ID must be an rzp_test_ key.');
  }
}

if (unsafe.length > 0) {
  for (const problem of unsafe) logger.error(SCOPE, problem);
  logger.error(SCOPE, 'Refusing to start with unsafe configuration.');
  process.exit(1);
}

// Keep `required` referenced for use by later modules (JWT_SECRET in Module 1, etc.)
export { required as requiredEnv };
