/* MODULE 15 - the dashboard's DATA CONTRACT.
 *
 * Module 15 added no backend endpoint, so there is little new API surface to test. What IS
 * worth pinning is the set of calls the dashboard makes on every load: if any of them stops
 * being company-scoped or role-gated, the console silently starts showing the wrong thing to
 * the wrong person.
 *
 * The UI itself (layout, sidebar, live updates, responsive) is verified in a real browser -
 * see browser/dashboard.mjs. This file is only the contract underneath it.
 */

import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(new URL('../../backend/', import.meta.url));
require('dotenv').config({ path: fileURLToPath(new URL('../../backend/.env', import.meta.url)) });

const BASE = process.env.BASE || 'http://localhost:5000/api/v1';
const S = String(Date.now()).slice(-6);
const PW = 'Dashboard15Pass';

let passed = 0, failed = 0;
const fails = [];
function chk(label, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (ok) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`); }
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

/**
 * EVERY CALL THE DASHBOARD MAKES, in one list.
 *
 * Keeping them enumerated here is the point: if a future change adds a fetch to the page, it
 * belongs in this array, and the role matrix below then has to account for it.
 */
const DASHBOARD_CALLS = [
  '/analytics/overview',
  '/analytics/sessions',
  '/analytics/stations?limit=5',
  '/charging/sessions?active=true&limit=10',
  '/charging/sessions?limit=8',
  '/complaints?limit=5',
];

/** The two extra calls made only when the viewer is allowed to see money. */
const REVENUE_CALLS = ['/analytics/revenue', '/payments?limit=5'];

console.log('\n================ MODULE 15 - DASHBOARD DATA CONTRACT ================');

const su = (await must('POST', '/auth/login', { body: { email: 'admin@evcms.local', password: 'Admin@12345' } })).token;

async function makeCompany(tag) {
  const company = (await must('POST', '/companies', { token: su, body: { name: `M15 ${tag} ${S}`, type: 'CPO' } })).company;
  const tariff = (await must('POST', '/tariffs', { token: su, body: { name: 'Standard DC', pricePerKwh: 12, companyId: company.id } })).tariff;
  await must('PATCH', `/tariffs/${tariff.id}/status`, { token: su, body: { status: 'active' } });
  return company;
}
async function makeUser(tag, role, companyId) {
  const email = `${tag}.d15.${S}@test.local`;
  await must('POST', '/users', { token: su, body: { name: `M15 ${tag}`, email, password: PW, role, companyId } });
  return (await must('POST', '/auth/login', { body: { email, password: PW } })).token;
}

const alpha = await makeCompany('DashAlpha');
const beta = await makeCompany('DashBeta');

const cpoAlpha = await makeUser('cpoa', 'cpo_admin', alpha.id);
const opAlpha = await makeUser('opa', 'operator', alpha.id);
const cpoBeta = await makeUser('cpob', 'cpo_admin', beta.id);

const driverEmail = `driver.d15.${S}@test.local`;
await must('POST', '/auth/register', { body: { name: 'M15 Dash Driver', email: driverEmail, password: PW } });
const driver = (await must('POST', '/auth/login', { body: { email: driverEmail, password: PW } })).token;

/* Company ALPHA gets a station so its dashboard has something in it. */
await must('POST', '/stations', { token: su, body: {
  name: `M15 Dash Station ${S}`, stationCode: `M15D-${S}`, address: '1 Console Way',
  city: 'Pune', state: 'Maharashtra', country: 'India',
  latitude: 18.52, longitude: 73.85, companyId: alpha.id } });

/* =========================================================================
 * 1. EVERY DASHBOARD CALL SUCCEEDS FOR EVERY STAFF ROLE
 * ========================================================================= */

section('1. THE DASHBOARD LOADS - every call it makes, for every staff role');

for (const [roleName, token] of [['super_admin', su], ['cpo_admin', cpoAlpha], ['operator', opAlpha]]) {
  const statuses = [];
  for (const endpoint of DASHBOARD_CALLS) {
    statuses.push((await call('GET', endpoint, { token })).status);
  }
  chk(`${roleName}: all ${DASHBOARD_CALLS.length} core dashboard calls return 200`,
    DASHBOARD_CALLS.map(() => 200), statuses);
}

section('2. THE MONEY CALLS ARE GATED - and the dashboard does not make them');

{
  for (const [roleName, token, expected] of [
    ['super_admin', su, [200, 200]],
    ['cpo_admin', cpoAlpha, [200, 200]],
  ]) {
    const statuses = [];
    for (const endpoint of REVENUE_CALLS) statuses.push((await call('GET', endpoint, { token })).status);
    chk(`${roleName} may read revenue and payments`, expected, statuses);
  }

  chk('operator is REFUSED /analytics/revenue', 403,
    (await call('GET', '/analytics/revenue', { token: opAlpha })).status);

  /*
   * The operator's overview must OMIT the revenue key rather than zero it. That distinction is
   * the entire mechanism the dashboard uses to hide the card - `{revenue && <StatCard/>}` -
   * so if this ever became `revenue: {...zeros}` the card would silently reappear.
   */
  const opOverview = await must('GET', '/analytics/overview', { token: opAlpha });
  chk('operator overview has NO revenue key at all', false, 'revenue' in opOverview);
  chk('but it does carry the operational sections', true,
    Boolean(opOverview.fleet && opOverview.sessions && opOverview.complaints));

  const adminOverview = await must('GET', '/analytics/overview', { token: cpoAlpha });
  chk('a cpo_admin overview DOES carry revenue', true, 'revenue' in adminOverview);
}

section('3. A DRIVER CANNOT LOAD AN ADMIN DASHBOARD');

{
  const statuses = [];
  for (const endpoint of DASHBOARD_CALLS) statuses.push((await call('GET', endpoint, { token: driver })).status);

  /* `/charging/sessions` and `/complaints` are OWNER-scoped for a driver by design - they see
   * their own. The analytics calls the console is built on are refused outright. */
  chk('driver is refused /analytics/overview', 403, statuses[0]);
  chk('driver is refused /analytics/sessions', 403, statuses[1]);
  chk('driver is refused /analytics/stations', 403, statuses[2]);
  chk('driver CAN still read their own sessions (owner-scoped, by design)', 200, statuses[3]);
  chk('driver CAN still read their own complaints', 200, statuses[5]);
}

section('4. CROSS-COMPANY - one console never shows another company any data');

{
  const alphaOverview = await must('GET', '/analytics/overview', { token: cpoAlpha });
  const betaOverview = await must('GET', '/analytics/overview', { token: cpoBeta });

  chk('company A sees its own station', 1, alphaOverview.fleet.stations);
  chk('company B sees ZERO stations', 0, betaOverview.fleet.stations);
  chk('company B sees ZERO sessions', 0, betaOverview.sessions.total);
  chk('company B sees ZERO revenue', 0, betaOverview.revenue.revenuePaise);
  chk('company B sees ZERO complaints', 0, betaOverview.complaints.total);

  const betaStations = await must('GET', '/analytics/stations?limit=5', { token: cpoBeta });
  chk('company B leaderboard is empty', [], betaStations.stations);

  const betaSessions = await must('GET', '/charging/sessions?active=true&limit=10', { token: cpoBeta });
  chk('company B has no active sessions from company A', 0, betaSessions.items.length);

  /* Trying to name the other company is refused, not silently rescoped. */
  chk('company B naming company A on analytics is a visible 422', 422,
    (await call('GET', `/analytics/overview?companyId=${alpha.id}`, { token: cpoBeta })).status);
  chk('and on the station leaderboard too', 422,
    (await call('GET', `/analytics/stations?companyId=${alpha.id}`, { token: cpoBeta })).status);
}

section('5. UNAUTHENTICATED - the console has no anonymous surface');

{
  const statuses = [];
  for (const endpoint of [...DASHBOARD_CALLS, ...REVENUE_CALLS]) {
    statuses.push((await call('GET', endpoint)).status);
  }
  chk('every dashboard call requires a token',
    [...DASHBOARD_CALLS, ...REVENUE_CALLS].map(() => 401), statuses);
}

console.log(`\n================ MODULE 15: ${passed} passed, ${failed} failed ================`);
if (fails.length) { console.log('\nFailures:'); for (const f of fails) console.log(`  - ${f}`); }
process.exit(failed === 0 ? 0 : 1);
