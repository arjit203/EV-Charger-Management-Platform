/* THE TAMPERING MATRIX — every way a client can try to reach data that is not theirs.
 *
 * Individual module suites each test their own isolation. This one exists because the
 * interesting question is not "is Station scoped?" but "is the SAME rule enforced the same
 * way across every resource, by every role, through every channel?" — URL, body, query
 * string, and Socket.IO.
 *
 * The cast: two companies, the full role set for each, and a driver who belongs to neither.
 *
 *   Company A: cpo_admin_A, operator_A          driver_A (charges at A)
 *   Company B: cpo_admin_B, operator_B          driver_B (charges at B)
 *   super_admin, who is scoped to nothing
 *
 * Everything asserted here is enforced SERVER-SIDE. Nothing in this file touches the UI.
 */

import { createRequire } from 'module';

const require = createRequire(new URL('../../backend/', import.meta.url));
const { io: ioClient } = require('socket.io-client');

const BASE = process.env.BASE || 'http://localhost:5000/api/v1';
const ORIGIN = BASE.replace(/\/api\/v\d+$/, '');
const S = String(Date.now()).slice(-6);
const PW = 'Matrix16Pass';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const fails = [];
function chk(label, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (ok) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`); }
}
/** Refused = anything that is not a success. 403 and 404 are both correct answers here. */
function chkRefused(label, status) {
  const ok = status === 403 || status === 404 || status === 422 || status === 400;
  if (ok) { passed += 1; console.log(`  PASS  ${label}  (${status})`); }
  else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}\n        expected a refusal (400/403/404/422), got ${status}`); }
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

console.log('\n================ SECURITY MATRIX ================');

const su = (await must('POST', '/auth/login', { body: { email: 'admin@evcms.local', password: 'Admin@12345' } })).token;

async function buildCompany(tag) {
  const company = (await must('POST', '/companies', { token: su, body: { name: `SEC ${tag} ${S}`, type: 'CPO' } })).company;
  const tariff = (await must('POST', '/tariffs', { token: su, body: { name: 'Std', pricePerKwh: 12, companyId: company.id } })).tariff;
  await must('PATCH', `/tariffs/${tariff.id}/status`, { token: su, body: { status: 'active' } });

  const station = (await must('POST', '/stations', { token: su, body: {
    name: `SEC ${tag} Station ${S}`, stationCode: `SEC${tag}-${S}`, address: '1 Secure Way',
    city: 'Delhi', state: 'Delhi', country: 'India', latitude: 28.6, longitude: 77.2,
    companyId: company.id } })).station;

  const charger = await must('POST', '/chargers', { token: su, body: {
    stationId: station.id, name: `SEC-${tag}`, chargerCode: `SECC${tag}-${S}`,
    ocppId: `SEC${tag}-${S}`, manufacturer: 'D', model: 'S', chargerType: 'DC', powerKw: 60 } });

  const connector = (await must('POST', `/chargers/${charger.charger.id}/connectors`, { token: su,
    body: { connectorNumber: 1, connectorType: 'CCS2', powerKw: 60 } })).connector;

  const mkUser = async (role, prefix) => {
    const email = `${prefix}.${tag.toLowerCase()}.sec${S}@test.local`;
    await must('POST', '/users', { token: su, body: { name: `SEC ${prefix} ${tag}`, email, password: PW, role, companyId: company.id } });
    return { email, token: (await must('POST', '/auth/login', { body: { email, password: PW } })).token };
  };

  return {
    company, station, charger: charger.charger, connector, tariff,
    cpo: await mkUser('cpo_admin', 'cpo'),
    op: await mkUser('operator', 'op'),
  };
}

const A = await buildCompany('A');
const B = await buildCompany('B');

async function makeDriver(tag) {
  const email = `driver.${tag}.sec${S}@test.local`;
  const reg = await must('POST', '/auth/register', { body: { name: `SEC Driver ${tag}`, email, password: PW } });
  const token = (await must('POST', '/auth/login', { body: { email, password: PW } })).token;
  return { id: reg.user.id, email, token };
}
const dA = await makeDriver('A');
const dB = await makeDriver('B');

/* Give driver A a vehicle and a complaint so there are owned resources to try to steal. */
/* Vehicles live under /users/me/vehicles — there is no /vehicles/:id at all. */
const vehicleA = (await must('POST', '/users/me/vehicles', { token: dA.token, body: {
  make: 'Tata', model: 'Nexon EV', registrationNumber: `SECA${S}`, connectorType: 'CCS2' } })).vehicle;

const complaintA = (await must('POST', '/complaints', { token: dA.token, body: {
  category: 'account_issue', subject: `Driver A private matter ${S}`,
  description: 'This complaint belongs to driver A and nobody else should read it.' } })).complaint;

console.log(`  built: company A + B, 4 staff, 2 drivers, 1 vehicle, 1 complaint`);

/* =========================================================================
 * 1. IDENTIFIER IN THE URL
 * ========================================================================= */

section('1. SWAPPING AN ID IN THE URL');

/*
 * VEHICLES MAKE THE ATTACK UNREPRESENTABLE. There is no `/vehicles/:id` route — the only
 * address is `/users/me/vehicles/:id`, and `me` resolves from the token. Driver B cannot
 * even FORM a request for driver A's vehicle, which is stronger than refusing one.
 */
chk('there is no global /vehicles/:id route to attack', 404,
  (await call('GET', `/vehicles/${vehicleA.id}`, { token: dB.token })).status);
chkRefused('driver B addressing driver A vehicle through /me/ gets nothing',
  (await call('GET', `/users/me/vehicles/${vehicleA.id}`, { token: dB.token })).status);
chkRefused('driver B cannot update it either',
  (await call('PATCH', `/users/me/vehicles/${vehicleA.id}`, { token: dB.token, body: { model: 'Stolen' } })).status);
chkRefused('driver B cannot delete it',
  (await call('DELETE', `/users/me/vehicles/${vehicleA.id}`, { token: dB.token })).status);
chk('and driver A still has their vehicle', 1,
  (await must('GET', '/users/me/vehicles', { token: dA.token })).vehicles.filter((v) => v.id === vehicleA.id).length);
chkRefused('driver B cannot read driver A complaint',
  (await call('GET', `/complaints/${complaintA.id}`, { token: dB.token })).status);
chkRefused('company B admin cannot read company A station',
  (await call('GET', `/stations/${A.station.id}`, { token: B.cpo.token })).status);
chkRefused('company B admin cannot read company A charger',
  (await call('GET', `/chargers/${A.charger.id}`, { token: B.cpo.token })).status);
chkRefused('company B operator cannot read company A station',
  (await call('GET', `/stations/${A.station.id}`, { token: B.op.token })).status);
chkRefused('company B admin cannot read company A tariff',
  (await call('GET', `/tariffs/${A.tariff.id}`, { token: B.cpo.token })).status);
chkRefused('company B admin cannot read a company A user',
  (await call('GET', `/users/${(await must('GET', '/auth/me', { token: A.cpo.token })).user.id}`, { token: B.cpo.token })).status);

/* =========================================================================
 * 2. IDENTIFIER IN THE BODY
 * ========================================================================= */

section('2. PLANTING A companyId IN THE BODY');

chkRefused('company B admin cannot create a station in company A',
  (await call('POST', '/stations', { token: B.cpo.token, body: {
    name: `Trespass ${S}`, stationCode: `TRESP-${S}`, address: '1 X', city: 'Delhi',
    state: 'Delhi', country: 'India', latitude: 28.6, longitude: 77.2,
    companyId: A.company.id } })).status);

chkRefused('company B admin cannot create a tariff for company A',
  (await call('POST', '/tariffs', { token: B.cpo.token, body: {
    name: 'Trespass', pricePerKwh: 99, companyId: A.company.id } })).status);

chkRefused('company B admin cannot create a user inside company A',
  (await call('POST', '/users', { token: B.cpo.token, body: {
    name: 'Trespass', email: `trespass.${S}@test.local`, password: PW,
    role: 'operator', companyId: A.company.id } })).status);

chkRefused('company B admin cannot hang a charger off a company A station',
  (await call('POST', '/chargers', { token: B.cpo.token, body: {
    stationId: A.station.id, name: 'Trespass', chargerCode: `TRSPC-${S}`,
    ocppId: `TRSP-${S}`, manufacturer: 'D', model: 'S', chargerType: 'DC', powerKw: 60 } })).status);

chkRefused('a driver cannot start a session on a connector they did not ask for by id alone',
  (await call('POST', '/charging/sessions', { token: dB.token, body: {
    connectorId: A.connector.id, userId: dA.id } })).status);

/* =========================================================================
 * 3. IDENTIFIER IN THE QUERY STRING
 * ========================================================================= */

section('3. PLANTING A companyId IN THE QUERY STRING');

{
  /* Module 4 refuses outright; Module 13 returns 422. Either is a visible refusal — what
   * must never happen is a 200 carrying the other company's rows. */
  const stations = await call('GET', `/stations?companyId=${A.company.id}`, { token: B.cpo.token });
  if (stations.status === 200) {
    chk('station list ignored the planted companyId (returned own rows only)', 0,
      stations.body.data.items.filter((s) => s.companyId === A.company.id).length);
  } else {
    chkRefused('station list refuses a planted companyId', stations.status);
  }

  chkRefused('analytics refuses a planted companyId',
    (await call('GET', `/analytics/overview?companyId=${A.company.id}`, { token: B.cpo.token })).status);
  chkRefused('analytics stations refuses a planted companyId',
    (await call('GET', `/analytics/stations?companyId=${A.company.id}`, { token: B.cpo.token })).status);
  chkRefused('the staff map refuses a planted companyId',
    (await call('GET', `/stations/map?companyId=${A.company.id}`, { token: B.cpo.token })).status);

  const sessions = await call('GET', `/charging/sessions?companyId=${A.company.id}`, { token: B.cpo.token });
  chk('session list never returns another company rows', true,
    sessions.status !== 200 || sessions.body.data.items.every((s) => s.companyId !== A.company.id));

  const complaints = await call('GET', `/complaints?userId=${dA.id}`, { token: dB.token });
  chk('a driver cannot widen their complaint list with a userId', true,
    complaints.status !== 200 || complaints.body.data.items.every((c) => c.userId !== dA.id));
}

/* =========================================================================
 * 4. CROSS-COMPANY REFERENCE CHAINS
 * ========================================================================= */

section('4. MIXING RESOURCES FROM TWO COMPANIES');

chkRefused('a connector cannot be added to another company charger',
  (await call('POST', `/chargers/${A.charger.id}/connectors`, { token: B.cpo.token,
    body: { connectorNumber: 2, connectorType: 'CCS2', powerKw: 60 } })).status);

chkRefused('a charger cannot be moved to another company station',
  (await call('PATCH', `/chargers/${B.charger.id}`, { token: B.cpo.token,
    body: { stationId: A.station.id } })).status);

chkRefused('a complaint cannot be anchored to another user session',
  (await call('POST', '/complaints', { token: dB.token, body: {
    category: 'session_issue', subject: 'Not my session',
    description: 'Trying to anchor to a session that is not mine at all.',
    chargingSessionId: '0'.repeat(24) } })).status);

/* =========================================================================
 * 5. PROTECTED FIELDS
 * ========================================================================= */

section('5. WRITING FIELDS THE CLIENT DOES NOT OWN');

{
  const meBefore = (await must('GET', '/auth/me', { token: dA.token })).user;

  const escalate = await call('PATCH', '/users/me', { token: dA.token, body: { role: 'super_admin' } });
  chk('a driver cannot promote themselves', true, escalate.status >= 400);
  chk('and their role is unchanged', 'driver',
    (await must('GET', '/auth/me', { token: dA.token })).user.role);

  chk('a driver cannot attach themselves to a company', true,
    (await call('PATCH', '/users/me', { token: dA.token, body: { companyId: A.company.id } })).status >= 400);
  chk('a driver cannot flip their own status', true,
    (await call('PATCH', '/users/me', { token: dA.token, body: { status: 'suspended' } })).status >= 400);
  chk('a driver cannot rewrite their own id', true,
    (await call('PATCH', '/users/me', { token: dA.token, body: { id: '0'.repeat(24) } })).status >= 400);
  chk('the account survived all of that intact', meBefore.id,
    (await must('GET', '/auth/me', { token: dA.token })).user.id);

  /* Money is the one nobody may set directly. */
  chk('there is no endpoint to set a wallet balance', true,
    (await call('PATCH', '/wallet', { token: dA.token, body: { balancePaise: 999999 } })).status >= 400);
  chk('nor to POST one', true,
    (await call('POST', '/wallet', { token: dA.token, body: { balancePaise: 999999 } })).status >= 400);

  /* Session amount is computed from a snapshotted rate; a client cannot dictate it. */
  chk('a driver cannot dictate a session amount at start', true,
    (await call('POST', '/charging/sessions', { token: dA.token, body: {
      connectorId: A.connector.id, amountPaise: 1 } })).status >= 400);
}

/* =========================================================================
 * 6. ROLE BOUNDARIES
 * ========================================================================= */

section('6. ROLE BOUNDARIES');

chkRefused('a driver cannot list companies', (await call('GET', '/companies', { token: dA.token })).status);
chkRefused('a driver cannot list users', (await call('GET', '/users', { token: dA.token })).status);
chkRefused('a driver cannot list stations administratively', (await call('GET', '/stations', { token: dA.token })).status);
chkRefused('a driver cannot read analytics', (await call('GET', '/analytics/overview', { token: dA.token })).status);
chkRefused('an operator cannot create a station', (await call('POST', '/stations', { token: A.op.token, body: {
  name: 'Op made this', stationCode: `OPS-${S}`, address: '1 X', city: 'Delhi', state: 'Delhi',
  country: 'India', latitude: 28.6, longitude: 77.2 } })).status);
chkRefused('an operator cannot create a user', (await call('POST', '/users', { token: A.op.token, body: {
  name: 'X', email: `opmade.${S}@test.local`, password: PW, role: 'operator' } })).status);
chkRefused('an operator cannot create a tariff', (await call('POST', '/tariffs', { token: A.op.token,
  body: { name: 'Op tariff', pricePerKwh: 5 } })).status);
chkRefused('an operator cannot read revenue', (await call('GET', '/analytics/revenue', { token: A.op.token })).status);
chkRefused('a cpo_admin cannot create a company', (await call('POST', '/companies', { token: A.cpo.token,
  body: { name: `Self made ${S}`, type: 'CPO' } })).status);

/* =========================================================================
 * 7. SUSPENDED COMPANY
 * ========================================================================= */

section('7. A SUSPENDED COMPANY LOSES ACCESS IMMEDIATELY');

{
  chk('company B staff can work before suspension', 200,
    (await call('GET', '/stations', { token: B.cpo.token })).status);

  await must('PATCH', `/companies/${B.company.id}/status`, { token: su, body: { status: 'suspended' } });

  /* The token issued BEFORE suspension is still cryptographically valid — this proves the
   * check is live against the database on every request, not baked into the JWT. */
  chkRefused('the same token is refused after suspension',
    (await call('GET', '/stations', { token: B.cpo.token })).status);
  chkRefused('their operator is refused too',
    (await call('GET', '/chargers', { token: B.op.token })).status);
  chkRefused('and analytics',
    (await call('GET', '/analytics/overview', { token: B.cpo.token })).status);

  chk('but they can still authenticate — identity is not the same as permission', 200,
    (await call('POST', '/auth/login', { body: { email: B.cpo.email, password: PW } })).status);

  chk('company A is entirely unaffected', 200,
    (await call('GET', '/stations', { token: A.cpo.token })).status);

  await must('PATCH', `/companies/${B.company.id}/status`, { token: su, body: { status: 'active' } });
  chk('reactivating restores access', 200,
    (await call('GET', '/stations', { token: B.cpo.token })).status);
}

/* =========================================================================
 * 8. SOCKET.IO
 * ========================================================================= */

section('8. SOCKET.IO — rooms are server-assigned');

{
  const connect = (token) => new Promise((resolve) => {
    const socket = ioClient(ORIGIN, { path: '/socket.io', auth: token ? { token } : {},
      transports: ['websocket'], reconnection: false });
    const received = [];
    socket.onAny((name, payload) => received.push({ name, payload }));
    socket.on('connect', () => resolve({ ok: true, socket, received }));
    socket.on('connect_error', () => resolve({ ok: false, socket, received }));
  });

  chk('no token -> refused', false, (await connect(null)).ok);
  chk('garbage token -> refused', false, (await connect('not.a.jwt')).ok);

  const wB = await connect(B.cpo.token);
  chk('a valid token connects', true, wB.ok);

  /* There is no join handler on the server, so asking for a room must do nothing at all. */
  wB.socket.emit('join', `company:${A.company.id}`);
  wB.socket.emit('subscribe', { room: `company:${A.company.id}` });
  wB.socket.emit('join', 'platform');
  await sleep(600);
  chk('a client-sent join does not disconnect it', true, wB.socket.connected);
  chk('and grants nothing — no events from company A arrive', 0,
    wB.received.filter((e) => e.name !== 'connect').length);

  wB.socket.close();
  await sleep(200);
}

console.log(`\n================ SECURITY MATRIX: ${passed} passed, ${failed} failed ================`);
if (fails.length) { console.log('\nFailures:'); for (const f of fails) console.log(`  - ${f}`); }
process.exit(failed === 0 ? 0 : 1);
