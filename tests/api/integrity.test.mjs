/* DATA INTEGRITY — the reference chain, asserted end to end.
 *
 * Every record in this system hangs off a chain:
 *
 *   Company -> Station -> Charger -> Connector -> ChargingSession -> MeterReading
 *                                                        |
 *                                                        +-> PaymentTransaction
 *                                                        +-> Complaint
 *                                                        +-> Notification
 *
 * The question this file answers is not "can I create a session?" but "can I create a
 * session that references things which do not belong together?" — a connector from another
 * charger, a charger from another station, a station from another company.
 *
 * Several of these turn out to be UNREPRESENTABLE rather than merely refused, because the
 * API derives the parent instead of accepting it. Where that is true the test says so, since
 * "there is no field to attack" is a stronger guarantee than "the field is validated".
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(new URL('../../backend/', import.meta.url));
const mongoose = require('mongoose');
require('dotenv').config({ path: fileURLToPath(new URL('../../backend/.env', import.meta.url)) });

const BASE = process.env.BASE || 'http://localhost:5000/api/v1';
const S = String(Date.now()).slice(-6);
const PW = 'Integrity16Pass';

let passed = 0, failed = 0;
const fails = [];
function chk(label, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (ok) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`); }
}
function chkRefused(label, status) {
  const ok = status >= 400 && status < 500;
  if (ok) { passed += 1; console.log(`  PASS  ${label}  (${status})`); }
  else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}\n        expected a 4xx refusal, got ${status}`); }
}
const section = (t) => console.log(`\n--- ${t} ---`);

const call = async (m, p, o = {}) => {
  const h = { 'Content-Type': 'application/json' };
  if (o.token) h.Authorization = `Bearer ${o.token}`;
  const r = await fetch(BASE + p, { method: m, headers: h, body: o.body && JSON.stringify(o.body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const must = async (m, p, o) => {
  const r = await call(m, p, o);
  if (r.status >= 400) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
};

const GHOST = '0'.repeat(24); // a well-formed ObjectId that references nothing

console.log('\n================ DATA INTEGRITY ================');

const su = (await must('POST', '/auth/login', { body: { email: 'admin@evcms.local', password: 'Admin@12345' } })).token;

async function build(tag) {
  const company = (await must('POST', '/companies', { token: su, body: { name: `INT ${tag} ${S}`, type: 'CPO' } })).company;
  const tariff = (await must('POST', '/tariffs', { token: su, body: { name: 'Std', pricePerKwh: 12, companyId: company.id } })).tariff;
  await must('PATCH', `/tariffs/${tariff.id}/status`, { token: su, body: { status: 'active' } });
  const station = (await must('POST', '/stations', { token: su, body: {
    name: `INT ${tag} Station ${S}`, stationCode: `INT${tag}-${S}`, address: '1 Chain Road',
    city: 'Delhi', state: 'Delhi', country: 'India', latitude: 28.6, longitude: 77.2,
    companyId: company.id } })).station;
  const charger = await must('POST', '/chargers', { token: su, body: {
    stationId: station.id, name: `INT-${tag}`, chargerCode: `INTC${tag}-${S}`,
    ocppId: `INT${tag}-${S}`, manufacturer: 'D', model: 'S', chargerType: 'DC', powerKw: 60 } });
  const connector = (await must('POST', `/chargers/${charger.charger.id}/connectors`, { token: su,
    body: { connectorNumber: 1, connectorType: 'CCS2', powerKw: 60 } })).connector;

  const email = `cpo.${tag.toLowerCase()}.int${S}@test.local`;
  await must('POST', '/users', { token: su, body: { name: `INT CPO ${tag}`, email, password: PW, role: 'cpo_admin', companyId: company.id } });
  const cpo = (await must('POST', '/auth/login', { body: { email, password: PW } })).token;

  return { company, station, charger: charger.charger, connector, tariff, cpo };
}

const A = await build('A');
const B = await build('B');

const driverEmail = `driver.int${S}@test.local`;
const reg = await must('POST', '/auth/register', { body: { name: 'INT Driver', email: driverEmail, password: PW } });
const driver = (await must('POST', '/auth/login', { body: { email: driverEmail, password: PW } })).token;

console.log('  built two complete chains, company A and company B');

/* =========================================================================
 * 1-3. EVERY LINK MUST POINT AT SOMETHING REAL
 * ========================================================================= */

section('1. A LINK CANNOT POINT AT A GHOST');

chkRefused('a station cannot belong to a company that does not exist',
  (await call('POST', '/stations', { token: su, body: {
    name: `Ghost ${S}`, stationCode: `GHO-${S}`, address: '1 X', city: 'Delhi', state: 'Delhi',
    country: 'India', latitude: 28.6, longitude: 77.2, companyId: GHOST } })).status);

chkRefused('a charger cannot hang off a station that does not exist',
  (await call('POST', '/chargers', { token: su, body: {
    stationId: GHOST, name: 'Ghost', chargerCode: `GHOC-${S}`, ocppId: `GHO-${S}`,
    manufacturer: 'D', model: 'S', chargerType: 'DC', powerKw: 60 } })).status);

chkRefused('a connector cannot hang off a charger that does not exist',
  (await call('POST', `/chargers/${GHOST}/connectors`, { token: su,
    body: { connectorNumber: 1, connectorType: 'CCS2', powerKw: 60 } })).status);

chkRefused('a session cannot reference a connector that does not exist',
  (await call('POST', '/charging/sessions', { token: driver, body: { connectorId: GHOST } })).status);

chkRefused('a complaint cannot reference a session that does not exist',
  (await call('POST', '/complaints', { token: driver, body: {
    category: 'session_issue', subject: 'Ghost session',
    description: 'Referencing a charging session id that does not exist at all.',
    chargingSessionId: GHOST } })).status);

chkRefused('a malformed id is rejected before it reaches the database',
  (await call('GET', '/stations/not-an-object-id', { token: su })).status);

/* =========================================================================
 * 4. THE CHAIN IS DERIVED, NOT SUBMITTED
 * ========================================================================= */

section('2. PARENTS ARE DERIVED, SO THEY CANNOT BE MIXED');

{
  /*
   * A connector is created UNDER its charger (`/chargers/:id/connectors`), so `chargerId` is
   * a path segment rather than a body field. There is no way to create a connector claiming
   * a different parent — the attack has no field to live in.
   */
  const created = (await must('POST', `/chargers/${A.charger.id}/connectors`, { token: su,
    body: { connectorNumber: 5, connectorType: 'Type2', powerKw: 22 } })).connector;
  chk('a connector is always born under its charger', A.charger.id, created.chargerId);

  chk('the body cannot override the parent charger', A.charger.id,
    (await must('POST', `/chargers/${A.charger.id}/connectors`, { token: su, body: {
      connectorNumber: 6, connectorType: 'Type2', powerKw: 22,
      chargerId: B.charger.id } }).catch(() => ({ connector: { chargerId: A.charger.id } })))
      .connector?.chargerId ?? A.charger.id);

  /*
   * A session takes ONE id — the connector — and derives charger, station, company and
   * tariff from it. This is Module 11's "make it unrepresentable" rule applied to Module 7:
   * a mismatched set cannot be submitted because only one member of the set is accepted.
   */
  const started = await call('POST', '/charging/sessions', { token: driver, body: {
    connectorId: A.connector.id, chargerId: B.charger.id, stationId: B.station.id,
    companyId: B.company.id } });
  chkRefused('a session rejects extra parent ids outright (.strict())', started.status);
}

/* =========================================================================
 * 5. CROSS-COMPANY CHAINS
 * ========================================================================= */

section('3. A CHAIN CANNOT CROSS COMPANIES');

chkRefused('company A admin cannot add a connector to company B charger',
  (await call('POST', `/chargers/${B.charger.id}/connectors`, { token: A.cpo,
    body: { connectorNumber: 9, connectorType: 'CCS2', powerKw: 60 } })).status);

chkRefused('company A admin cannot move their charger to company B station',
  (await call('PATCH', `/chargers/${A.charger.id}`, { token: A.cpo,
    body: { stationId: B.station.id } })).status);

chkRefused('company A admin cannot create a charger on company B station',
  (await call('POST', '/chargers', { token: A.cpo, body: {
    stationId: B.station.id, name: 'Cross', chargerCode: `CRX-${S}`, ocppId: `CRX-${S}`,
    manufacturer: 'D', model: 'S', chargerType: 'DC', powerKw: 60 } })).status);

/* =========================================================================
 * 6. UNIQUENESS IS ENFORCED BY THE DATABASE
 * ========================================================================= */

section('4. UNIQUENESS HOLDS AT THE DATABASE, NOT IN AN IF');

chkRefused('a duplicate connector number on one charger is refused',
  (await call('POST', `/chargers/${A.charger.id}/connectors`, { token: su,
    body: { connectorNumber: 1, connectorType: 'CCS2', powerKw: 60 } })).status);

chkRefused('a duplicate ocppId is refused',
  (await call('POST', '/chargers', { token: su, body: {
    stationId: A.station.id, name: 'Dup', chargerCode: `DUP-${S}`, ocppId: A.charger.ocppId,
    manufacturer: 'D', model: 'S', chargerType: 'DC', powerKw: 60 } })).status);

chkRefused('a duplicate station code within a company is refused',
  (await call('POST', '/stations', { token: su, body: {
    name: 'Dup', stationCode: A.station.stationCode, address: '1 X', city: 'Delhi',
    state: 'Delhi', country: 'India', latitude: 28.6, longitude: 77.2,
    companyId: A.company.id } })).status);

chk('but the SAME station code is fine in a different company', 201,
  (await call('POST', '/stations', { token: su, body: {
    name: `Reused code ${S}`, stationCode: A.station.stationCode, address: '1 Y', city: 'Delhi',
    state: 'Delhi', country: 'India', latitude: 28.7, longitude: 77.3,
    companyId: B.company.id } })).status);

chkRefused('a duplicate registration number is refused',
  (await (async () => {
    await must('POST', '/users/me/vehicles', { token: driver, body: {
      make: 'Tata', model: 'Nexon', registrationNumber: `INTV${S}`, connectorType: 'CCS2' } });
    return call('POST', '/users/me/vehicles', { token: driver, body: {
      make: 'MG', model: 'ZS', registrationNumber: `INTV${S}`, connectorType: 'CCS2' } });
  })()).status);

chkRefused('a duplicate email is refused',
  (await call('POST', '/auth/register', { body: {
    name: 'Clone', email: driverEmail, password: PW } })).status);

/* =========================================================================
 * 7. WHAT THE DATABASE ACTUALLY HOLDS
 * ========================================================================= */

section('5. NO ORPHANS AND NO BROKEN LINKS IN THE LIVE DATA');

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const ids = async (name) => new Set((await db.collection(name).find({}, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id)));

const companyIds = await ids('companies');
const stationIds = await ids('stations');
const chargerIds = await ids('chargers');
const connectorIds = await ids('connectors');
const userIds = await ids('users');
const sessionIds = await ids('chargingsessions');

const dangling = async (collection, field, valid) => {
  const rows = await db.collection(collection).find({}).toArray();
  return rows.filter((r) => r[field] && !valid.has(String(r[field]))).length;
};

chk('every station points at a real company', 0, await dangling('stations', 'companyId', companyIds));
chk('every charger points at a real station', 0, await dangling('chargers', 'stationId', stationIds));
chk('every charger points at a real company', 0, await dangling('chargers', 'companyId', companyIds));
chk('every connector points at a real charger', 0, await dangling('connectors', 'chargerId', chargerIds));
chk('every session points at a real user', 0, await dangling('chargingsessions', 'userId', userIds));
chk('every session points at a real connector', 0, await dangling('chargingsessions', 'connectorId', connectorIds));
chk('every session points at a real charger', 0, await dangling('chargingsessions', 'chargerId', chargerIds));
chk('every session points at a real station', 0, await dangling('chargingsessions', 'stationId', stationIds));
chk('every meter reading points at a real session', 0, await dangling('meterreadings', 'sessionId', sessionIds));
chk('every wallet points at a real user', 0, await dangling('wallets', 'userId', userIds));
chk('every payment points at a real user', 0, await dangling('paymenttransactions', 'userId', userIds));
chk('every complaint points at a real user', 0, await dangling('complaints', 'userId', userIds));
chk('every notification points at a real user', 0, await dangling('notifications', 'userId', userIds));

/*
 * SESSION references, not just user references.
 *
 * The first version of this suite checked only that each complaint and payment pointed at a
 * real USER — and missed three complaints whose `chargingSessionId` referenced sessions that
 * had been deleted. A dangling anchor is exactly the inconsistency this file exists to find,
 * so the parent chain is now checked on every optional reference too.
 */
chk('every complaint anchor points at a real session', 0,
  await dangling('complaints', 'chargingSessionId', sessionIds));
chk('every payment points at a real session (where it names one)', 0,
  await dangling('paymenttransactions', 'chargingSessionId', sessionIds));
chk('every complaint points at a real station (where it names one)', 0,
  await dangling('complaints', 'stationId', stationIds));
chk('every complaint points at a real charger (where it names one)', 0,
  await dangling('complaints', 'chargerId', chargerIds));

/*
 * The denormalised companyId on a session must AGREE with the company reached through the
 * station. Module 7 copied it for query performance; if the two ever disagreed, analytics
 * and every scoped list would silently report different things.
 */
{
  const stations = await db.collection('stations').find({}).toArray();
  const stationCompany = new Map(stations.map((s) => [String(s._id), String(s.companyId)]));
  const sessions = await db.collection('chargingsessions').find({}).toArray();
  const mismatched = sessions.filter(
    (s) => stationCompany.get(String(s.stationId)) !== String(s.companyId),
  ).length;
  chk('a session denormalised companyId agrees with its station', 0, mismatched);
}

{
  const chargers = await db.collection('chargers').find({}).toArray();
  const stationCompany = new Map(
    (await db.collection('stations').find({}).toArray()).map((s) => [String(s._id), String(s.companyId)]),
  );
  const mismatched = chargers.filter(
    (c) => stationCompany.get(String(c.stationId)) !== String(c.companyId),
  ).length;
  chk('a charger denormalised companyId agrees with its station', 0, mismatched);
}

await mongoose.disconnect();

console.log(`\n================ DATA INTEGRITY: ${passed} passed, ${failed} failed ================`);
if (fails.length) { console.log('\nFailures:'); for (const f of fails) console.log(`  - ${f}`); }
process.exit(failed === 0 ? 0 : 1);
