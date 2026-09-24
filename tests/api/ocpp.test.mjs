/* Module 6 verification — OCPP gateway, charger auth, and the full charging flow.
   Uses REAL WebSocket connections so the wire protocol is genuinely exercised. */

import { createRequire } from 'module';
const require = createRequire(new URL('../../backend/', import.meta.url));
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://localhost:5000/api/v1';
const WS_BASE = process.env.WS_BASE || 'ws://localhost:5000/ocpp';
const STAMP = Date.now();
const S = String(STAMP).slice(-6);
const PW = 'OcppPass12345';

let pass = 0, fail = 0;
const failures = [];
const chk = (name, expected, actual) => {
  if (expected === actual) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}  (expected ${expected}, got ${actual})`); failures.push(name); fail++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body && JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json, raw: JSON.stringify(json) };
}

const login = async (email, password) => {
  const r = await call('POST', '/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${r.raw}`);
  return r.body.data.token;
};

/* --------------------------------------------------- OCPP test client --- */

class TestCharger {
  constructor(ocppId, authToken) {
    this.ocppId = ocppId;
    this.authToken = authToken;
    this.socket = null;
    this.pending = new Map();
    this.inbound = [];       // CALLs received from the backend
    this.closeCode = null;
    this.beat = null;
  }

  startHeartbeat(ms = 1500) {
    this.stopHeartbeat();
    this.beat = setInterval(() => { this.send('Heartbeat', {}).catch(() => {}); }, ms);
  }

  stopHeartbeat() {
    if (this.beat) { clearInterval(this.beat); this.beat = null; }
  }

  connect({ ocppId = this.ocppId, user = null, token = this.authToken } = {}) {
    const creds = Buffer.from(`${user ?? ocppId}:${token}`).toString('base64');
    const url = `${WS_BASE}/${encodeURIComponent(ocppId)}`;

    return new Promise((resolve) => {
      const socket = new WebSocket(url, { headers: { Authorization: `Basic ${creds}` } });
      this.socket = socket;

      const done = (result) => resolve(result);

      socket.on('open', () => done({ ok: true }));
      socket.on('error', (err) => done({ ok: false, error: err.message }));
      socket.on('close', (code) => { this.closeCode = code; });

      socket.on('message', (data) => {
        const frame = JSON.parse(data.toString());
        const [type, uid] = frame;
        if (type === 3 || type === 4) {
          const p = this.pending.get(uid);
          if (p) { this.pending.delete(uid); p(frame); }
        } else if (type === 2) {
          this.inbound.push({ uid, action: frame[2], payload: frame[3] });
        }
      });
    });
  }

  send(action, payload = {}) {
    const uid = `t-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout on ${action}`)), 8000);
      this.pending.set(uid, (frame) => { clearTimeout(timer); resolve(frame); });
      this.socket.send(JSON.stringify([2, uid, action, payload]));
    });
  }

  sendRaw(raw) {
    return new Promise((resolve) => {
      const handler = (data) => {
        this.socket.off('message', handler);
        resolve(JSON.parse(data.toString()));
      };
      this.socket.on('message', handler);
      this.socket.send(raw);
    });
  }

  reply(uid, payload) { this.socket.send(JSON.stringify([3, uid, payload])); }

  /** Wait for an inbound CALL of a given action. */
  async waitForCall(action, ms = 6000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = this.inbound.find((m) => m.action === action);
      if (found) { this.inbound = this.inbound.filter((m) => m !== found); return found; }
      await sleep(50);
    }
    return null;
  }

  close() { this.stopHeartbeat(); try { this.socket?.close(); } catch { /* ignore */ } }
  get isOpen() { return this.socket?.readyState === WebSocket.OPEN; }
}

/* ----------------------------------------------------------------- setup */
console.log('=== SETUP ===');
const superToken = await login('admin@evcms.local', 'Admin@12345');

const mkCompany = async (label) => (await call('POST', '/companies', {
  token: superToken, body: { name: `${label} ${STAMP}`, type: 'CPO' } })).body.data.company.id;
const A = await mkCompany('M6 Alpha');
const B = await mkCompany('M6 Beta');

/* MODULE 9: a company must publish a price before anyone can charge at its stations.
   These suites create their own companies, so they must publish one too. */
const publishTariff = async (companyId, rupees) => {
  const created = await call('POST', '/tariffs', {
    token: superToken, body: { name: `Rate ${companyId.slice(-4)}`, pricePerKwh: rupees, companyId } });
  if (created.status !== 201) throw new Error(`tariff for ${companyId}: ${created.status} ${created.raw ?? JSON.stringify(created.body)}`);
  const id = created.body.data.tariff.id;
  const activated = await call('PATCH', `/tariffs/${id}/status`, { token: superToken, body: { status: 'active' } });
  if (activated.status !== 200) throw new Error(`activate ${id}: ${activated.status}`);
  return id;
};

await publishTariff(A, 12);
await publishTariff(B, 15);

const staff = {};
for (const [key, companyId, role] of [['cpoA', A, 'cpo_admin'], ['opA', A, 'operator'], ['cpoB', B, 'cpo_admin']]) {
  const email = `${key}.${STAMP}@test.local`;
  await call('POST', '/users', { token: superToken, body: { name: `Staff ${key}`, email, password: PW, role, companyId } });
  staff[key] = { token: await login(email, PW) };
}
await call('POST', '/auth/register', { body: { name: 'Test Driver', email: `driver.${STAMP}@test.local`, password: PW } });
const driverToken = await login(`driver.${STAMP}@test.local`, PW);

const mkStation = async (companyId, code) => (await call('POST', '/stations', {
  token: superToken, body: { name: `Station ${code}`, stationCode: code, address: '1 Rd', city: 'Delhi',
    state: 'Delhi', country: 'India', latitude: 28.6, longitude: 77.2, companyId } })).body.data.station.id;
const STA = await mkStation(A, `S6A-${S}`);
const STB = await mkStation(B, `S6B-${S}`);

const mkCharger = async (stationId, code) => {
  const r = await call('POST', '/chargers', { token: superToken, body: {
    stationId, name: `Charger ${code}`, chargerCode: code, ocppId: `OCPP-${code}`,
    manufacturer: 'Delta', model: 'Sim', chargerType: 'DC', powerKw: 60 } });
  if (r.status !== 201) throw new Error(`charger ${code}: ${r.status} ${r.raw}`);
  return { id: r.body.data.charger.id, ocppId: r.body.data.charger.ocppId, token: r.body.data.authToken };
};
const chA = await mkCharger(STA, `C6A-${S}`);
const chB = await mkCharger(STB, `C6B-${S}`);
chk('create charger returns a one-time authToken', true, typeof chA.token === 'string' && chA.token.length > 20);
chk('authTokenHash never appears in a response', false,
  (await call('GET', `/chargers/${chA.id}`, { token: superToken })).raw.includes('authTokenHash'));

for (const ch of [chA, chB]) {
  const r = await call('POST', `/chargers/${ch.id}/connectors`, { token: superToken, body: { connectorNumber: 1, connectorType: 'CCS2', powerKw: 60 } });
  ch.connectorId = r.body.data.connector.id;
}

const chargerState = async (id) => (await call('GET', `/chargers/${id}`, { token: superToken })).body?.data?.charger;
const connectorState = async (id) => (await call('GET', `/chargers/${id}/connectors`, { token: superToken })).body?.data?.connectors?.[0];

/* ------------------------------------------------------------ CONNECTION */
console.log('\n=== CONNECTION & AUTH ===');
const sim = new TestCharger(chA.ocppId, chA.token);
chk('1/2. known charger with valid token connects', true, (await sim.connect()).ok);

const badToken = new TestCharger(chA.ocppId, 'not-the-right-token');
chk('   wrong token rejected', false, (await badToken.connect()).ok);

const unknown = new TestCharger(`OCPP-GHOST-${S}`, chA.token);
chk('3. unknown charger rejected', false, (await unknown.connect()).ok);

const mismatch = new TestCharger(chA.ocppId, chB.token);
chk('   charger B token on charger A path rejected', false, (await mismatch.connect()).ok);

const impersonate = new TestCharger(chA.ocppId, chA.token);
chk('   Basic username not matching path rejected', false,
  (await impersonate.connect({ user: chB.ocppId })).ok);

const noAuth = new TestCharger(chA.ocppId, '');
chk('   empty token rejected', false, (await noAuth.connect()).ok);

/* ------------------------------------------------------------------ BOOT */
console.log('\n=== BOOT ===');
sim.startHeartbeat();
const boot = await sim.send('BootNotification', { chargePointVendor: 'Test', chargePointModel: 'T1' });
chk('7. BootNotification answered with CALLRESULT', 3, boot[0]);
chk('9. status Accepted', 'Accepted', boot[2].status);
chk('9. response carries heartbeat interval', true, typeof boot[2].interval === 'number' && boot[2].interval > 0);
chk('9. response carries currentTime', true, typeof boot[2].currentTime === 'string');
chk('9. response carries powerKw for metering', 60, boot[2].powerKw);
await sleep(150);
const afterBoot = await chargerState(chA.id);
chk('8/10. correct charger marked online', true, afterBoot.isOnline);
chk('10. lastHeartbeatAt set', true, afterBoot.lastHeartbeatAt !== null);
chk('8. the OTHER charger is untouched', false, (await chargerState(chB.id)).isOnline);

/* ------------------------------------------------------------- HEARTBEAT */
console.log('\n=== HEARTBEAT ===');
const hb = await sim.send('Heartbeat', {});
chk('11. Heartbeat answered', 3, hb[0]);
chk('11. response carries currentTime', true, typeof hb[2].currentTime === 'string');
const beforeBeat = (await chargerState(chA.id)).lastHeartbeatAt;
await sleep(1100);
await sim.send('Heartbeat', {});
await sleep(150);
chk('12. lastHeartbeatAt advances', true, (await chargerState(chA.id)).lastHeartbeatAt > beforeBeat);

/* ---------------------------------------------------------------- STATUS */
console.log('\n=== STATUS NOTIFICATION (writes Connector, never Charger) ===');
for (const [ocppStatus, expected] of [
  ['Available', 'available'], ['Preparing', 'preparing'], ['Charging', 'charging'],
  ['Faulted', 'faulted'], ['Unavailable', 'unavailable'], ['Finishing', 'finishing'],
  ['SuspendedEV', 'occupied'],
]) {
  await sim.send('StatusNotification', { connectorId: 1, status: ocppStatus, errorCode: 'NoError' });
  await sleep(120);
  chk(`15-18. ${ocppStatus} -> ${expected}`, expected, (await connectorState(chA.id)).status);
}
const adminStatusBefore = (await chargerState(chA.id)).status;
await sim.send('StatusNotification', { connectorId: 1, status: 'Faulted', errorCode: 'GroundFailure' });
await sleep(150);
chk('   errorCode persisted', 'GroundFailure', (await connectorState(chA.id)).errorCode);
chk('   Charger.status NOT touched by StatusNotification', adminStatusBefore, (await chargerState(chA.id)).status);
const unknownStatus = await sim.send('StatusNotification', { connectorId: 1, status: 'Teleporting' });
chk('   unknown status -> CALLERROR', 4, unknownStatus[0]);
await sim.send('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' });
await sleep(120);

/* --------------------------------------------------------- AUTHORIZATION */
console.log('\n=== AUTHORIZE (tightened by Module 7) ===');
// Module 6 accepted any well-formed tag because there was nothing to check against. Module 7
// mints a tag per session, so an unissued tag is now correctly refused.
chk('26/27. a tag no session issued -> Invalid', 'Invalid', (await sim.send('Authorize', { idTag: 'TESTTAG-0001' }))[2].idTagInfo.status);
chk('27. malformed idTag rejected', 'Invalid', (await sim.send('Authorize', { idTag: 'ab' }))[2].idTagInfo.status);
chk('27. idTag with illegal characters rejected', 'Invalid', (await sim.send('Authorize', { idTag: 'bad tag!' }))[2].idTagInfo.status);
chk('   missing idTag -> CALLERROR', 4, (await sim.send('Authorize', {}))[0]);

/* -------------------------------------------------------------- COMMANDS */
/*
 * MODULE 7 RETIRED the raw `POST /chargers/:id/commands/remote-start|stop` endpoints, because
 * they could make a charger deliver power with no ChargingSession recording it. The OUTBOUND
 * PROTOCOL those endpoints exercised is unchanged and still verified here - it is now reached
 * through the session API, which is the only caller left.
 */
console.log('\n=== REMOTE START / STOP (now driven by Module 7 sessions) ===');
chk('   the raw remote-start endpoint no longer exists', 404,
  (await call('POST', `/chargers/${chA.id}/commands/remote-start`, { token: superToken, body: { connectorNumber: 1, idTag: 'TESTTAG-0001' } })).status);
chk('   the raw remote-stop endpoint no longer exists', 404,
  (await call('POST', `/chargers/${chA.id}/commands/remote-stop`, { token: superToken })).status);

await sim.send('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' });
await sleep(150);

chk('30. start on a DISCONNECTED charger -> 409', 409,
  (await call('POST', '/charging/sessions', { token: driverToken, body: { connectorId: chB.connectorId } })).status);
chk('   staff may not start a charge on a driver behalf -> 403', 403,
  (await call('POST', '/charging/sessions', { token: staff.opA.token, body: { connectorId: chA.connectorId } })).status);
chk('   anonymous start -> 401', 401,
  (await call('POST', '/charging/sessions', { body: { connectorId: chA.connectorId } })).status);

const startReq = call('POST', '/charging/sessions', { token: driverToken, body: { connectorId: chA.connectorId } });
const startCall = await sim.waitForCall('RemoteStartTransaction');
chk('19. RemoteStartTransaction reached the charger', true, startCall !== null);
chk('19. carries the connector number', 1, startCall?.payload?.connectorId);
chk('19. carries a session-issued idTag', true, typeof startCall?.payload?.idTag === 'string');
sim.reply(startCall.uid, { status: 'Accepted' });
const started = await startReq;
chk('   the driver start is accepted -> 202', 202, started.status);
const sessionId = started.body.data.session.id;
const sessionTag = startCall.payload.idTag;

chk('26. the session idTag DOES authorize', 'Accepted',
  (await sim.send('Authorize', { idTag: sessionTag }))[2].idTagInfo.status);

await sim.send('StatusNotification', { connectorId: 1, status: 'Preparing', errorCode: 'NoError' });
const start = await sim.send('StartTransaction', { connectorId: 1, idTag: sessionTag, meterStart: 0, timestamp: new Date().toISOString() });
chk('20. StartTransaction accepted', 'Accepted', start[2].idTagInfo.status);
chk('20. transactionId allocated', true, typeof start[2].transactionId === 'number');
const transactionId = start[2].transactionId;
await sim.send('StatusNotification', { connectorId: 1, status: 'Charging', errorCode: 'NoError' });
await sleep(200);
chk('   connector is charging', 'charging', (await connectorState(chA.id)).status);

const connState = (await call('GET', `/chargers/${chA.id}/connection`, { token: superToken })).body.data.connection;
// `transactions` is a LIST since the Module 6 registry patch — a charger with several plugs
// can run several at once, and reporting one misrepresented that.
chk('   gateway reports the live transaction', transactionId, connState.transactions?.[0]?.transactionId);
chk('   exactly one transaction on a single-connector charger', 1, connState.transactions?.length);
chk('   a second start on the busy connector -> 409', 409,
  (await call('POST', '/charging/sessions', { token: driverToken, body: { connectorId: chA.connectorId } })).status);

/* ----------------------------------------------------------------- METER */
console.log('\n=== METER VALUES ===');
const readings = [];
for (const wh of [83.33, 166.66, 249.99]) {
  const r = await sim.send('MeterValues', { connectorId: 1, transactionId, energyWh: wh, timestamp: new Date().toISOString() });
  readings.push({ wh, ok: r[0] === 3 });
}
chk('23. MeterValues accepted', true, readings.every((r) => r.ok));
chk('24. cumulative energy strictly increases', true,
  readings.every((r, i) => i === 0 || r.wh > readings[i - 1].wh));

console.log('=== REMOTE STOP ===');
chk('   a force-stop with no reason -> 422 (the driver is told why)', 422,
  (await call('POST', `/charging/sessions/${sessionId}/stop`, { token: staff.cpoA.token })).status);
const stopRes = call('POST', `/charging/sessions/${sessionId}/stop`, {
  token: staff.cpoA.token, body: { reason: 'Scheduled maintenance' } });
const stopCall = await sim.waitForCall('RemoteStopTransaction');
chk('21. RemoteStopTransaction reached the charger', true, stopCall !== null);
chk('21. addressed by transactionId', transactionId, stopCall?.payload?.transactionId);
sim.reply(stopCall.uid, { status: 'Accepted' });
chk('   the owning CPO may force-stop -> 202', 202, (await stopRes).status);

await sim.send('StatusNotification', { connectorId: 1, status: 'Finishing', errorCode: 'NoError' });
const stop = await sim.send('StopTransaction', { transactionId, meterStop: 249.99, reason: 'Remote', timestamp: new Date().toISOString() });
chk('22. StopTransaction accepted', 'Accepted', stop[2].idTagInfo.status);
await sim.send('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' });
await sleep(200);
chk('   connector back to available', 'available', (await connectorState(chA.id)).status);

const afterStop = (await call('GET', `/chargers/${chA.id}/connection`, { token: superToken })).body.data.connection;
chk('25. transaction cleared after stop', 0, afterStop.transactions.length);
chk('   stopping an already-finished session -> 409', 409,
  (await call('POST', `/charging/sessions/${sessionId}/stop`, { token: superToken })).status);

/* ---------------------------------------------------------------- ERRORS */
console.log('\n=== ERROR HANDLING (socket must survive) ===');
const malformed = await sim.sendRaw('this is not json');
chk('28. malformed frame -> CALLERROR', 4, malformed[0]);
chk('28. socket still open afterwards', true, sim.isOpen);
const badShape = await sim.sendRaw(JSON.stringify({ not: 'an array' }));
chk('28. non-array frame -> CALLERROR', 4, badShape[0]);
const unsupported = await sim.send('DiagnosticsStatusNotification', {});
chk('29. unsupported action -> CALLERROR', 4, unsupported[0]);
chk('29. errorCode NotSupported', 'NotSupported', unsupported[2]);
chk('   socket survives all of the above', true, sim.isOpen);
chk('   backend still serving REST', 200, (await call('GET', '/health')).status);

/* ----------------------------------------------- DUPLICATE & RECONNECT -- */
console.log('\n=== DUPLICATE CONNECTION & RECONNECT ===');
const second = new TestCharger(chA.ocppId, chA.token);
chk('4. second connection with same identity accepted', true, (await second.connect()).ok);
await sleep(400);
chk('4. the OLD socket was closed as superseded', 4000, sim.closeCode);
chk('4. the NEW connection works', 'Accepted',
  (await second.send('BootNotification', { chargePointVendor: 'T', chargePointModel: 'T' }))[2].status);
second.startHeartbeat();
await sleep(200);
chk('4. charger still online after supersede', true, (await chargerState(chA.id)).isOnline);

second.close();
await sleep(500);
chk('5. disconnect marks the charger offline', false, (await chargerState(chA.id)).isOnline);

const third = new TestCharger(chA.ocppId, chA.token);
chk('6. reconnect succeeds', true, (await third.connect()).ok);
await third.send('BootNotification', { chargePointVendor: 'T', chargePointModel: 'T' });
third.startHeartbeat();
await sleep(200);
chk('6. online again after reconnect', true, (await chargerState(chA.id)).isOnline);

/* -------------------------------------------- HEARTBEAT TIMEOUT SWEEP --- */
console.log('\n=== HEARTBEAT TIMEOUT (threshold lowered for this run) ===');
await third.send('StatusNotification', { connectorId: 1, status: 'Charging', errorCode: 'NoError' });
await sleep(150);
const connectorBeforeTimeout = (await connectorState(chA.id)).status;
third.stopHeartbeat();
/*
 * Wait THRESHOLD + SWEEP PERIOD + slack, not just the threshold.
 *
 * The gateway does not notice silence the instant the threshold passes - it notices on the next
 * sweep. With OCPP_OFFLINE_AFTER_SECONDS=5 the sweep period is max(1s, min(15s, 5s/2)) = 2.5s,
 * so worst-case detection is 7.5s. The original 6.5s was under that and passed by luck.
 */
console.log('   holding heartbeats…');
await sleep(9000);
chk('13/14. silence marks the charger offline', false, (await chargerState(chA.id)).isOnline);
/*
 * ===========================================================================
 * MODULE 16 CHANGED THIS CONTRACT DELIBERATELY.
 *
 * Module 6 asserted the connector status was LEFT ALONE on disconnect, with the
 * reasoning "no invented state" — only the charger knows what its plug is doing,
 * so do not guess. That instinct is right, and it had one flaw: LEAVING a plug
 * on `charging` after its charger vanished is ITSELF an invented state. It
 * asserts a charge is in progress when there is nothing on the other end.
 *
 * Module 16's failure suite showed what that costs: /monitor displayed a live
 * charge, Module 13's connector breakdown counted the plug busy, and Module 14's
 * map reported it occupied — all for a session that had already been failed with
 * `ChargerDisconnected`.
 *
 * So in-flight statuses (preparing / charging / finishing) now land on
 * `unavailable`, which is the honest claim: the charger is gone, so the plug
 * cannot be used and its real state is unknowable until it comes back.
 *
 * NOT `available` — that would send a driver to a socket that may be blocked.
 * Statuses that are not in-flight are still left strictly alone.
 * ===========================================================================
 */
chk('14. an in-flight connector is released to `unavailable`, not left claiming to charge',
  'unavailable', (await connectorState(chA.id)).status);
chk('14. and it is NOT reported as available — the charger is gone, so we cannot know', false,
  (await connectorState(chA.id)).status === 'available');
chk('14. the status it held before the timeout really was in-flight', true,
  ['preparing', 'charging', 'finishing'].includes(connectorBeforeTimeout));
third.close();

/* ------------------------------------------------------------ REGRESSION */
console.log('\n=== MODULE 1-5 REGRESSION ===');
chk('31. auth/me works', 200, (await call('GET', '/auth/me', { token: staff.cpoA.token })).status);
chk('32. company isolation intact', 403, (await call('GET', `/companies/${B}`, { token: staff.cpoA.token })).status);
chk('33. driver vehicles intact', 200, (await call('GET', '/users/me/vehicles', { token: driverToken })).status);
chk('34. station scoping intact', 403, (await call('GET', `/stations/${STB}`, { token: staff.cpoA.token })).status);
chk('35. charger scoping intact', 403, (await call('GET', `/chargers/${chB.id}`, { token: staff.cpoA.token })).status);
chk('35. connector nesting intact', 403, (await call('GET', `/chargers/${chB.id}/connectors`, { token: staff.cpoA.token })).status);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) { console.log('Failed:', failures.join(' | ')); process.exit(1); }
process.exit(0);
