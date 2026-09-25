/**
 * Which database a seed script is about to write to, and whether it may.
 *
 *   ev_cms      development. Proceeds exactly as before.
 *   evcms_prod  production. Only with SEED_CONFIRM_DB=evcms_prod set for that one command, and
 *               never when backend/.env itself points there: the production URI belongs in
 *               Render, and a one-off seed passes it in the shell.
 *   anything    refused.
 *
 * DECIDED BEFORE CONNECTING, from the URI. Mongoose builds every model's indexes the moment a
 * connection opens, so a check made after connecting would still have created the database it
 * then refused — a mistaken `evcms_prod` target would have brought production into existence
 * with the wrong credentials. The name is confirmed once more after the connection is up.
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../config/db';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export const DEVELOPMENT_DB = 'ev_cms';
export const PRODUCTION_DB = 'evcms_prod';

const MIN_PRODUCTION_PASSWORD_LENGTH = 12;
/** Printed in the README and the development seed output, so public. */
const KNOWN_DEMO_PASSWORDS = ['Admin@12345', 'Cpo@12345', 'Ops@12345', 'Driver@12345'];

export interface SeedTarget {
  dbName: string;
  isProduction: boolean;
  /** The validated production password, when one was required. Null in development. */
  productionPassword: string | null;
}

/** A password a production seed must be given, checked BEFORE connecting (never logged). */
export interface ProductionPasswordRequirement {
  envKey: string;
  value: string | undefined;
}

async function refuse(scope: string, lines: string[]): Promise<never> {
  for (const line of lines) logger.error(scope, line);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
}

/** The database a MongoDB URI names — `test` when it names none, which is what the driver uses. */
function databaseNamedIn(uri: string): string {
  return /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/.exec(uri)?.[1] || 'test';
}

/** The database named in backend/.env's own MONGODB_URI, ignoring anything set in the shell. */
function databaseInLocalEnvFile(): string | null {
  const file = path.resolve(__dirname, '../../.env');
  if (!fs.existsSync(file)) return null;
  const uri = dotenv.parse(fs.readFileSync(file)).MONGODB_URI ?? '';
  return uri ? databaseNamedIn(uri) : null;
}

/**
 * Decide the target from the URI, then connect. Use INSTEAD of `connectDatabase()` in a seed
 * script. Exits the process — without ever connecting — when the target is not allowed or a
 * required production password is missing or weak.
 */
export async function connectSeedTarget(
  scope: string,
  production?: ProductionPasswordRequirement,
): Promise<SeedTarget> {
  if (!env.mongodbUri) {
    return refuse(scope, ['MONGODB_URI is empty. Set it in backend/.env (development) and retry.']);
  }

  const intended = databaseNamedIn(env.mongodbUri);
  let isProduction = false;

  if (intended === PRODUCTION_DB) {
    if (databaseInLocalEnvFile() === PRODUCTION_DB) {
      await refuse(scope, [
        `backend/.env points at the production database "${PRODUCTION_DB}". It must not.`,
        'Keep backend/.env on ev_cms and pass the production MONGODB_URI in the shell for this one command.',
      ]);
    }
    if (process.env.SEED_CONFIRM_DB !== PRODUCTION_DB) {
      await refuse(scope, [
        `MONGODB_URI names the PRODUCTION database "${PRODUCTION_DB}". Seeding it is opt-in.`,
        `Set SEED_CONFIRM_DB=${PRODUCTION_DB} for this command if that is what you meant.`,
      ]);
    }
    isProduction = true;
  } else if (intended !== DEVELOPMENT_DB) {
    await refuse(scope, [
      `Refusing to seed: MONGODB_URI names database "${intended}", expected "${DEVELOPMENT_DB}".`,
      `Add /${DEVELOPMENT_DB} to MONGODB_URI before the query string, then retry.`,
    ]);
  }

  // Before connecting, for the same reason as everything above.
  const productionPassword =
    isProduction && production
      ? await requireProductionPassword(scope, production.envKey, production.value)
      : null;

  if (!(await connectDatabase())) {
    return refuse(scope, ['Could not connect to MongoDB. Check MONGODB_URI.']);
  }

  // Belt and braces: the driver must agree with what the URI was read as.
  const dbName = mongoose.connection.name;
  if (dbName !== intended) {
    await refuse(scope, [`Connected to "${dbName}", but MONGODB_URI was read as "${intended}". Refusing.`]);
  }

  if (isProduction) logger.warn(scope, `Seeding the PRODUCTION database "${PRODUCTION_DB}".`);
  return { dbName, isProduction, productionPassword };
}

/** A production password must be supplied, long enough and not a published demo one. Never logged. */
async function requireProductionPassword(
  scope: string,
  envKey: string,
  value?: string,
): Promise<string> {
  const password = value?.trim() ?? '';
  if (password.length < MIN_PRODUCTION_PASSWORD_LENGTH || KNOWN_DEMO_PASSWORDS.includes(password)) {
    return refuse(scope, [
      `${envKey} must be set for a production seed: at least ${MIN_PRODUCTION_PASSWORD_LENGTH} characters, and not a demo password.`,
    ]);
  }
  return password;
}
