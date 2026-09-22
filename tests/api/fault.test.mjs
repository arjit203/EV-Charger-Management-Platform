/* Fault handling — the gap between "a plug is broken" and "the machine is broken".

   THE THREE BUGS THIS SUITE PINS DOWN, all of which pass silently against the old code:

     1. DROPPED       StatusNotification on connectorId 0 — which in OCPP 1.6 addresses the
                      CHARGE POINT ITSELF — was looked up as a connector, not found (plug
                      numbers start at 1), logged as "unknown connector 0" and answered OK.
                      The machine could announce a ground fault and still be offered to
                      drivers, every connector still reading `available`.

     2. ZOMBIE        A plug that faulted mid-charge wrote its own status and stopped there.
                      The session on it stayed `active` forever — the meter frozen, the
                      connector reserved — unless the charger happened to disconnect, which a
                      charger with one bad plug has no reason to do.

     3. SILENT        A fault reached nobody. It was emitted to whoever happened to have
                      /monitor open and was then gone; at 03:00 that is nobody at all.

   Every check below fails against the pre-fix code. */

import { createRequire } from 'module';
const require = createRequire(new URL('../../backend/', import.meta.url));
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://localhost:5000/api/v1';
const WS_BASE = process.env.WS_BASE || 'ws://localhost:5000/ocpp';
const S = String(Date.now()).slice(-6);
const PW = 'FaultPass12345';
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
    const uid = `f-${Math.random().toString(36).slice(2)}`;
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
console.log('=== SETUP (one charger, TWO connectors, staff + two drivers) ===');
const su = (await must('POST', '/auth/login', { body: { email: 'admin@evcms.local', password: 'Admin@12345' } })).token;
const company = (await must('POST', '/companies', { token: su, body: { name: `Fault Co ${S}`, type: 'CPO' } })).company;

const tariff = (await must('POST', '/tariffs', { token: su, body: { name: 'Fault Rate', pricePerKwh: 12, companyId: company.id } })).tariff;
await must('PATCH', `/tariffs/${tariff.id}/status`, { token: su, body: { status: 'active' } });

const station = (await must('POST', '/stations', { token: su, body: { name: `Fault Station ${S}`, stationCode: `FS-${S}`,
  address: '1 Fault Road', city: 'Delhi', state: 'Delhi', country: 'India', latitude: 28.6, longitude: 77.2, companyId: company.id } })).station;

const ch = await must('POST', '/chargers', { token: su, body: { stationId: station.id, name: `Fault Charger ${S}`,
  chargerCode: `CF-${S}`, ocppId: `OCPPF-${S}`, manufacturer: 'Delta', model: 'Sim', chargerType: 'DC', powerKw: 60 } });
const c1 = (await must('POST', `/chargers/${ch.charger.id}/connectors`, { token: su, body: { connectorNumber: 1, connectorType: 'CCS2', powerKw: 60 } })).connector;
const c2 = (await must('POST', `/chargers/${ch.charger.id}/connectors`, { token: su, body: { connectorNumber: 2, connectorType: 'CCS2', powerKw: 60 } })).connector;

// Staff, because a fault has to reach somebody who can act on it.
const staff = {};
for (const [key, role] of [['cpo', 'cpo_admin'], ['op', 'operator']]) {
  const email = `${key}.fault.${S}@test.local`;
  await must('POST', '/users', { token: su, body: { name: `Staff ${key}`, email, password: PW, role, companyId: company.id } });
  staff[key] = (await must('POST', '/auth/login', { body: { email, password: PW } })).token;
}

const drivers = [];
for (const key of ['fa', 'fb']) {
  const email = `${key}.fault.${S}@test.local`;
  await must('POST', '/auth/register', { body: { name: `Driver ${key}`, email, password: PW } });
  drivers.push((await must('POST', '/auth/login', { body: { email, password: PW } })).token);
}

const sim = new Sim(ch.charger.ocppId, ch.authToken);
await sim.connect();
sim.startHeartbeat();
await sim.send('BootNotification', { chargePointVendor: 'Test', chargePointModel: 'FAULT' });
await sim.send('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' });
await sim.send('StatusNotification', { connectorId: 2, status: 'Available', errorCode: 'NoError' });
await sleep(300);

const charger = async () => (await must('GET', `/chargers/${ch.charger.id}`, { token: su })).charger;
const connectors = async () => (await must('GET', `/chargers/${ch.charger.id}/connectors`, { token: su })).connectors;
const connectorStatus = async (n) => (await connectors()).find((c) => c.connectorNumber === n)?.status;
const sess = async (id) => (await must('GET', `/charging/sessions/${id}`, { token: su })).session;
const view = async (connectorId, token) => (await must('GET', `/charging/connectors/${connectorId}`, { token })).connector;
const faultNotes = async (token) =>
  (await must('GET', '/notifications?limit=50', { token })).items.filter((n) => n.type === 'charger_fault');

async function startOn(connectorId, connectorNumber, token, meterStart) {
  const req = call('POST', '/charging/sessions', { token, body: { connectorId } });
  const cmd = await sim.waitForCall('RemoteStartTransaction');
  sim.reply(cmd.uid, { status: 'Accepted' });
  const res = await req;
  if (res.status >= 400) throw new Error(`start refused: ${JSON.stringify(res.body)}`);
  await sim.send('Authorize', { idTag: cmd.payload.idTag });
  const st = await sim.send('StartTransaction', { connectorId: connectorNumber, idTag: cmd.payload.idTag,
    meterStart, timestamp: new Date().toISOString() });
  await sim.send('StatusNotification', { connectorId: connectorNumber, status: 'Charging', errorCode: 'NoError' });
  await sleep(200);
  return { sessionId: res.body.data.session.id, transactionId: st[2].transactionId };
}

/* ============================================================ BASELINE == */
console.log('\n=== BASELINE — a healthy charger reports itself operative ===');
chk('1. a new charger starts operative', 'operative', (await charger()).hardwareStatus);
chk('   with no fault code', null, (await charger()).faultCode);
chk('   and no fault timestamp', null, (await charger()).faultReportedAt);
chk('2. a driver can start on it', true, (await view(c1.id, drivers[0])).canStart);

/* ====================================== THE MACHINE FAULTS, PLUGS DO NOT = */
console.log('\n=== CHARGE POINT FAULT (connectorId 0) — the case that used to vanish ===');
const adminStatusBefore = (await charger()).status;
const before = Date.now();

const cpFault = await sim.send('StatusNotification', { connectorId: 0, status: 'Faulted', errorCode: 'GroundFailure' });
await sleep(350);

chk('3. connectorId 0 is ACCEPTED, not an error', 3, cpFault[0]);
chk('4. the charger records the fault', 'faulted', (await charger()).hardwareStatus);
chk('5. the OCPP error code is kept for the engineer', 'GroundFailure', (await charger()).faultCode);
chk('6. and the time it started', true, new Date((await charger()).faultReportedAt).getTime() >= before - 1000);

chk('7. the ADMIN status is untouched — the machine does not overrule a person',
  adminStatusBefore, (await charger()).status);
chk('8. connector 1 still reads available — the plugs really are fine', 'available', await connectorStatus(1));
chk('   connector 2 too', 'available', await connectorStatus(2));

console.log('\n--- and the whole point: a healthy plug on a faulted machine refuses starts ---');
const faultedView = await view(c1.id, drivers[0]);
chk('9. canStart is false even though the connector is available', false, faultedView.canStart);
chk('10. and the reason names the CHARGER fault, not the plug', true,
  /charger .*fault/i.test(faultedView.unavailableReason || ''));
chk('11. the error code reaches the driver', true, (faultedView.unavailableReason || '').includes('GroundFailure'));
chk('12. the view carries the machine status separately from the plug status',
  ['faulted', 'available'], [faultedView.chargerHardwareStatus, faultedView.status]);

chk('13. and the API refuses an actual start attempt', 409,
  (await call('POST', '/charging/sessions', { token: drivers[0], body: { connectorId: c1.id } })).status);

console.log('\n--- staff are told, once ---');
chk('14. the cpo_admin was notified', 1, (await faultNotes(staff.cpo)).length);
chk('15. the operator was notified too', 1, (await faultNotes(staff.op)).length);
chk('   it points at the charger', ['charger', ch.charger.id],
  [(await faultNotes(staff.cpo))[0].referenceType, (await faultNotes(staff.cpo))[0].referenceId]);
chk('   and names the error code', true, (await faultNotes(staff.cpo))[0].message.includes('GroundFailure'));

console.log('\n--- a charger repeating itself is not a new fault ---');
const reportedAt = (await charger()).faultReportedAt;
await sim.send('StatusNotification', { connectorId: 0, status: 'Faulted', errorCode: 'GroundFailure' });
await sim.send('StatusNotification', { connectorId: 0, status: 'Faulted', errorCode: 'GroundFailure' });
await sleep(350);
chk('16. repeats do not move the fault start time', reportedAt, (await charger()).faultReportedAt);
chk('17. and do not re-notify anyone', 1, (await faultNotes(staff.cpo)).length);

console.log('\n--- recovery ---');
await sim.send('StatusNotification', { connectorId: 0, status: 'Available', errorCode: 'NoError' });
await sleep(350);
chk('18. reporting healthy clears the fault', 'operative', (await charger()).hardwareStatus);
chk('   and the code', null, (await charger()).faultCode);
chk('   and the timestamp', null, (await charger()).faultReportedAt);
chk('19. the driver can start again', true, (await view(c1.id, drivers[0])).canStart);

/* ============================= A PLUG FAULTS MID-CHARGE, ITS NEIGHBOUR DOES NOT = */
console.log('\n=== CONNECTOR FAULT MID-CHARGE — one plug dies, the other keeps charging ===');
const A = await startOn(c1.id, 1, drivers[0], 0);
const B = await startOn(c2.id, 2, drivers[1], 5000);
chk('20. both sessions are active', ['active', 'active'],
  [(await sess(A.sessionId)).status, (await sess(B.sessionId)).status]);

await sim.send('MeterValues', { connectorId: 1, energyWh: 400, timestamp: new Date().toISOString() });
await sleep(250);

// No StopTransaction — a plug whose lock has failed cannot always close cleanly, and that is
// exactly the case the old code left hanging.
await sim.send('StatusNotification', { connectorId: 1, status: 'Faulted', errorCode: 'ConnectorLockFailure' });
await sleep(500);

const failedSession = await sess(A.sessionId);
chk('21. the faulted plug ENDS its session — no StopTransaction needed', 'failed', failedSession.status);
chk('22. the stop reason says why', 'HardwareFault', failedSession.stopReason);
chk('23. the energy already delivered is kept, not discarded', 400, failedSession.energyConsumedWh);
chk('24. and the reason names the connector', true, /connector 1/i.test(failedSession.failureReason || ''));

chk('25. the NEIGHBOUR is untouched and still charging', 'active', (await sess(B.sessionId)).status);
chk('26. connector 2 still reads charging', 'charging', await connectorStatus(2));
chk('27. the machine itself is NOT marked faulted by a plug fault', 'operative', (await charger()).hardwareStatus);

await sim.send('MeterValues', { connectorId: 2, energyWh: 5400, timestamp: new Date().toISOString() });
await sleep(350);
chk('28. and it keeps metering normally', 400, (await sess(B.sessionId)).energyConsumedWh);

chk('29. staff were told about the connector fault too', 2, (await faultNotes(staff.cpo)).length);
chk('   the newest names the plug', true, /connector 1/i.test((await faultNotes(staff.cpo))[0].message));

console.log('\n--- the faulted plug refuses new starts, its neighbour does not ---');
chk('30. connector 1 cannot start', false, (await view(c1.id, drivers[0])).canStart);
chk('31. connector 2 is busy rather than broken', true,
  /in use/i.test((await view(c2.id, drivers[1])).unavailableReason || ''));

/* ================================================ MACHINE FAULT KILLS ALL = */
console.log('\n=== A CHARGE POINT FAULT ENDS EVERY SESSION ON THE MACHINE ===');
await sim.send('StatusNotification', { connectorId: 0, status: 'Faulted', errorCode: 'OverTemperature' });
await sleep(600);

const killed = await sess(B.sessionId);
chk('32. the surviving session is ended by the machine fault', 'failed', killed.status);
chk('33. with the hardware stop reason', 'HardwareFault', killed.stopReason);
chk('34. and a reason naming the charger', true, /charger/i.test(killed.failureReason || ''));
chk('35. the energy is preserved', 400, killed.energyConsumedWh);

/* ============================================================== UNAVAILABLE = */
console.log('\n=== SELF-REPORTED UNAVAILABLE IS NOT A FAULT ===');
await sim.send('StatusNotification', { connectorId: 0, status: 'Available', errorCode: 'NoError' });
await sleep(300);
await sim.send('StatusNotification', { connectorId: 0, status: 'Unavailable', errorCode: 'NoError' });
await sleep(300);

chk('36. the machine can take itself out of service', 'unavailable', (await charger()).hardwareStatus);
chk('37. which still blocks starts', false, (await view(c2.id, drivers[1])).canStart);
chk('38. but carries no fault code — nothing is broken', null, (await charger()).faultCode);

/* ============================================================ NONSENSE ==== */
console.log('\n=== A STATUS THAT CANNOT DESCRIBE A MACHINE IS IGNORED, NOT INVENTED ===');
const nonsense = await sim.send('StatusNotification', { connectorId: 0, status: 'Charging', errorCode: 'NoError' });
await sleep(300);
chk('39. `Charging` on connectorId 0 is accepted at the protocol level', 3, nonsense[0]);
chk('40. and changes nothing — there is no such thing as a charging machine',
  'unavailable', (await charger()).hardwareStatus);

/* ---------------------------------------------------------- teardown --- */
await sim.send('StatusNotification', { connectorId: 0, status: 'Available', errorCode: 'NoError' });
await sleep(200);
sim.close();
await sleep(400);

console.log(`\n=========== FAULT HANDLING: ${pass} passed, ${fail} failed ===========`);
if (fail) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
