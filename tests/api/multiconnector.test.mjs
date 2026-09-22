/* Module 6 registry patch — regression checks for the three failure modes a probe found:
     1. OVERWRITE       second StartTransaction clobbered the first's bookkeeping
     2. MISROUTING      MeterValues without transactionId fell back to the wrong session
     3. PREMATURE CLEAR any StopTransaction wiped tracking for the survivor too
   Every check below fails against the pre-patch code. */

import { createRequire } from 'module';
const require = createRequire(new URL('../../backend/', import.meta.url));
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://localhost:5000/api/v1';
const WS_BASE = process.env.WS_BASE || 'ws://localhost:5000/ocpp';
const S = String(Date.now()).slice(-6);
const PW = 'MultiPass12345';
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
    const uid = `m-${Math.random().toString(36).slice(2)}`;
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

/* ---------------------------------------------------------------- setup */
console.log('=== SETUP (one charger, TWO connectors, two drivers) ===');
const su = (await must('POST', '/auth/login', { body: { email: 'admin@evcms.local', password: 'Admin@12345' } })).token;
const company = (await must('POST', '/companies', { token: su, body: { name: `M6 Multi ${S}`, type: 'CPO' } })).company;

// Module 9: no published price, no charging.
const mcTariff = (await must('POST', '/tariffs', { token: su, body: { name: 'MC Rate', pricePerKwh: 12, companyId: company.id } })).tariff;
await must('PATCH', `/tariffs/${mcTariff.id}/status`, { token: su, body: { status: 'active' } });
const station = (await must('POST', '/stations', { token: su, body: { name: `Multi Station ${S}`, stationCode: `MC-${S}`,
  address: '1 Multi Road', city: 'Delhi', state: 'Delhi', country: 'India', latitude: 28.6, longitude: 77.2, companyId: company.id } })).station;
const ch = await must('POST', '/chargers', { token: su, body: { stationId: station.id, name: `Multi Charger ${S}`,
  chargerCode: `C6M-${S}`, ocppId: `OCPP6M-${S}`, manufacturer: 'Delta', model: 'Sim', chargerType: 'DC', powerKw: 60 } });
const c1 = (await must('POST', `/chargers/${ch.charger.id}/connectors`, { token: su, body: { connectorNumber: 1, connectorType: 'CCS2', powerKw: 60 } })).connector;
const c2 = (await must('POST', `/chargers/${ch.charger.id}/connectors`, { token: su, body: { connectorNumber: 2, connectorType: 'CCS2', powerKw: 60 } })).connector;

const drivers = [];
for (const key of ['ma', 'mb']) {
  const email = `${key}.m6multi.${S}@test.local`;
  await must('POST', '/auth/register', { body: { name: `Driver ${key}`, email, password: PW } });
  drivers.push((await must('POST', '/auth/login', { body: { email, password: PW } })).token);
}

const sim = new Sim(ch.charger.ocppId, ch.authToken);
await sim.connect();
sim.startHeartbeat();
await sim.send('BootNotification', { chargePointVendor: 'Test', chargePointModel: 'MC' });
await sim.send('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' });
await sim.send('StatusNotification', { connectorId: 2, status: 'Available', errorCode: 'NoError' });
await sleep(300);

const sess = async (id) => (await call('GET', `/charging/sessions/${id}`, { token: su })).body.data.session;
const conn = async () => (await call('GET', `/chargers/${ch.charger.id}/connection`, { token: su })).body.data.connection;

async function startOn(connectorId, connectorNumber, token, meterStart) {
  const req = call('POST', '/charging/sessions', { token, body: { connectorId } });
  const cmd = await sim.waitForCall('RemoteStartTransaction');
  sim.reply(cmd.uid, { status: 'Accepted' });
  const res = await req;
  await sim.send('Authorize', { idTag: cmd.payload.idTag });
  const st = await sim.send('StartTransaction', { connectorId: connectorNumber, idTag: cmd.payload.idTag,
    meterStart, timestamp: new Date().toISOString() });
  await sim.send('StatusNotification', { connectorId: connectorNumber, status: 'Charging', errorCode: 'NoError' });
  return { sessionId: res.body.data.session.id, transactionId: st[2].transactionId };
}

/* ----------------------------------------- two simultaneous sessions --- */
console.log('\n=== TWO CONNECTORS CHARGING AT ONCE ===');
const A = await startOn(c1.id, 1, drivers[0], 0);
const B = await startOn(c2.id, 2, drivers[1], 5000);
await sleep(300);

chk('both sessions reach active', ['active', 'active'],
  [(await sess(A.sessionId)).status, (await sess(B.sessionId)).status]);
chk('the two sessions got different transaction ids', true, A.transactionId !== B.transactionId);

/* ------------------------------------------- 1. OVERWRITE (was a bug) -- */
console.log('\n=== FAILURE MODE 1 — registry overwrite ===');
const live = await conn();
chk('the gateway tracks BOTH transactions, not just the latest', 2, live.transactions.length);
chk('connector 1 transaction is still tracked', A.transactionId,
  live.transactions.find((t) => t.connectorNumber === 1)?.transactionId);
chk('connector 2 transaction is tracked', B.transactionId,
  live.transactions.find((t) => t.connectorNumber === 2)?.transactionId);

/* --------------------------------------------------- explicit routing -- */
console.log('\n=== METER VALUES WITH an explicit transactionId ===');
await sim.send('MeterValues', { connectorId: 1, transactionId: A.transactionId, energyWh: 100, timestamp: new Date().toISOString() });
await sim.send('MeterValues', { connectorId: 2, transactionId: B.transactionId, energyWh: 5100, timestamp: new Date().toISOString() });
await sleep(400);
chk('session A credited', 100, (await sess(A.sessionId)).energyConsumedWh);
chk('session B credited', 100, (await sess(B.sessionId)).energyConsumedWh);

/* ----------------------------------------- 2. MISROUTING (was a bug) --- */
console.log('\n=== FAILURE MODE 2 — MeterValues WITHOUT transactionId ===');
// OCPP 1.6 makes transactionId optional here. The fallback must resolve by CONNECTOR.
await sim.send('MeterValues', { connectorId: 1, energyWh: 200, timestamp: new Date().toISOString() });
await sleep(400);
chk('connector 1 reading credited to A', 200, (await sess(A.sessionId)).energyConsumedWh);
chk('and NOT to B', 100, (await sess(B.sessionId)).energyConsumedWh);

await sim.send('MeterValues', { connectorId: 2, energyWh: 5200, timestamp: new Date().toISOString() });
await sleep(400);
chk('connector 2 reading credited to B', 200, (await sess(B.sessionId)).energyConsumedWh);
chk('and NOT to A', 200, (await sess(A.sessionId)).energyConsumedWh);

/* ------------------------------------ 3. PREMATURE CLEAR (was a bug) --- */
console.log('\n=== FAILURE MODE 3 — stopping one session must not disturb the other ===');
await sim.send('StopTransaction', { transactionId: A.transactionId, meterStop: 300, reason: 'Remote', timestamp: new Date().toISOString() });
await sleep(400);

chk('A completed', 'completed', (await sess(A.sessionId)).status);
chk('A energy finalised', 300, (await sess(A.sessionId)).energyConsumedWh);
chk('B is untouched and still active', 'active', (await sess(B.sessionId)).status);

const afterStop = await conn();
chk('the gateway still tracks B', 1, afterStop.transactions.length);
chk('and it is B, on connector 2', 2, afterStop.transactions[0]?.connectorNumber);

await sim.send('MeterValues', { connectorId: 2, energyWh: 5300, timestamp: new Date().toISOString() });
await sleep(400);
chk('B keeps receiving transactionId-less readings after A stopped', 300,
  (await sess(B.sessionId)).energyConsumedWh);

/* ------------------------------------------------------- sanity check -- */
console.log('\n=== NO PHANTOM ATTRIBUTION AFTER A STOPPED ===');
await sim.send('MeterValues', { connectorId: 1, energyWh: 999, timestamp: new Date().toISOString() });
await sleep(400);
chk('a reading on the now-free connector 1 is ignored', 300, (await sess(A.sessionId)).energyConsumedWh);
chk('and never leaks into B', 300, (await sess(B.sessionId)).energyConsumedWh);

/* ---------------------------------------------------------- teardown --- */
await sim.send('StopTransaction', { transactionId: B.transactionId, meterStop: 5400, reason: 'Remote', timestamp: new Date().toISOString() });
await sleep(300);
chk('B completes normally', 'completed', (await sess(B.sessionId)).status);
chk('the gateway tracks nothing once both finish', 0, (await conn()).transactions.length);

sim.close();
await sleep(400);

console.log(`\n=========== MULTI-CONNECTOR: ${pass} passed, ${fail} failed ===========`);
if (fail) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
