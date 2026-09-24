/* MODULE 14 - Charging Station Map (backend surface).
 *
 * The map's UI is verified in a browser by hand. What IS automated is everything with an
 * HTTP surface, and above all the two things this module could get dangerously wrong:
 *
 *   1. /stations/public is the project's FIRST deliberately cross-company read. Its payload
 *      must carry NO company identity, asserted by KEY SET rather than by spot-check.
 *   2. It must respect company SUSPENSION even though it does not company-SCOPE - a
 *      suspended CPO's active station must vanish from driver discovery.
 */

import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(new URL('../../backend/', import.meta.url));
const mongoose = require('mongoose');
require('dotenv').config({ path: fileURLToPath(new URL('../../backend/.env', import.meta.url)) });

const BASE = process.env.BASE || 'http://localhost:5000/api/v1';
const S = String(Date.now()).slice(-6);
const PW = 'MapModule14Pass';

let passed = 0;
let failed = 0;
const fails = [];

function chk(label, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (ok) { passed += 1; console.log(`  PASS  ${label}`); }
  else {
    failed += 1; fails.push(label);
    console.log(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
  }
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

const names = (list) => list.map((s) => s.name).sort();
const byName = (list, n) => list.find((s) => s.name === n);

/* /stations/public is GLOBAL by design - it is the one read that is not company-scoped, so
 * it also returns fixtures left behind by earlier runs. Assertions against it must therefore
 * be about THIS run's stations, not about an exact global set. `mine()` is that filter, and
 * needing it is itself a small confirmation that the endpoint really is cross-company. */
const mine = (list) => names(list.filter((s) => s.name.includes(S)));

/* ------------------------------------------------------------------- setup */

console.log('\n================ MODULE 14 - STATION MAP ================');

const su = (await must('POST', '/auth/login', { body: { email: 'admin@evcms.local', password: 'Admin@12345' } })).token;

async function makeCompany(tag) {
  const company = (await must('POST', '/companies', { token: su, body: { name: `M14 ${tag} ${S}`, type: 'CPO' } })).company;
  const tariff = (await must('POST', '/tariffs', { token: su, body: { name: 'Standard DC', pricePerKwh: 12, companyId: company.id } })).tariff;
  await must('PATCH', `/tariffs/${tariff.id}/status`, { token: su, body: { status: 'active' } });
  return company;
}
async function makeUser(tag, role, companyId) {
  const email = `${tag}.m14.${S}@test.local`;
  await must('POST', '/users', { token: su, body: { name: `M14 ${tag}`, email, password: PW, role, companyId } });
  return (await must('POST', '/auth/login', { body: { email, password: PW } })).token;
}
/* The address deliberately contains NEITHER the station code NOR the city. An earlier
 * version built it as `${code} Map Road`, which made the "driver search does not match
 * station codes" assertion meaningless - the code matched through the ADDRESS instead.
 * Keeping the three fields textually disjoint is what lets each one be tested separately. */
let addressCounter = 0;
async function makeStation(companyId, name, code, city, lat, lng) {
  addressCounter += 1;
  return (await must('POST', '/stations', { token: su, body: {
    name, stationCode: code, address: `${addressCounter} Charging Lane`, city,
    state: 'Uttar Pradesh', country: 'India', latitude: lat, longitude: lng, companyId,
    contactPhone: '+919000000000',
  } })).station;
}

/* Company ALPHA - stays active. Three stations across Delhi NCR, one inactive. */
const alpha = await makeCompany('Alpha');
const cpoAlpha = await makeUser('cpoalpha', 'cpo_admin', alpha.id);
const opAlpha = await makeUser('opalpha', 'operator', alpha.id);

const noida = await makeStation(alpha.id, `M14 Noida Hub ${S}`, `M14N-${S}`, 'Noida', 28.5355, 77.3910);
const ghaziabad = await makeStation(alpha.id, `M14 Ghaziabad Point ${S}`, `M14G-${S}`, 'Ghaziabad', 28.6692, 77.4538);
const gurgaon = await makeStation(alpha.id, `M14 Gurgaon Depot ${S}`, `M14R-${S}`, 'Gurgaon', 28.4595, 77.0266);

/* Company BETA - a rival, stays active. One station, so drivers must see it too. */
const beta = await makeCompany('Beta');
const cpoBeta = await makeUser('cpobeta', 'cpo_admin', beta.id);
const betaStation = await makeStation(beta.id, `M14 Beta Faridabad ${S}`, `M14B-${S}`, 'Faridabad', 28.4089, 77.3178);

/* Company GAMMA - will be SUSPENDED. Its station stays individually 'active'. */
const gamma = await makeCompany('Gamma');
const gammaStation = await makeStation(gamma.id, `M14 Gamma Meerut ${S}`, `M14M-${S}`, 'Meerut', 28.9845, 77.7064);

const driverEmail = `driver.m14.${S}@test.local`;
await must('POST', '/auth/register', { body: { name: 'M14 Driver', email: driverEmail, password: PW } });
const driver = (await must('POST', '/auth/login', { body: { email: driverEmail, password: PW } })).token;

/* Chargers + connectors on Noida: 5 connectors total, 2 will be made unavailable. */
const chargerA = await must('POST', '/chargers', { token: su, body: { stationId: noida.id, name: 'CH-A',
  chargerCode: `M14CA-${S}`, ocppId: `M14CA-${S}`, manufacturer: 'Delta', model: 'Sim', chargerType: 'DC', powerKw: 60 } });
const chargerB = await must('POST', '/chargers', { token: su, body: { stationId: noida.id, name: 'CH-B',
  chargerCode: `M14CB-${S}`, ocppId: `M14CB-${S}`, manufacturer: 'Delta', model: 'Sim', chargerType: 'AC', powerKw: 22 } });

const connectors = [];
for (let n = 1; n <= 3; n += 1) {
  connectors.push((await must('POST', `/chargers/${chargerA.charger.id}/connectors`, { token: su,
    body: { connectorNumber: n, connectorType: 'CCS2', powerKw: 60 } })).connector);
}
for (let n = 1; n <= 2; n += 1) {
  connectors.push((await must('POST', `/chargers/${chargerB.charger.id}/connectors`, { token: su,
    body: { connectorNumber: n, connectorType: 'Type2', powerKw: 22 } })).connector);
}

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const oid = (v) => new mongoose.Types.ObjectId(v);

/* Two connectors set to 'charging' directly - Module 6 owns this transition over OCPP, and
 * this test is about the COUNT, not about the protocol that produces it. */
await db.collection('connectors').updateMany(
  { _id: { $in: [oid(connectors[0].id), oid(connectors[3].id)] } },
  { $set: { status: 'charging' } },
);

/* =========================================================================
 * 1. STAFF MAP
 * ========================================================================= */

section('1. STAFF MAP - company-scoped markers');

{
  const map = await must('GET', '/stations/map', { token: cpoAlpha });

  chk('alpha admin sees their three stations', 3, map.stations.length);
  chk('and they are the right three',
    [`M14 Ghaziabad Point ${S}`, `M14 Gurgaon Depot ${S}`, `M14 Noida Hub ${S}`], names(map.stations));
  chk('the rival station is absent', undefined, byName(map.stations, `M14 Beta Faridabad ${S}`));
  chk('not truncated', false, map.truncated);

  const n = byName(map.stations, `M14 Noida Hub ${S}`);
  chk('coordinates survive the round trip', [28.5355, 77.391], [n.latitude, n.longitude]);
  chk('staff marker carries the company id', alpha.id, n.companyId);
  chk('staff marker carries the station code', `M14N-${S}`, n.stationCode);
  chk('staff marker carries city', 'Noida', n.city);

  const beta = await must('GET', '/stations/map', { token: cpoBeta });
  chk('beta admin sees only their own', [`M14 Beta Faridabad ${S}`], names(beta.stations));

  const op = await must('GET', '/stations/map', { token: opAlpha });
  chk('operator sees the same company scope as their admin', 3, op.stations.length);

  const platform = await must('GET', `/stations/map?companyId=${beta.id ?? ''}`.replace('?companyId=', `?companyId=${betaStation.companyId}`), { token: su });
  chk('super_admin can narrow to one company', [`M14 Beta Faridabad ${S}`], names(platform.stations));
}

section('2. AVAILABILITY COUNTS - fixture: 5 connectors, 2 charging');

{
  const map = await must('GET', '/stations/map', { token: cpoAlpha });
  const n = byName(map.stations, `M14 Noida Hub ${S}`);

  chk('two chargers counted', 2, n.chargers);
  chk('five connectors total', 5, n.totalConnectors);
  chk('exactly three available', 3, n.availableConnectors);
  chk('neither charger is online (no simulator attached)', 0, n.chargersOnline);

  const empty = byName(map.stations, `M14 Gurgaon Depot ${S}`);
  chk('a station with no chargers reads 0, not undefined', 0, empty.chargers);
  chk('and 0 connectors, not undefined', 0, empty.totalConnectors);
  chk('and 0 available', 0, empty.availableConnectors);

  /* A charger in maintenance has no usable plugs, so its connectors leave the count. */
  await db.collection('chargers').updateOne(
    { _id: oid(chargerB.charger.id) }, { $set: { status: 'maintenance' } });

  const after = byName((await must('GET', '/stations/map', { token: cpoAlpha })).stations, `M14 Noida Hub ${S}`);
  chk('maintenance charger removes its connectors from AVAILABLE', 2, after.availableConnectors);
  chk('but TOTAL connectors is unchanged - the hardware still exists', 5, after.totalConnectors);

  await db.collection('chargers').updateOne(
    { _id: oid(chargerB.charger.id) }, { $set: { status: 'available' } });
}

/* =========================================================================
 * 3. DRIVER DISCOVERY - the cross-company read
 * ========================================================================= */

section('3. DRIVER DISCOVERY - cross-company, and what it must not leak');

{
  const pub = await must('GET', '/stations/public', { token: driver });
  const found = names(pub.stations);

  chk('a driver sees ALPHA stations', true, found.includes(`M14 Noida Hub ${S}`));
  chk('a driver ALSO sees the rival company station', true, found.includes(`M14 Beta Faridabad ${S}`));
  chk('this is a genuine cross-company read', true,
    found.includes(`M14 Noida Hub ${S}`) && found.includes(`M14 Beta Faridabad ${S}`));

  const n = byName(pub.stations, `M14 Noida Hub ${S}`);

  /* THE KEY-SET ASSERTION. Not "companyId is undefined" - the EXACT set of keys, so a
   * field added to the shape later cannot leak silently. */
  /* `operatorName` is in the set ON PURPOSE: the operator's brand name is public in every real
   * charging app (OCPI's Location.operator). The company's ID and records are what stay out. */
  chk('driver payload key set is exactly the documented one',
    ['address', 'availableConnectors', 'chargers', 'chargersOnline', 'city', 'id', 'latitude',
     'longitude', 'name', 'operatorName', 'state', 'status', 'totalConnectors'],
    Object.keys(n).sort());
  chk('the operator is named', true, typeof n.operatorName === 'string' && n.operatorName.length > 0);

  chk('no companyId', false, 'companyId' in n);
  chk('no stationCode', false, 'stationCode' in n);
  chk('no createdBy', false, 'createdBy' in n);
  chk('no contactPhone', false, 'contactPhone' in n);
  chk('no createdAt', false, 'createdAt' in n);
  chk('no updatedAt', false, 'updatedAt' in n);
  // The operator's brand is published ONLY as `operatorName` — nowhere else in the payload.
  chk('the company name appears only as the operator brand', true,
    JSON.stringify({ ...pub, stations: pub.stations.map(({ operatorName, ...rest }) => rest) }).includes('M14 Alpha') === false);
  chk('and that brand is the owning company', true, String(n.operatorName).startsWith('M14 Alpha'));

  chk('but the driver DOES get what they need - availability', 3, n.availableConnectors);
  chk('and coordinates', [28.5355, 77.391], [n.latitude, n.longitude]);
  chk('and an address', '1 Charging Lane', n.address);
}

section('4. INACTIVE STATIONS ARE NOT ADVERTISED');

{
  await must('PATCH', `/stations/${ghaziabad.id}/status`, { token: su, body: { status: 'inactive' } });

  const pub = await must('GET', '/stations/public', { token: driver });
  chk('an inactive station disappears from driver discovery', false,
    names(pub.stations).includes(`M14 Ghaziabad Point ${S}`));

  const map = await must('GET', '/stations/map', { token: cpoAlpha });
  chk('but staff still see it on the admin map', true,
    names(map.stations).includes(`M14 Ghaziabad Point ${S}`));
  chk('and its status is reported honestly', 'inactive',
    byName(map.stations, `M14 Ghaziabad Point ${S}`).status);

  await must('PATCH', `/stations/${ghaziabad.id}/status`, { token: su, body: { status: 'active' } });
}

section('5. THE TWO-LEVEL FILTER - company suspension reaches the one unscoped read');

{
  const before = await must('GET', '/stations/public', { token: driver });
  chk('the gamma station is advertised while its company is active', true,
    names(before.stations).includes(`M14 Gamma Meerut ${S}`));

  await must('PATCH', `/companies/${gamma.id}/status`, { token: su, body: { status: 'suspended' } });

  const stillActive = await db.collection('stations').findOne({ _id: oid(gammaStation.id) });
  chk('the STATION itself is still individually active', 'active', stillActive.status);

  const after = await must('GET', '/stations/public', { token: driver });
  chk('yet it VANISHES from driver discovery - company suspension wins', false,
    names(after.stations).includes(`M14 Gamma Meerut ${S}`));
  chk('the other companies are unaffected', true,
    names(after.stations).includes(`M14 Noida Hub ${S}`) &&
    names(after.stations).includes(`M14 Beta Faridabad ${S}`));

  await must('PATCH', `/companies/${gamma.id}/status`, { token: su, body: { status: 'active' } });
  chk('reactivating the company brings it back', true,
    names((await must('GET', '/stations/public', { token: driver })).stations).includes(`M14 Gamma Meerut ${S}`));
}

/* =========================================================================
 * 6. AUTHORIZATION
 * ========================================================================= */

section('6. AUTHORIZATION');

{
  chk('a driver CANNOT reach the staff map', 403, (await call('GET', '/stations/map', { token: driver })).status);
  chk('a driver still cannot list stations administratively', 403,
    (await call('GET', '/stations', { token: driver })).status);
  chk('a driver still cannot read one station administratively', 403,
    (await call('GET', `/stations/${noida.id}`, { token: driver })).status);
  chk('an anonymous caller cannot reach the staff map', 401, (await call('GET', '/stations/map')).status);
  chk('an anonymous caller cannot reach discovery either - public means CONTENT', 401,
    (await call('GET', '/stations/public')).status);

  chk('every staff role can reach discovery too', [200, 200, 200],
    [(await call('GET', '/stations/public', { token: su })).status,
     (await call('GET', '/stations/public', { token: cpoAlpha })).status,
     (await call('GET', '/stations/public', { token: opAlpha })).status]);

  const probe = await call('GET', `/stations/map?companyId=${beta.id}`, { token: cpoAlpha });
  chk('a cpo_admin naming a rival on the map is REFUSED, not silently rescoped', 403, probe.status);
}

section('7. ROUTE ORDERING - /map and /public are routes, not station ids');

{
  const map = await call('GET', '/stations/map', { token: cpoAlpha });
  const pub = await call('GET', '/stations/public', { token: driver });
  chk('/stations/map did not fall through to the :stationId validator', 200, map.status);
  chk('/stations/public did not either', 200, pub.status);
  chk('a genuinely malformed station id still 400s', 400,
    (await call('GET', '/stations/not-an-id', { token: cpoAlpha })).status);
}

/* =========================================================================
 * 8. SEARCH AND FILTERS
 * ========================================================================= */

section('8. SEARCH AND FILTERS');

{
  const byCity = await must('GET', '/stations/map?city=Noida', { token: cpoAlpha });
  chk('city filter is exact', [`M14 Noida Hub ${S}`], names(byCity.stations));

  const bySearch = await must('GET', `/stations/map?search=Gurgaon`, { token: cpoAlpha });
  chk('search matches the station name', [`M14 Gurgaon Depot ${S}`], names(bySearch.stations));

  const byCode = await must('GET', `/stations/map?search=M14R-${S}`, { token: cpoAlpha });
  chk('staff search also matches the station code', [`M14 Gurgaon Depot ${S}`], names(byCode.stations));

  const byStatus = await must('GET', '/stations/map?status=active', { token: cpoAlpha });
  chk('status filter works', 3, byStatus.stations.length);

  const none = await must('GET', '/stations/map?search=zzz-no-such-station', { token: cpoAlpha });
  chk('a no-match search returns an empty array, not an error', [], none.stations);
  chk('and is still a well-formed envelope', false, none.truncated);

  const driverCity = await must('GET', '/stations/public?city=Faridabad', { token: driver });
  chk('a driver can filter by city across companies', [`M14 Beta Faridabad ${S}`], mine(driverCity.stations));

  const driverSearch = await must('GET', '/stations/public?search=Meerut', { token: driver });
  chk('driver search matches city as well as name', [`M14 Gamma Meerut ${S}`], mine(driverSearch.stations));

  const codeProbe = await must('GET', `/stations/public?search=M14N-${S}`, { token: driver });
  chk('driver search does NOT match station codes - it never returns them', [], mine(codeProbe.stations));
}

section('9. VALIDATION');

{
  chk('unknown query parameter is rejected on the staff map', 400,
    (await call('GET', '/stations/map?zoom=12', { token: cpoAlpha })).status);
  chk('a driver cannot ask for a company', 400,
    (await call('GET', `/stations/public?companyId=${alpha.id}`, { token: driver })).status);
  chk('a driver cannot ask for inactive stations', 400,
    (await call('GET', '/stations/public?status=inactive', { token: driver })).status);
  chk('limit is bounded', 400, (await call('GET', '/stations/map?limit=9999', { token: cpoAlpha })).status);
  chk('limit of 0 is rejected', 400, (await call('GET', '/stations/map?limit=0', { token: cpoAlpha })).status);
  chk('a valid limit is honoured', 1,
    (await must('GET', '/stations/map?limit=1', { token: cpoAlpha })).stations.length);
  chk('and truncation is REPORTED rather than hidden', true,
    (await must('GET', '/stations/map?limit=1', { token: cpoAlpha })).truncated);
}

section('10. BROKEN COORDINATES DO NOT REACH THE MAP AS GARBAGE');

{
  /* The API cannot produce this: latitude/longitude are `required` with min/max on the
   * schema. Written directly to prove the endpoint stays up and the frontend guard has
   * something real to defend against. */
  await db.collection('stations').updateOne(
    { _id: oid(gurgaon.id) }, { $unset: { latitude: '', longitude: '' } });

  const map = await call('GET', '/stations/map', { token: cpoAlpha });
  chk('the endpoint still returns 200 with a coordinate-less row present', 200, map.status);

  const broken = byName(map.body.data.stations, `M14 Gurgaon Depot ${S}`);
  chk('the station is still listed', true, Boolean(broken));
  chk('and its coordinates come back undefined rather than invented', [undefined, undefined],
    [broken.latitude, broken.longitude]);
  chk('the other stations are unaffected', true,
    Number.isFinite(byName(map.body.data.stations, `M14 Noida Hub ${S}`).latitude));

  await db.collection('stations').updateOne(
    { _id: oid(gurgaon.id) }, { $set: { latitude: 28.4595, longitude: 77.0266 } });
}

/* ---------------------------------------------------------------- teardown */

await mongoose.disconnect();

console.log(`\n================ MODULE 14: ${passed} passed, ${failed} failed ================`);
if (fails.length) {
  console.log('\nFailures:');
  for (const f of fails) console.log(`  - ${f}`);
}
process.exit(failed === 0 ? 0 : 1);
