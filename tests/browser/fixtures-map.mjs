import { fileURLToPath } from 'url';
/* Module 14 demo data: three real Delhi-NCR stations for the seeded Livanto company, plus
 * one with its coordinates deliberately removed, and a second company's station so the
 * driver view has something cross-company to prove. Prints the logins to use. */

import { createRequire } from 'module';
const require = createRequire(new URL('../../backend/', import.meta.url));
const mongoose = require('mongoose');
require('dotenv').config({ path: fileURLToPath(new URL('../../backend/.env', import.meta.url)) });

const BASE = 'http://localhost:5000/api/v1';

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

const su = (await must('POST', '/auth/login', { body: { email: 'admin@evcms.local', password: 'Admin@12345' } })).token;

const companies = (await must('GET', '/companies?limit=50', { token: su })).items;
/*
 * EXACT names, not `includes`.
 *
 * `company.test.mjs` creates companies called "Livanto Green <timestamp>" as test fixtures.
 * A substring match picked one of those instead of the real seeded company, so these demo
 * stations were created under a company nobody can log into — and the map showed nothing.
 */
const livanto = companies.find((c) => c.name === 'Livanto Green');
const sharma = companies.find((c) => c.name === 'Sharma Energy');
if (!livanto || !sharma) throw new Error('Seeded demo companies not found - run npm run seed:demo');

const SITES = [
  { company: livanto.id, name: 'Noida Sector 62 Hub', code: 'MAP-NOI-01', address: 'C-56 Sector 62', city: 'Noida', state: 'Uttar Pradesh', lat: 28.6274, lng: 77.3716 },
  { company: livanto.id, name: 'Ghaziabad Vaishali Point', code: 'MAP-GZB-01', address: 'Vaishali Metro Approach', city: 'Ghaziabad', state: 'Uttar Pradesh', lat: 28.6420, lng: 77.3390 },
  { company: livanto.id, name: 'Gurgaon Cyber Hub Depot', code: 'MAP-GUR-01', address: 'DLF Cyber City Phase 2', city: 'Gurgaon', state: 'Haryana', lat: 28.4950, lng: 77.0890 },
  { company: livanto.id, name: 'Faridabad Unmapped Site', code: 'MAP-FBD-01', address: 'Sector 21C Market', city: 'Faridabad', state: 'Haryana', lat: 28.4089, lng: 77.3178 },
  { company: sharma.id, name: 'Sharma Dwarka Charge Park', code: 'MAP-DWK-01', address: 'Sector 12 Dwarka', city: 'Dwarka', state: 'Delhi', lat: 28.5921, lng: 77.0460 },
];

const created = [];
for (const site of SITES) {
  const existing = (await must('GET', `/stations?search=${encodeURIComponent(site.code)}`, { token: su })).items;
  if (existing.length > 0) { created.push(existing[0]); console.log(`exists   ${site.name}`); continue; }

  const station = (await must('POST', '/stations', { token: su, body: {
    name: site.name, stationCode: site.code, address: site.address, city: site.city,
    state: site.state, country: 'India', latitude: site.lat, longitude: site.lng,
    companyId: site.company, contactPhone: '+911140000000',
  } })).station;
  created.push(station);
  console.log(`created  ${site.name}`);
}

/* Give the Noida site two chargers with five connectors, two of them busy, so the
 * availability figure on screen is something other than "all free". */
const noida = created[0];
const existingChargers = (await must('GET', `/chargers?stationId=${noida.id}`, { token: su })).items;

if (existingChargers.length === 0) {
  const a = await must('POST', '/chargers', { token: su, body: { stationId: noida.id, name: 'NOI-CH-A',
    chargerCode: 'MAP-NOI-A', ocppId: 'MAP-NOI-A', manufacturer: 'Delta', model: 'Sim', chargerType: 'DC', powerKw: 60 } });
  const b = await must('POST', '/chargers', { token: su, body: { stationId: noida.id, name: 'NOI-CH-B',
    chargerCode: 'MAP-NOI-B', ocppId: 'MAP-NOI-B', manufacturer: 'Delta', model: 'Sim', chargerType: 'AC', powerKw: 22 } });

  const ids = [];
  for (let n = 1; n <= 3; n += 1) {
    ids.push((await must('POST', `/chargers/${a.charger.id}/connectors`, { token: su,
      body: { connectorNumber: n, connectorType: 'CCS2', powerKw: 60 } })).connector.id);
  }
  for (let n = 1; n <= 2; n += 1) {
    ids.push((await must('POST', `/chargers/${b.charger.id}/connectors`, { token: su,
      body: { connectorNumber: n, connectorType: 'Type2', powerKw: 22 } })).connector.id);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.db.collection('connectors').updateMany(
    { _id: { $in: [ids[0], ids[3]].map((i) => new mongoose.Types.ObjectId(i)) } },
    { $set: { status: 'charging' } },
  );
  console.log('created  2 chargers, 5 connectors (2 charging -> 3 available)');
} else {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('exists   chargers on Noida');
}

/*
 * RE-APPLY the busy connectors on EVERY run, not only when the chargers are created.
 *
 * The dashboard fixture drives a real simulator against a Livanto charger, and its closing
 * StatusNotification resets a connector to `available` — so a second run of this fixture left
 * Noida reading 4 of 5 instead of 3, and the map suite's availability checks failed. Fixtures
 * that only apply their state on first creation are not idempotent, and a suite that depends
 * on them becomes order-dependent.
 */
{
  const noidaChargers = (await must('GET', `/chargers?stationId=${noida.id}`, { token: su })).items;
  const allConnectorIds = [];
  for (const c of noidaChargers) {
    const { connectors } = await must('GET', `/chargers/${c.id}/connectors`, { token: su });
    for (const conn of connectors) allConnectorIds.push(conn.id);
  }

  const db = mongoose.connection.db;
  await db.collection('connectors').updateMany(
    { _id: { $in: allConnectorIds.map((i) => new mongoose.Types.ObjectId(i)) } },
    { $set: { status: 'available' } },
  );
  await db.collection('connectors').updateMany(
    { _id: { $in: allConnectorIds.slice(0, 2).map((i) => new mongoose.Types.ObjectId(i)) } },
    { $set: { status: 'charging' } },
  );
  console.log(`state    ${allConnectorIds.length} connectors on Noida -> 2 charging, ${allConnectorIds.length - 2} available`);
}

/* The deliberately broken one - the API cannot produce this, so it is written directly. */
const unmapped = created.find((s) => s.stationCode === 'MAP-FBD-01');
await mongoose.connection.db.collection('stations').updateOne(
  { _id: new mongoose.Types.ObjectId(unmapped.id) },
  { $unset: { latitude: '', longitude: '' } },
);
console.log('broken   Faridabad Unmapped Site has had its coordinates removed');

await mongoose.disconnect();

console.log('\nStaff : cpo@livanto.local / Cpo@12345   -> should see 4 Livanto stations, 3 mapped');
/*
 * The driver the browser suite signs in as. Created here so the suite is self-sufficient —
 * `npm run test:clean` removes every @test.local account, so it cannot be assumed to exist.
 */
const mapDriverEmail = 'mapdriver@test.local';
const existingDriver = await call('POST', '/auth/login', { body: { email: mapDriverEmail, password: 'MapDriver12345' } });
if (existingDriver.status >= 400) {
  await must('POST', '/auth/register', { body: { name: 'Map Demo Driver', email: mapDriverEmail, password: 'MapDriver12345' } });
  console.log('created  driver ' + mapDriverEmail);
} else {
  console.log('exists   driver ' + mapDriverEmail);
}

console.log('Driver: any registered driver           -> should ALSO see the Sharma station');
