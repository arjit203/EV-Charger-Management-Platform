/* Remove everything the Module 1-7 check scripts created from ev_cms.
   Matches ONLY the test naming conventions those scripts use. Prints what it removed. */

import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
const require = createRequire(new URL('../backend/', import.meta.url));
const mongoose = require('mongoose');

const env = readFileSync(fileURLToPath(new URL('../backend/.env', import.meta.url)), 'utf8');
const uri = env.split('\n').find((l) => l.startsWith('MONGODB_URI=')).slice('MONGODB_URI='.length).trim();

await mongoose.connect(uri);
const db = mongoose.connection.db;
console.log('database:', db.databaseName);

const testUserEmail = /@test\.local$/;
const testCompanyName = /^(M[0-9]{1,2} |Test |E2E|Check |Probe |Alpha |Beta |Scope |Zeta |Demo Test|Recon |SEC |INT |FAIL |PROBE|Reused code|Fault Co [0-9]|Livanto Green [0-9]|Sharma Energy [0-9])/;
const testStationCode = /^(S[0-9]|M1[3-9]|MAP-|RC|SEC|INT|GHO|DUP|CRX|TRSP|FAIL-|P8-|E2E|E8-|MC-|PRB-|ST-|SC-|TEST)/;
const testChargerCode = /^(C[0-9]|M1[3-9]|MAP-|RCC|SECC|INTC|GHOC|CRX|TRSPC|FAILC|E2EC-|E8C-|PRBC-|CH-|TEST)/;

/*
 * Sessions and readings are NOT wiped wholesale any more. That used to be safe because only
 * check scripts created sessions - but the demo drivers and real sign-ups charge too, and a
 * cleanup that erased their history made the dashboard and analytics go blank. Test sessions
 * are now removed by the orphan sweep below: they belong to a test user or a deleted charger.
 */

const users = await db.collection('users').find({ email: testUserEmail }).toArray();
const userIds = users.map((u) => u._id);

// Module 10. Wallets, ledgers and payment records belong to a user.
const wallets = await db.collection('wallets').find({ userId: { $in: userIds } }).toArray();
const walletIds = wallets.map((w) => w._id);
const wtx = await db.collection('wallettransactions').deleteMany({ userId: { $in: userIds } }).catch(() => ({ deletedCount: 0 }));
const ptx = await db.collection('paymenttransactions').deleteMany({ userId: { $in: userIds } }).catch(() => ({ deletedCount: 0 }));
const wal = await db.collection('wallets').deleteMany({ _id: { $in: walletIds } }).catch(() => ({ deletedCount: 0 }));
console.log(`wallets:          removed ${wal.deletedCount}`);
console.log(`walletTx:         removed ${wtx.deletedCount}`);
console.log(`paymentTx:        removed ${ptx.deletedCount}`);

// Module 11. Complaints belong to the driver who filed them.
const cmp = await db.collection('complaints').deleteMany({ userId: { $in: userIds } }).catch(() => ({ deletedCount: 0 }));
console.log(`complaints:       removed ${cmp.deletedCount}`);

// Module 12. Notifications belong to one user each.
const ntf = await db.collection('notifications').deleteMany({ userId: { $in: userIds } }).catch(() => ({ deletedCount: 0 }));
console.log(`notifications:    removed ${ntf.deletedCount}`);
const vehicles = await db.collection('vehicles').deleteMany({ userId: { $in: userIds } });
const removedUsers = await db.collection('users').deleteMany({ email: testUserEmail });
console.log(`users:            removed ${removedUsers.deletedCount}`);
console.log(`vehicles:         removed ${vehicles.deletedCount}`);

const companies = await db.collection('companies').find({ name: testCompanyName }).toArray();
const companyIds = companies.map((c) => c._id);

// Module 9. Tariffs belong to a company, so they go with it.
const tariffs = await db.collection('tariffs').deleteMany({ companyId: { $in: companyIds } }).catch(() => ({ deletedCount: 0 }));
console.log(`tariffs:          removed ${tariffs.deletedCount}`);

const chargers = await db.collection('chargers').deleteMany({
  $or: [{ companyId: { $in: companyIds } }, { chargerCode: testChargerCode }],
});
const stations = await db.collection('stations').deleteMany({
  $or: [{ companyId: { $in: companyIds } }, { stationCode: testStationCode }],
});
const removedCompanies = await db.collection('companies').deleteMany({ name: testCompanyName });

// Connectors are reachable only through a charger, so any left behind are orphans.
const liveChargerIds = (await db.collection('chargers').find({}, { projection: { _id: 1 } }).toArray()).map((c) => c._id);
const connectors = await db.collection('connectors').deleteMany({ chargerId: { $nin: liveChargerIds } });

console.log(`chargers:         removed ${chargers.deletedCount}`);
console.log(`connectors:       removed ${connectors.deletedCount}`);
console.log(`stations:         removed ${stations.deletedCount}`);
console.log(`companies:        removed ${removedCompanies.deletedCount}`);

/*
 * ORPHAN SWEEP - added in Module 16, after an integrity check found 48 notifications
 * pointing at users that no longer existed.
 *
 * Deleting a user's dependent rows at deletion time only covers users matched in THAT run.
 * Anything left behind by an earlier run, an interrupted run, or a run from before a
 * collection existed simply accumulates. Sweeping by "does the parent still exist" catches
 * all of it, regardless of how it got there.
 */
const liveUsers = new Set(
  (await db.collection('users').find({}, { projection: { _id: 1 } }).toArray()).map((u) => String(u._id)),
);
const liveChargersForOrphans = new Set(
  (await db.collection('chargers').find({}, { projection: { _id: 1 } }).toArray()).map((c) => String(c._id)),
);
// Sessions first - the readings, payments and complaints swept below hang off them.
{
  const rows = await db.collection('chargingsessions').find({}, { projection: { userId: 1, chargerId: 1 } }).toArray();
  const dead = rows
    .filter((r) => !liveUsers.has(String(r.userId)) || !liveChargersForOrphans.has(String(r.chargerId)))
    .map((r) => r._id);
  if (dead.length > 0) await db.collection('chargingsessions').deleteMany({ _id: { $in: dead } });
  console.log(`chargingsessions: removed ${dead.length} (test users / deleted chargers)`);
}
const liveSessions = new Set(
  (await db.collection('chargingsessions').find({}, { projection: { _id: 1 } }).toArray()).map((s) => String(s._id)),
);
const liveCompanies = new Set(
  (await db.collection('companies').find({}, { projection: { _id: 1 } }).toArray()).map((c) => String(c._id)),
);

console.log('\norphans swept:');
for (const [collection, field, live] of [
  ['notifications', 'userId', liveUsers],
  ['wallets', 'userId', liveUsers],
  ['wallettransactions', 'userId', liveUsers],
  ['paymenttransactions', 'userId', liveUsers],
  ['complaints', 'userId', liveUsers],
  ['vehicles', 'userId', liveUsers],
  ['chargingsessions', 'userId', liveUsers],
  ['meterreadings', 'sessionId', liveSessions],
  /* Money that points at a session which no longer exists. Cleanup wipes every charging
   * session, but the DEMO drivers are kept (@driver.local, not @test.local) — so without
   * this their payments survived and reported revenue for sessions that were gone. */
  ['paymenttransactions', 'chargingSessionId', liveSessions],
  ['complaints', 'chargingSessionId', liveSessions],
  ['connectors', 'chargerId', liveChargersForOrphans],
  ['complaints', 'companyId', liveCompanies],
  ['complaints', 'chargerId', liveChargersForOrphans],
]) {
  const rows = await db.collection(collection).find({}, { projection: { [field]: 1 } }).toArray().catch(() => []);
  const orphans = rows.filter((r) => r[field] && !live.has(String(r[field]))).map((r) => r._id);
  if (orphans.length > 0) await db.collection(collection).deleteMany({ _id: { $in: orphans } });
  console.log(`  ${collection.padEnd(20)} ${orphans.length}`);
}

/*
 * Notifications whose SUBJECT is gone - a "New complaint" for a deleted complaint, a fault
 * alert for a deleted charger. Their owner still exists, so the userId sweep keeps them, and
 * clicking one opened a dead record. Matched by referenceType -> the collection it points at.
 */
{
  const targets = { complaint: 'complaints', charger: 'chargers', charging_session: 'chargingsessions' };
  let removed = 0;
  for (const [type, collection] of Object.entries(targets)) {
    const live = new Set(
      (await db.collection(collection).find({}, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id)),
    );
    const rows = await db.collection('notifications').find({ referenceType: type }, { projection: { referenceId: 1 } }).toArray();
    const dead = rows.filter((r) => !live.has(String(r.referenceId))).map((r) => r._id);
    if (dead.length > 0) await db.collection('notifications').deleteMany({ _id: { $in: dead } });
    removed += dead.length;
  }
  console.log(`  ${'notifications (ref)'.padEnd(20)} ${removed}`);
}

console.log('\nremaining:');
for (const name of ['users', 'companies', 'stations', 'chargers', 'connectors', 'vehicles', 'chargingsessions', 'meterreadings', 'tariffs', 'wallets', 'wallettransactions', 'paymenttransactions', 'complaints', 'notifications']) {
  const count = await db.collection(name).countDocuments().catch(() => 0);
  console.log(`  ${name.padEnd(18)} ${count}`);
}

const remainingUsers = await db.collection('users').find({}, { projection: { email: 1, role: 1 } }).toArray();
console.log('\nusers kept:', remainingUsers.map((u) => `${u.email} (${u.role})`).join(', ') || 'none');

await mongoose.disconnect();
