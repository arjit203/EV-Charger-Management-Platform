/**
 * Seed the first `super_admin`.
 *
 * This exists because self-registration can only ever create a `driver` — by design.
 * Someone has to bootstrap the first privileged account, and a script that runs against
 * the database directly is the only trustworthy way to do it without opening a public
 * endpoint that mints admins.
 *
 * Run:  npm run seed:admin
 * Override the defaults with env vars or arguments:
 *   npm run seed:admin -- --email=admin@evcms.dev --password=Secret123 --name="Platform Admin"
 *
 * Idempotent: running it twice does not create a duplicate or change an existing password.
 */

import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../config/db';
import { User } from '../models/user.model';
import { ROLES } from '../constants/roles';
import { logger } from '../utils/logger';

const SCOPE = 'seed:admin';

/** Read `--key=value` from argv, falling back to an env var, then a default. */
function arg(key: string, envKey: string, fallback: string): string {
  const match = process.argv.find((a) => a.startsWith(`--${key}=`));
  if (match) return match.slice(key.length + 3);
  return process.env[envKey]?.trim() || fallback;
}

async function main(): Promise<void> {
  const connected = await connectDatabase();
  if (!connected) {
    logger.error(SCOPE, 'Could not connect to MongoDB. Check MONGODB_URI in backend/.env.');
    process.exit(1);
  }

  // Guard rail: this cluster has held more than one project. A seed script must never
  // run against the wrong database, so refuse rather than assume.
  const dbName = mongoose.connection.name;
  if (dbName !== 'ev_cms') {
    logger.error(SCOPE, `Refusing to seed: connected to database "${dbName}", expected "ev_cms".`);
    logger.error(SCOPE, 'Add /ev_cms to MONGODB_URI before the query string, then retry.');
    await disconnectDatabase();
    process.exit(1);
  }

  const email = arg('email', 'SEED_ADMIN_EMAIL', 'admin@evcms.local').toLowerCase();
  const password = arg('password', 'SEED_ADMIN_PASSWORD', 'Admin@12345');
  const name = arg('name', 'SEED_ADMIN_NAME', 'Platform Administrator');

  const existing = await User.findOne({ email }).select('_id role');

  if (existing) {
    logger.info(SCOPE, `User "${email}" already exists (role: ${existing.role}). Nothing to do.`);
  } else {
    const passwordHash = await User.hashPassword(password);

    await User.create({
      name,
      email,
      passwordHash,
      role: ROLES.SUPER_ADMIN,
      status: 'active',
      companyId: null,
    });

    logger.info(SCOPE, `Created super_admin "${email}".`);
    logger.warn(SCOPE, `Password: ${password}  <-- change this after first login.`);
  }

  await disconnectDatabase();
}

main().catch(async (error) => {
  logger.error(SCOPE, 'Seeding failed', error);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
