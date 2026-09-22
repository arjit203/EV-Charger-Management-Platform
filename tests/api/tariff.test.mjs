/* Module 9 verification — tariffs and session pricing.
   Real OCPP WebSocket sessions, real money arithmetic end to end. */

import { createRequire } from 'module';
const require = createRequire(new URL('../../backend/', import.meta.url));
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://localhost:5000/api/v1';
const WS_BASE = process.env.WS_BASE || 'ws://localhost:5000/ocpp';
const S = String(Date.now()).slice(-6);
const PW = 'TariffPass12345';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0; const failures = [];
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
    const uid = `t9-${Math.random().toString(36).slice(2)}`;
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
const mkCompany = async (l) => (await must('POST', '/companies', { token: su, body: { name: `${l} ${S}`, type: 'CPO' } })).company.id;
const A = await mkCompany('M9 Alpha');
const B = await mkCompany('M9 Beta');
const C = await mkCompany('M9 Priceless');   // deliberately never gets a tariff

const staff = {};
for (const [key, companyId, role] of [['cpoA', A, 'cpo_admin'], ['opA', A, 'operator'], ['cpoB', B, 'cpo_admin']]) {
  const email = `${key}.m9.${S}@test.local`;
  await must('POST', '/users', { token: su, body: { name: `Staff ${key}`, email, password: PW, role, companyId } });
  staff[key] = { token: (await must('POST', '/auth/login', { body: { email, password: PW } })).token };
}
const dEmail = `driver.m9.${S}@test.local`;
await must('POST', '/auth/register', { body: { name: 'M9 Driver', email: dEmail, password: PW } });
const driver = (await must('POST', '/auth/login', { body: { email: dEmail, password: PW } })).token;

const mkStation = async (companyId, code) => (await must('POST', '/stations', { token: su, body: {
  name: `Station ${code}`, stationCode: code, address: '1 Price Road', city: 'Delhi', state: 'Delhi',
  country: 'India', latitude: 28.6, longitude: 77.2, companyId } })).station.id;
const mkCharger = async (stationId, code) => {
  const r = await must('POST', '/chargers', { token: su, body: { stationId, name: `Charger ${code}`,
    chargerCode: code, ocppId: `OCPP9-${code}`, manufacturer: 'Delta', model: 'Sim', chargerType: 'DC', powerKw: 60 } });
  return { id: r.charger.id, ocppId: r.charger.ocppId, token: r.authToken };
};
const STA = await mkStation(A, `S9A-${S}`);
const STC = await mkStation(C, `S9C-${S}`);
const chA = await mkCharger(STA, `C9A-${S}`);
const chC = await mkCharger(STC, `C9C-${S}`);
const conA = (await must('POST', `/chargers/${chA.id}/connectors`, { token: su, body: { connectorNumber: 1, connectorType: 'CCS2', powerKw: 60 } })).connector.id;
const conC = (await must('POST', `/chargers/${chC.id}/connectors`, { token: su, body: { connectorNumber: 1, connectorType: 'CCS2', powerKw: 60 } })).connector.id;

const tariffOf = async (id, token = su) => (await call('GET', `/tariffs/${id}`, { token })).body?.data?.tariff;
const sess = async (id) => (await call('GET', `/charging/sessions/${id}`, { token: su })).body.data.session;

/* ------------------------------------------------------------- TARIFF CRUD */
console.log('\n=== TARIFF CRUD & ROLES ===');
const created = await call('POST', '/tariffs', { token: staff.cpoA.token, body: { name: 'Standard DC', pricePerKwh: 12 } });
chk('5. cpo_admin creates a tariff for their own company -> 201', 201, created.status);
const tA = created.body.data.tariff;
chk('   ₹12 is stored as 1200 paise', 1200, tA.pricePerKwhPaise);
chk('   and echoed back as rupees for display', 12, tA.pricePerKwhRupees);
chk('   companyId comes from the account, not the body', A, tA.companyId);
chk('   a new tariff starts INACTIVE', 'inactive', tA.status);

chk('1. super_admin creates a tariff for a named company', 201,
  (await call('POST', '/tariffs', { token: su, body: { name: 'Beta Rate', pricePerKwh: 20, companyId: B } })).status);
chk('   super_admin must name a company -> 422', 422,
  (await call('POST', '/tariffs', { token: su, body: { name: 'Homeless', pricePerKwh: 10 } })).status);
chk('   cpo_admin sending companyId is REJECTED, not stripped -> 422', 422,
  (await call('POST', '/tariffs', { token: staff.cpoA.token, body: { name: 'Sneaky', pricePerKwh: 10, companyId: B } })).status);

chk('8. driver cannot create a tariff -> 403', 403,
  (await call('POST', '/tariffs', { token: driver, body: { name: 'Free', pricePerKwh: 1 } })).status);
chk('7. operator can READ tariffs', 200, (await call('GET', '/tariffs', { token: staff.opA.token })).status);
chk('   operator cannot create -> 403', 403,
  (await call('POST', '/tariffs', { token: staff.opA.token, body: { name: 'Op', pricePerKwh: 5 } })).status);
chk('   operator cannot update -> 403', 403,
  (await call('PATCH', `/tariffs/${tA.id}`, { token: staff.opA.token, body: { pricePerKwh: 5 } })).status);
chk('   operator cannot activate -> 403', 403,
  (await call('PATCH', `/tariffs/${tA.id}/status`, { token: staff.opA.token, body: { status: 'active' } })).status);
chk('9. anonymous -> 401', 401, (await call('GET', '/tariffs')).status);

chk('3. update the name and rate', 200,
  (await call('PATCH', `/tariffs/${tA.id}`, { token: staff.cpoA.token, body: { pricePerKwh: 12.5 } })).status);
chk('   ₹12.50 is exactly 1250 paise', 1250, (await tariffOf(tA.id)).pricePerKwhPaise);
await call('PATCH', `/tariffs/${tA.id}`, { token: staff.cpoA.token, body: { pricePerKwh: 12 } });

/* --------------------------------------------------------- COMPANY SCOPING */
console.log('\n=== COMPANY ISOLATION ===');
chk('6/26. rival CPO cannot read company A tariff -> 403', 403,
  (await call('GET', `/tariffs/${tA.id}`, { token: staff.cpoB.token })).status);
chk('   rival CPO cannot edit it -> 403', 403,
  (await call('PATCH', `/tariffs/${tA.id}`, { token: staff.cpoB.token, body: { pricePerKwh: 1 } })).status);
chk('   rival CPO cannot activate it -> 403', 403,
  (await call('PATCH', `/tariffs/${tA.id}/status`, { token: staff.cpoB.token, body: { status: 'active' } })).status);
chk('   a non-existent id is ALSO 403 for a scoped caller (no probing)', 403,
  (await call('GET', `/tariffs/${'0'.repeat(24)}`, { token: staff.cpoB.token })).status);
chk('   but 404 for super_admin', 404,
  (await call('GET', `/tariffs/${'0'.repeat(24)}`, { token: su })).status);
const bList = (await call('GET', '/tariffs', { token: staff.cpoB.token })).body.data;
chk('   rival list never contains company A', false, bList.items.some((t) => t.companyId === A));

/* ---------------------------------------------------------- VALIDATION ---- */
console.log('\n=== VALIDATION ===');
chk('10. negative price rejected -> 422', 422,
  (await call('POST', '/tariffs', { token: staff.cpoA.token, body: { name: 'Neg', pricePerKwh: -5 } })).status);
chk('10. zero price rejected -> 422', 422,
  (await call('POST', '/tariffs', { token: staff.cpoA.token, body: { name: 'Zero', pricePerKwh: 0 } })).status);
chk('11. absurd price rejected -> 422', 422,
  (await call('POST', '/tariffs', { token: staff.cpoA.token, body: { name: 'Absurd', pricePerKwh: 99999 } })).status);
chk('11. missing name rejected -> 422', 422,
  (await call('POST', '/tariffs', { token: staff.cpoA.token, body: { pricePerKwh: 10 } })).status);
chk('11. one-character name rejected -> 422', 422,
  (await call('POST', '/tariffs', { token: staff.cpoA.token, body: { name: 'X', pricePerKwh: 10 } })).status);
chk('   status cannot be set on create -> 422', 422,
  (await call('POST', '/tariffs', { token: staff.cpoA.token, body: { name: 'Forced', pricePerKwh: 10, status: 'active' } })).status);
chk('12. invalid companyId rejected -> 422', 422,
  (await call('POST', '/tariffs', { token: su, body: { name: 'Bad', pricePerKwh: 10, companyId: 'nope' } })).status);
chk('12. unknown companyId -> 404', 404,
  (await call('POST', '/tariffs', { token: su, body: { name: 'Ghost', pricePerKwh: 10, companyId: '0'.repeat(24) } })).status);
chk('   empty update rejected -> 422', 422,
  (await call('PATCH', `/tariffs/${tA.id}`, { token: staff.cpoA.token, body: {} })).status);
chk('   invalid status value -> 422', 422,
  (await call('PATCH', `/tariffs/${tA.id}/status`, { token: staff.cpoA.token, body: { status: 'maybe' } })).status);

/* ------------------------------------------------- ONE ACTIVE PER COMPANY - */
console.log('\n=== ONE ACTIVE TARIFF PER COMPANY (database-enforced) ===');
chk('4. activate the first tariff', 200,
  (await call('PATCH', `/tariffs/${tA.id}/status`, { token: staff.cpoA.token, body: { status: 'active' } })).status);
chk('   it is now active', 'active', (await tariffOf(tA.id)).status);

const t2 = (await must('POST', '/tariffs', { token: staff.cpoA.token, body: { name: 'Peak DC', pricePerKwh: 18 } })).tariff;
chk('13. activating a second one SWAPS rather than duplicating', 200,
  (await call('PATCH', `/tariffs/${t2.id}/status`, { token: staff.cpoA.token, body: { status: 'active' } })).status);
chk('   the new one is active', 'active', (await tariffOf(t2.id)).status);
chk('   the old one was deactivated automatically', 'inactive', (await tariffOf(tA.id)).status);

const activeList = (await call('GET', '/tariffs?status=active', { token: staff.cpoA.token })).body.data;
chk('13. exactly ONE active tariff exists for the company', 1, activeList.items.length);

// The race: several simultaneous activations. Exactly one may end up active.
const t3 = (await must('POST', '/tariffs', { token: staff.cpoA.token, body: { name: 'Race A', pricePerKwh: 15 } })).tariff;
const t4 = (await must('POST', '/tariffs', { token: staff.cpoA.token, body: { name: 'Race B', pricePerKwh: 16 } })).tariff;
await Promise.all([
  call('PATCH', `/tariffs/${t3.id}/status`, { token: staff.cpoA.token, body: { status: 'active' } }),
  call('PATCH', `/tariffs/${t4.id}/status`, { token: staff.cpoA.token, body: { status: 'active' } }),
]);
const afterRace = (await call('GET', '/tariffs?status=active', { token: staff.cpoA.token })).body.data;
chk('   after two simultaneous activations, still exactly one active', 1, afterRace.items.length);

// Settle on ₹12 for the pricing tests.
await call('PATCH', `/tariffs/${tA.id}/status`, { token: staff.cpoA.token, body: { status: 'active' } });
chk('   settled back on the ₹12 tariff', 1200, (await tariffOf(tA.id)).pricePerKwhPaise);

/* ------------------------------------------------- NO TARIFF = NO CHARGING - */
console.log('\n=== A COMPANY WITH NO PRICE CANNOT SELL ELECTRICITY ===');
const simC = new Sim(chC.ocppId, chC.token);
await simC.connect();
simC.startHeartbeat();
await simC.send('BootNotification', { chargePointVendor: 'T', chargePointModel: 'M9' });
await simC.send('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' });
await sleep(400);

const viewC = (await call('GET', `/charging/connectors/${conC}`, { token: driver })).body.data.connector;
chk('18. an unpriced connector reports no rate', null, viewC.pricePerKwhPaise);
chk('18. and cannot be started', false, viewC.canStart);
chk('18. with a reason a driver can act on', true, /price/i.test(viewC.unavailableReason ?? ''));
chk('18. starting there is refused -> 409', 409,
  (await call('POST', '/charging/sessions', { token: driver, body: { connectorId: conC } })).status);
simC.close();
await sleep(300);

/* ------------------------------------------------------- PRICED SESSIONS -- */
console.log('\n=== PRICING A REAL CHARGE ===');
const sim = new Sim(chA.ocppId, chA.token);
await sim.connect();
sim.startHeartbeat();
await sim.send('BootNotification', { chargePointVendor: 'T', chargePointModel: 'M9' });
await sim.send('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' });
await sleep(400);

const viewA = (await call('GET', `/charging/connectors/${conA}`, { token: driver })).body.data.connector;
chk('   the driver sees the rate before starting', 1200, viewA.pricePerKwhPaise);
chk('   and can start', true, viewA.canStart);

async function charge({ meterStart, meterStop }) {
  const req = call('POST', '/charging/sessions', { token: driver, body: { connectorId: conA } });
  const cmd = await sim.waitForCall('RemoteStartTransaction');
  sim.reply(cmd.uid, { status: 'Accepted' });
  const res = await req;
  const id = res.body.data.session.id;
  await sim.send('Authorize', { idTag: cmd.payload.idTag });
  const st = await sim.send('StartTransaction', { connectorId: 1, idTag: cmd.payload.idTag, meterStart, timestamp: new Date().toISOString() });
  const txn = st[2].transactionId;
  await sim.send('StatusNotification', { connectorId: 1, status: 'Charging', errorCode: 'NoError' });
  return { id, txn, started: res.body.data.session };
}
async function finish(txn, meterStop) {
  await sim.send('StopTransaction', { transactionId: txn, meterStop, reason: 'Remote', timestamp: new Date().toISOString() });
  await sim.send('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' });
  await sleep(500);
}

// 10.00 kWh -> 12.50 kWh = 2.50 kWh at ₹12/kWh = ₹30.00 exactly.
const c1 = await charge({ meterStart: 10000, meterStop: 12500 });
chk('22/24. the rate is snapshotted onto the session at START', 1200, c1.started.appliedPricePerKwhPaise);
chk('24. and the tariff id kept as provenance', tA.id, c1.started.appliedTariffId);
chk('   amount is null while charging', null, c1.started.amountPaise);
await finish(c1.txn, 12500);

const done1 = await sess(c1.id);
chk('15/23. 2.50 kWh x ₹12 = 3000 paise exactly', 3000, done1.amountPaise);
chk('   energy really was 2.50 kWh', 2.5, done1.energyConsumedKwh);
chk('17. and renders as ₹30.00', 30, done1.amountRupees);
chk('   the amount is an integer number of paise', true, Number.isInteger(done1.amountPaise));

// 2.5 kWh at ₹10 = ₹25.00  (rate changed between sessions)
await call('PATCH', `/tariffs/${tA.id}`, { token: staff.cpoA.token, body: { pricePerKwh: 10 } });
const c2 = await charge({ meterStart: 0, meterStop: 2500 });
chk('   the new session picked up the NEW rate', 1000, c2.started.appliedPricePerKwhPaise);
await finish(c2.txn, 2500);
chk('16. 2.5 kWh x ₹10 = 2500 paise', 2500, (await sess(c2.id)).amountPaise);

// 4.75 kWh at ₹10 = ₹47.50 — the decimal case.
const c3 = await charge({ meterStart: 0, meterStop: 4750 });
await finish(c3.txn, 4750);
const done3 = await sess(c3.id);
chk('17. 4.75 kWh x ₹10 = 4750 paise (₹47.50)', 4750, done3.amountPaise);
chk('   not 4749.99...', true, Number.isInteger(done3.amountPaise));

/* ------------------------------------------ DETERMINISM UNDER TARIFF CHANGE */
console.log('\n=== A TARIFF CHANGE MUST NOT REPRICE A RUNNING SESSION ===');
const c4 = await charge({ meterStart: 0, meterStop: 2000 });
chk('   started at ₹10/kWh', 1000, c4.started.appliedPricePerKwhPaise);

// Mid-charge: the operator doubles the price, then retires the tariff entirely.
await call('PATCH', `/tariffs/${tA.id}`, { token: staff.cpoA.token, body: { pricePerKwh: 20 } });
const t5 = (await must('POST', '/tariffs', { token: staff.cpoA.token, body: { name: 'Hiked', pricePerKwh: 25 } })).tariff;
await call('PATCH', `/tariffs/${t5.id}/status`, { token: staff.cpoA.token, body: { status: 'active' } });
chk('   the original tariff has been deactivated mid-charge', 'inactive', (await tariffOf(tA.id)).status);

await finish(c4.txn, 2000);
const done4 = await sess(c4.id);
chk('25. the running session kept its ORIGINAL rate', 1000, done4.appliedPricePerKwhPaise);
chk('25. 2.0 kWh x ₹10 = 2000 paise, not 4000 or 5000', 2000, done4.amountPaise);
chk('   even though the tariff it quotes is now inactive', 'inactive', (await tariffOf(tA.id)).status);

/* ------------------------------------------------- RE-SAVE MUST NOT REPRICE */
console.log('\n=== AN ALREADY-PRICED SESSION IS FINAL ===');
const before = await sess(done4.id ?? c4.id);
// A late MeterValues forces another save on the completed session.
await sim.send('MeterValues', { connectorId: 1, transactionId: c4.txn, energyWh: 9999, timestamp: new Date().toISOString() });
await sleep(500);
const after = await sess(c4.id);
chk('   a later save leaves the amount untouched', before.amountPaise, after.amountPaise);
chk('   and the energy total untouched', before.energyConsumedWh, after.energyConsumedWh);

/* --------------------------------------------------- FAILED SESSIONS PRICED */
console.log('\n=== A FAILED SESSION IS STILL PRICED (real energy was delivered) ===');
await call('PATCH', `/tariffs/${t5.id}`, { token: staff.cpoA.token, body: { pricePerKwh: 12 } });
const c5 = await charge({ meterStart: 0, meterStop: 0 });
chk('   started at ₹12/kWh', 1200, c5.started.appliedPricePerKwhPaise);
await sim.send('MeterValues', { connectorId: 1, transactionId: c5.txn, energyWh: 400, timestamp: new Date().toISOString() });
await sleep(400);

sim.close();            // the charger vanishes mid-charge
await sleep(1200);

const dead = await sess(c5.id);
chk('   the session failed', 'failed', dead.status);
chk('   0.4 kWh was delivered', 400, dead.energyConsumedWh);
chk('   and it is billed, not written off: 0.4 x ₹12 = 480 paise', 480, dead.amountPaise);

/* ------------------------------------------- CLIENT CANNOT SET THE AMOUNT - */
console.log('\n=== THE CLIENT NEVER SETS THE PRICE ===');
chk('21. amountPaise in a start body -> 422', 422,
  (await call('POST', '/charging/sessions', { token: driver, body: { connectorId: conA, amountPaise: 1 } })).status);
chk('21. appliedPricePerKwhPaise in a start body -> 422', 422,
  (await call('POST', '/charging/sessions', { token: driver, body: { connectorId: conA, appliedPricePerKwhPaise: 1 } })).status);
chk('20. every amount so far was computed server-side', true,
  [done1, done3, done4].every((s) => Number.isInteger(s.amountPaise) && s.amountPaise > 0));

/* ------------------------------------------------ CROSS-COMPANY PRICING --- */
console.log('\n=== A SESSION IS PRICED BY THE STATION OWNER, NOT THE DRIVER ===');
chk('27. company A session used company A rate', A, done1.companyId);
chk('27. and never company B rate (₹20)', false, [done1, done3, done4].some((s) => s.appliedPricePerKwhPaise === 2000));

console.log(`\n=========== MODULE 9: ${pass} passed, ${fail} failed ===========`);
if (fail) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
