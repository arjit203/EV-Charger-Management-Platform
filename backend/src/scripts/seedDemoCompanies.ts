/**
 * Seed two companies and their staff, so the company isolation can be exercised by hand
 * in the browser rather than only by the automated suite.
 *
 * Run:  npm run seed:demo
 *
 * Idempotent: existing companies/users are left exactly as they are, including passwords.
 * Requires the super_admin from `npm run seed:admin` to exist first (companies record who
 * created them).
 */

import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../config/db';
import { Company } from '../models/company.model';
import { User } from '../models/user.model';
import { ROLES } from '../constants/roles';
import { logger } from '../utils/logger';

const SCOPE = 'seed:demo';

const DEMO = [
  {
    name: 'Livanto Green',
    legalName: 'Livanto Green Energy Pvt Ltd',
    contactEmail: 'ops@livanto.local',
    address: { line1: '1 Connaught Place', city: 'New Delhi', state: 'Delhi', country: 'India', postalCode: '110001' },
    staff: [
      { name: 'Livanto CPO Admin', email: 'cpo@livanto.local', role: ROLES.CPO_ADMIN, password: 'Cpo@12345' },
      { name: 'Livanto Operator', email: 'ops@livanto.local', role: ROLES.OPERATOR, password: 'Ops@12345' },
    ],
  },
  {
    name: 'Sharma Energy',
    legalName: 'Sharma Energy Solutions LLP',
    contactEmail: 'ops@sharma.local',
    address: { line1: '22 Andheri East', city: 'Mumbai', state: 'Maharashtra', country: 'India', postalCode: '400069' },
    staff: [
      { name: 'Sharma CPO Admin', email: 'cpo@sharma.local', role: ROLES.CPO_ADMIN, password: 'Cpo@12345' },
      { name: 'Sharma Operator', email: 'ops@sharma.local', role: ROLES.OPERATOR, password: 'Ops@12345' },
    ],
  },
] as const;

async function main(): Promise<void> {
  const connected = await connectDatabase();
  if (!connected) {
    logger.error(SCOPE, 'Could not connect to MongoDB. Check MONGODB_URI in backend/.env.');
    process.exit(1);
  }

  // Same guard rail as seed:admin — never write demo data into the wrong database.
  const dbName = mongoose.connection.name;
  if (dbName !== 'ev_cms') {
    logger.error(SCOPE, `Refusing to seed: connected to database "${dbName}", expected "ev_cms".`);
    await disconnectDatabase();
    process.exit(1);
  }

  const superAdmin = await User.findOne({ role: ROLES.SUPER_ADMIN }).select('_id');
  if (!superAdmin) {
    logger.error(SCOPE, 'No super_admin found. Run `npm run seed:admin` first.');
    await disconnectDatabase();
    process.exit(1);
  }

  for (const demo of DEMO) {
    let company = await Company.findOne({ name: demo.name });

    if (company) {
      logger.info(SCOPE, `Company "${demo.name}" already exists.`);
    } else {
      company = await Company.create({
        name: demo.name,
        legalName: demo.legalName,
        type: 'CPO',
        contactEmail: demo.contactEmail,
        address: demo.address,
        status: 'active',
        createdBy: superAdmin._id,
      });
      logger.info(SCOPE, `Created company "${demo.name}".`);
    }

    for (const member of demo.staff) {
      const existing = await User.findOne({ email: member.email }).select('_id');
      if (existing) {
        logger.info(SCOPE, `  user ${member.email} already exists.`);
        continue;
      }

      await User.create({
        name: member.name,
        email: member.email,
        passwordHash: await User.hashPassword(member.password),
        role: member.role,
        status: 'active',
        companyId: company._id,
      });
      logger.info(SCOPE, `  created ${member.email} (${member.role}) — password: ${member.password}`);
    }
  }

  logger.warn(SCOPE, 'Demo passwords are intentionally weak. Never use this data in production.');
  await disconnectDatabase();
}

main().catch(async (error) => {
  logger.error(SCOPE, 'Seeding failed', error);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
