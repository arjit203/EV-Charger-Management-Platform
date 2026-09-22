/* Module 8 verification — Socket.IO real-time monitoring.
   Real Socket.IO clients + a real OCPP WebSocket, no mocks.

   The isolation checks are the important ones and they assert SILENCE. The window is sized at
   8s so it spans more than one full meter tick (5s) plus the OCPP round trips — otherwise
   "received nothing" could just mean "the test finished before anything arrived", which proves
   nothing at all. */

import { createRequire } from 'module';
const require = createRequire(new URL('../../backend/', import.meta.url));
const WebSocket = require('ws');
const { io: ioClient } = require('socket.io-client');

const BASE = process.env.BASE || 'http://localhost:5000/api/v1';
const ORIGIN = process.env.ORIGIN || 'http://localhost:5000';
const WS_BASE = process.env.WS_BASE || 'ws://localhost:5000/ocpp';
const S = String(Date.now()).slice(-6);
const PW = 'RealtimePass12345';
const SILENCE_WINDOW_MS = 8000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const failures = [];
const chk = (name, expected, actual) => {
  const e = JSON.stringify(expected), a = JSON.stringify(actual);
  if (e === a) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}  (expected ${e}, got ${a})`); failures.push(name); fail++; }
};

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

const EVENTS = ['connector:statusChanged', 'charger:connectivityChanged', 'session:statusChanged', 'session:meterUpdate'];

/** A Socket.IO client that records everything it is given. */
class Watcher {
  constructor(label, token) { this.label = label; this.token = token; this.received = []; this.disconnects = []; }
  connect() {
    return new Promise((resolve) => {
      this.socket = ioClient(ORIGIN, { path: '/socket.io', auth: { token: this.token },
        transports: ['websocket'], reconnection: false, timeout: 5000 });
      const done = (ok, err) => resolve({ ok, err });
      this.socket.on('connect', () => done(true, null));
      this.socket.on('connect_error', (e) => done(false, e.message));
      for (const name of EVENTS) this.socket.on(name, (p) => this.received.push({ name, payload: p }));
      this.socket.on('disconnect', (reason) => this.disconnects.push(reason));
    });
  }
  of(name) { return this.received.filter((e) => e.name === name); }
  clear() { this.received = []; }
  get connected() { return Boolean(this.socket?.connected); }
  close() { try { this.socket?.close(); } catch {} }
}

class Sim {
  constructor(ocppId, token) { this.ocppId = ocppId; this.token = token; this.pending = new Map(); this.inbound = []; this.beat = null; }
  connect() {
    const creds = Buffer.from(`${this.ocppId}:${this.token}`).toString('base64');
    return new Promise((resolve) => {
      const s = new WebSocket(`${WS_BASE}/${encodeURIComponent(this.ocppId)}`, { headers: { Authorization: `Basic ${creds}` } });
      this.socket = s;
      s.on('open', () => resolve(true));
      s.on('error', () => resolve(false));
      s.on('message', (d) => {
        const f = JSON.parse(d.toString());
        if (f[0] === 3 || f[0] === 4) { const p = this.pending.get(f[1]); if (p) { this.pending.delete(f[1]); p(f); } }
        else if (f[0] === 2) this.inbound.push({ uid: f[1], action: f[2], payload: f[3] });
      });
    });
  }
  send(action, payload = {}) {
    const uid = `r-${Math.random().toString(36).slice(2)}`;
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout ${action}`)), 8000);
      this.pending.set(uid, (f) => { clearTimeout(t); res(f); });
      this.socket.send(JSON.stringify([2, uid, action, payload]));
    });
  }
  reply(uid, payload) { this.socket.send(JSON.stringify([3, uid, payload])); }
  async waitForCall(action, ms = 6000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const f = this.inbound.find((m) => m.action === action);
      if (f) { this.inbound = this.inbound.filter((m) => m !== f); return f; }
      await sleep(40);
    }
    return null;
  }
  startHeartbeat(ms = 1500) { this.beat = setInterval(() => { this.send('Heartbeat', {}).catch(() => {}); }, ms); }
  close() { if (this.beat) clearInterval(this.beat); try { this.socket.close(); } catch {} }
}

/* ------------------------------------------------------------------ setup */
console.log('=== SETUP ===');
const su = (await must('POST', '/auth/login', { body: { email: 'admin@evcms.local', password: 'Admin@12345' } })).token;

const mkCompany = async (label) => (await must('POST', '/companies', { token: su, body: { name: `${label} ${S}`, type: 'CPO' } })).company.id;
const A = await mkCompany('M8 Alpha');
const B = await mkCompany('M8 Beta');

// Module 9: a company with no published price cannot sell electricity.
for (const [companyId, rupees] of [[A, 12], [B, 15]]) {
  const t = (await must('POST', '/tariffs', { token: su, body: { name: 'RT Rate', pricePerKwh: rupees, companyId } })).tariff;
  await must('PATCH', `/tariffs/${t.id}/status`, { token: su, body: { status: 'active' } });
}

const staff = {};
for (const [key, companyId, role] of [['cpoA', A, 'cpo_admin'], ['opA', A, 'operator'], ['cpoB', B, 'cpo_admin']]) {
  const email = `${key}.m8.${S}@test.local`;
  const created = await must('POST', '/users', { token: su, body: { name: `Staff ${key}`, email, password: PW, role, companyId } });
  staff[key] = { id: created.user.id, email, token: (await must('POST', '/auth/login', { body: { email, password: PW } })).token };
}

const drivers = {};
for (const key of ['dA', 'dB']) {
  const email = `${key}.m8.${S}@test.local`;
  const reg = await must('POST', '/auth/register', { body: { name: `Driver ${key}`, email, password: PW } });
  drivers[key] = { id: reg.user.id, email, token: (await must('POST', '/auth/login', { body: { email, password: PW } })).token };
}

const station = (await must('POST', '/stations', { token: su, body: { name: `M8 Station ${S}`, stationCode: `S8A-${S}`,
  address: '1 Live Road', city: 'Delhi', state: 'Delhi', country: 'India', latitude: 28.6, longitude: 77.2, companyId: A } })).station;
const ch = await must('POST', '/chargers', { token: su, body: { stationId: station.id, name: `M8 Charger ${S}`,
  chargerCode: `C8A-${S}`, ocppId: `OCPP8-${S}`, manufacturer: 'Delta', model: 'Sim', chargerType: 'DC', powerKw: 60 } });
const conn1 = (await must('POST', `/chargers/${ch.charger.id}/connectors`, { token: su, body: { connectorNumber: 1, connectorType: 'CCS2', powerKw: 60 } })).connector;

/* ------------------------------------------------------- CONNECTION ---- */
console.log('\n=== SOCKET CONNECTION & HANDSHAKE AUTH ===');
const wCpoA = new Watcher('cpoA', staff.cpoA.token);
const wOpA = new Watcher('opA', staff.opA.token);
const wCpoB = new Watcher('cpoB', staff.cpoB.token);
const wDriverA = new Watcher('driverA', drivers.dA.token);
const wDriverB = new Watcher('driverB', drivers.dB.token);
const wSuper = new Watcher('super', su);

chk('1. authenticated client connects', true, (await wCpoA.connect()).ok);
chk('   operator connects', true, (await wOpA.connect()).ok);
chk('   rival company admin connects', true, (await wCpoB.connect()).ok);
chk('   driver A connects', true, (await wDriverA.connect()).ok);
chk('   driver B connects', true, (await wDriverB.connect()).ok);
chk('   super_admin connects', true, (await wSuper.connect()).ok);

chk('2. no token -> rejected', false, (await new Watcher('anon', '').connect()).ok);
chk('   garbage token -> rejected', false, (await new Watcher('junk', 'not.a.jwt').connect()).ok);
const forged = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI2MTFmMWYxZjFmMWYxZjFmMWYxZjFmMWYiLCJyb2xlIjoic3VwZXJfYWRtaW4ifQ.bad';
chk('   forged signature -> rejected', false, (await new Watcher('forged', forged).connect()).ok);

/* -------------------------------------------------- ROOMS ARE SERVER-SET */
console.log('\n=== CLIENT CANNOT ASK FOR A ROOM ===');
// There is no join handler on the server at all, so this must be inert.
wCpoB.socket.emit('join', `company:${A}`);
wCpoB.socket.emit('subscribe', { room: `company:${A}` });
wDriverB.socket.emit('join', `user:${drivers.dA.id}`);
await sleep(500);
chk('   a client-sent join does not disconnect it either (simply ignored)', true, wCpoB.connected);

/* ------------------------------------------------------- CONNECTIVITY -- */
console.log('\n=== charger:connectivityChanged ===');
for (const w of [wCpoA, wOpA, wCpoB, wDriverA, wDriverB, wSuper]) w.clear();

const sim = new Sim(ch.charger.ocppId, ch.authToken);
await sim.connect();
sim.startHeartbeat();
await sim.send('BootNotification', { chargePointVendor: 'Test', chargePointModel: 'M8' });
await sleep(600);

chk('7. company A admin sees the charger come online', 1, wCpoA.of('charger:connectivityChanged').length);
chk('   operator sees it too', 1, wOpA.of('charger:connectivityChanged').length);
/*
 * FILTERED TO THIS CHARGER, unlike the two company-scoped assertions above.
 *
 * super_admin is in the PLATFORM room and therefore sees connectivity for every company on
 * the installation - including a charger left over from an earlier run of this same suite
 * being swept offline inside this 600ms window. Counting ALL events made the assertion
 * intermittently see 2, which is the platform view working correctly, not a bug.
 *
 * Asserting on THIS charger's ocppId is both immune to that noise and a stronger claim: it
 * proves super_admin saw the RIGHT event, not merely the right number of events.
 */
chk(
  '   super_admin sees it',
  1,
  wSuper
    .of('charger:connectivityChanged')
    .filter((e) => e.payload?.ocppId === ch.charger.ocppId).length,
);
chk('   payload says online', true, wCpoA.of('charger:connectivityChanged')[0]?.payload?.isOnline);
chk('   payload carries the station', station.id, wCpoA.of('charger:connectivityChanged')[0]?.payload?.stationId);
chk('6. rival company sees NOTHING', 0, wCpoB.received.length);
chk('   drivers see no charger events', 0, wDriverA.received.length + wDriverB.received.length);

console.log('\n=== connector:statusChanged ===');
for (const w of [wCpoA, wOpA, wCpoB, wDriverA, wSuper]) w.clear();
await sim.send('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' });
await sleep(500);
chk('5. company A admin sees the connector status', 1, wCpoA.of('connector:statusChanged').length);
chk('   it names the connector', conn1.id, wCpoA.of('connector:statusChanged')[0]?.payload?.connectorId);
chk('   mapped to our vocabulary, not OCPP PascalCase', 'available', wCpoA.of('connector:statusChanged')[0]?.payload?.status);
chk('   rival company still silent', 0, wCpoB.received.length);
chk('   driver does not receive connector events', 0, wDriverA.of('connector:statusChanged').length);

/* ------------------------------------------------------- SESSION FLOW -- */
console.log('\n=== SESSION EVENTS (full charge, live) ===');
for (const w of [wCpoA, wOpA, wCpoB, wDriverA, wDriverB, wSuper]) w.clear();

const startReq = call('POST', '/charging/sessions', { token: drivers.dA.token, body: { connectorId: conn1.id } });
const cmd = await sim.waitForCall('RemoteStartTransaction');
sim.reply(cmd.uid, { status: 'Accepted' });
const started = await startReq;
const sessionId = started.body.data.session.id;
await sleep(500);

chk('9. driver A is told their session is initiating', 'initiating',
  wDriverA.of('session:statusChanged')[0]?.payload?.session?.status);
chk('   company A admin sees it appear', 'initiating',
  wCpoA.of('session:statusChanged')[0]?.payload?.session?.status);
chk('13. driver B is told nothing', 0, wDriverB.received.length);
chk('15. rival company is told nothing', 0, wCpoB.received.length);

await sim.send('Authorize', { idTag: cmd.payload.idTag });
const st = await sim.send('StartTransaction', { connectorId: 1, idTag: cmd.payload.idTag, meterStart: 0, timestamp: new Date().toISOString() });
const txn = st[2].transactionId;
await sim.send('StatusNotification', { connectorId: 1, status: 'Charging', errorCode: 'NoError' });
await sleep(600);

chk('   driver A sees it go active', true,
  wDriverA.of('session:statusChanged').some((e) => e.payload.session.status === 'active'));
chk('   company A admin sees it go active', true,
  wCpoA.of('session:statusChanged').some((e) => e.payload.session.status === 'active'));
chk('   and the connector flip to charging', true,
  wCpoA.of('connector:statusChanged').some((e) => e.payload.status === 'charging'));

console.log('\n=== session:meterUpdate ===');
for (const w of [wCpoA, wCpoB, wDriverA, wDriverB, wSuper]) w.clear();
for (const wh of [83.33, 166.66, 250]) {
  await sim.send('MeterValues', { connectorId: 1, transactionId: txn, energyWh: wh, powerKw: 60, timestamp: new Date().toISOString() });
  await sleep(200);
}
await sleep(500);

chk('10. driver A receives every reading', 3, wDriverA.of('session:meterUpdate').length);
chk('    company A admin receives them', 3, wCpoA.of('session:meterUpdate').length);
chk('    super_admin receives them', 3, wSuper.of('session:meterUpdate').length);
chk('    payload carries kWh for the UI', 0.25, wDriverA.of('session:meterUpdate')[2]?.payload?.energyConsumedKwh);
chk('    payload carries instantaneous power', 60, wDriverA.of('session:meterUpdate')[2]?.payload?.powerKw);

// A rejected reading must NOT produce an event — the UI would show a number the DB does not hold.
wDriverA.clear();
await sim.send('MeterValues', { connectorId: 1, transactionId: txn, energyWh: 250, timestamp: new Date().toISOString() });
await sim.send('MeterValues', { connectorId: 1, transactionId: txn, energyWh: 10, timestamp: new Date().toISOString() });
await sleep(600);
chk('    a duplicate/stale reading emits NOTHING', 0, wDriverA.of('session:meterUpdate').length);

/* ---------------------------------------------------------- COMPLETION - */
console.log('\n=== session completion ===');
for (const w of [wCpoA, wCpoB, wDriverA, wDriverB]) w.clear();
const stopReq = call('POST', `/charging/sessions/${sessionId}/stop`, { token: drivers.dA.token });
const stopCmd = await sim.waitForCall('RemoteStopTransaction');
sim.reply(stopCmd.uid, { status: 'Accepted' });
await stopReq;
await sim.send('StopTransaction', { transactionId: txn, meterStop: 416.65, reason: 'Remote', timestamp: new Date().toISOString() });
await sim.send('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' });
await sleep(700);

chk('11. driver A sees `stopping` then `completed`', true,
  wDriverA.of('session:statusChanged').some((e) => e.payload.session.status === 'stopping') &&
  wDriverA.of('session:statusChanged').some((e) => e.payload.session.status === 'completed'));
chk('    the completed payload carries final energy', 416.65,
  wDriverA.of('session:statusChanged').find((e) => e.payload.session.status === 'completed')?.payload?.session?.energyConsumedWh);
chk('    company A admin sees completion', true,
  wCpoA.of('session:statusChanged').some((e) => e.payload.session.status === 'completed'));

/* ------------------------------------------- THE SILENCE ASSERTION ----- */
console.log(`\n=== ISOLATION — ${SILENCE_WINDOW_MS / 1000}s silence window (> one 5s meter tick) ===`);
console.log('    running a second full charge for company A while B watches...');
for (const w of [wCpoB, wDriverB]) w.clear();

const start2 = call('POST', '/charging/sessions', { token: drivers.dA.token, body: { connectorId: conn1.id } });
const cmd2 = await sim.waitForCall('RemoteStartTransaction');
sim.reply(cmd2.uid, { status: 'Accepted' });
const s2 = await start2;
await sim.send('Authorize', { idTag: cmd2.payload.idTag });
const st2 = await sim.send('StartTransaction', { connectorId: 1, idTag: cmd2.payload.idTag, meterStart: 0, timestamp: new Date().toISOString() });
const txn2 = st2[2].transactionId;
await sim.send('StatusNotification', { connectorId: 1, status: 'Charging', errorCode: 'NoError' });

const silenceStart = Date.now();
let tick = 0;
while (Date.now() - silenceStart < SILENCE_WINDOW_MS) {
  tick += 100;
  await sim.send('MeterValues', { connectorId: 1, transactionId: txn2, energyWh: tick, powerKw: 60, timestamp: new Date().toISOString() });
  await sleep(1000);
}

chk('14. rival company admin received ZERO events across the whole window', 0, wCpoB.received.length);
chk('13. driver B received ZERO events across the whole window', 0, wDriverB.received.length);
chk('    (and the window really did carry traffic)', true, wCpoA.of('session:meterUpdate').length > 0);
chk('    both are still connected — silence, not a dropped socket', [true, true], [wCpoB.connected, wDriverB.connected]);

await sim.send('StopTransaction', { transactionId: txn2, meterStop: tick, reason: 'Remote', timestamp: new Date().toISOString() });
await sleep(500);

/* ------------------------------------------------ FORCED DISCONNECTS --- */
console.log('\n=== SUSPENSION MUST REACH OPEN SOCKETS ===');
chk('    driver A socket is open before deactivation', true, wDriverA.connected);
await must('PATCH', `/users/${drivers.dA.id}/status`, { token: su, body: { status: 'suspended' } });
await sleep(800);
chk('    deactivating a user drops their live socket', false, wDriverA.connected);
chk('    a suspended user cannot reconnect', false, (await new Watcher('dA2', drivers.dA.token).connect()).ok);

chk('    company A admin socket is open before suspension', true, wCpoA.connected);
await must('PATCH', `/companies/${A}/status`, { token: su, body: { status: 'suspended' } });
await sleep(800);
chk('18. suspending a company drops its staff sockets', [false, false], [wCpoA.connected, wOpA.connected]);
chk('    suspended company staff cannot reconnect', false, (await new Watcher('cpoA2', staff.cpoA.token).connect()).ok);
chk('    the rival company is unaffected', true, wCpoB.connected);

/* ------------------------------------------------------------ CLEANUP -- */
sim.close();
for (const w of [wCpoA, wOpA, wCpoB, wDriverA, wDriverB, wSuper]) w.close();
await sleep(500);

console.log(`\n=========== MODULE 8: ${pass} passed, ${fail} failed ===========`);
if (fail) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
