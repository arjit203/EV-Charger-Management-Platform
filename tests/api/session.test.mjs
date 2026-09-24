/* Module 7 verification — charging sessions and meter readings.
   Drives a REAL OCPP WebSocket so the whole loop is exercised:
   HTTP start -> RemoteStartTransaction -> StartTransaction -> MeterValues -> StopTransaction. */

import { createRequire } from 'module';
const require = createRequire(new URL('../../backend/', import.meta.url));
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://localhost:5000/api/v1';
const WS_BASE = process.env.WS_BASE || 'ws://localhost:5000/ocpp';
const STAMP = Date.now();
const S = String(STAMP).slice(-6);
const PW = 'SessionPass12345';
/* Must match SESSION_START_TIMEOUT_SECONDS in the backend's environment. */
const START_TIMEOUT_S = Number(process.env.START_TIMEOUT_S || 20);

let pass = 0, fail = 0;
const failures = [];
const chk = (name, expected, actual) => {
  if (expected === actual) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`); failures.push(name); fail++; }
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
    this.ocppId = ocppId; this.authToken = authToken;
    this.socket = null; this.pending = new Map(); this.inbound = []; this.closeCode = null;
    this.beat = null; this.autoAccept = false;
  }

  /* A real charge point beats every 30s. Without this the gateway's heartbeat sweep marks it
     offline part-way through the run and terminates the socket - correct behaviour, but it
     makes the test look like a session bug. */
  startHeartbeat(ms = 1500) {
    this.beat = setInterval(() => { this.send('Heartbeat', {}).catch(() => {}); }, ms);
  }

  connect() {
    const creds = Buffer.from(`${this.ocppId}:${this.authToken}`).toString('base64');
    return new Promise((resolve) => {
      const socket = new WebSocket(`${WS_BASE}/${encodeURIComponent(this.ocppId)}`,
        { headers: { Authorization: `Basic ${creds}` } });
      this.socket = socket;
      socket.on('open', () => resolve({ ok: true }));
      socket.on('error', (err) => resolve({ ok: false, error: err.message }));
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

  reply(uid, payload) { this.socket.send(JSON.stringify([3, uid, payload])); }

  async waitForCall(action, ms = 6000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = this.inbound.find((m) => m.action === action);
      if (found) { this.inbound = this.inbound.filter((m) => m !== found); return found; }
      await sleep(40);
    }
    return null;
  }

  /** Answer the backend's RemoteStartTransaction, then run the charger's side of the start. */
  async acceptRemoteStartAndBegin({ meterStart = 0 } = {}) {
    const startCall = await this.waitForCall('RemoteStartTransaction');
    if (!startCall) return { startCall: null };
    this.reply(startCall.uid, { status: 'Accepted' });

    const idTag = startCall.payload.idTag;
    await this.send('StatusNotification', { connectorId: startCall.payload.connectorId, status: 'Preparing', errorCode: 'NoError' });
    const auth = await this.send('Authorize', { idTag });
    const start = await this.send('StartTransaction', {
      connectorId: startCall.payload.connectorId, idTag, meterStart,
      timestamp: new Date().toISOString(),
    });
    await this.send('StatusNotification', { connectorId: startCall.payload.connectorId, status: 'Charging', errorCode: 'NoError' });
    return { startCall, idTag, auth: auth[2], start: start[2] };
  }

  /* Answer any RemoteStartTransaction the moment it arrives, so a burst of concurrent start
     requests is not serialised behind the test's own await. */
  startAutoAccept() {
    this.autoAccept = true;
    (async () => {
      while (this.autoAccept) {
        const c = await this.waitForCall('RemoteStartTransaction', 500);
        if (c) this.reply(c.uid, { status: 'Accepted' });
      }
    })();
  }

  stopAutoAccept() { this.autoAccept = false; }

  close() {
    this.autoAccept = false;
    if (this.beat) { clearInterval(this.beat); this.beat = null; }
    try { this.socket?.close(); } catch { /* ignore */ }
  }
  get isOpen() { return this.socket?.readyState === WebSocket.OPEN; }
}

/* ----------------------------------------------------------------- setup */
console.log('=== SETUP ===');
const superToken = await login('admin@evcms.local', 'Admin@12345');

const mkCompany = async (label) => (await call('POST', '/companies', {
  token: superToken, body: { name: `${label} ${STAMP}`, type: 'CPO' } })).body.data.company.id;
const A = await mkCompany('M7 Alpha');
const B = await mkCompany('M7 Beta');

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
  const email = `${key}.m7.${STAMP}@test.local`;
  const r = await call('POST', '/users', { token: superToken, body: { name: `Staff ${key}`, email, password: PW, role, companyId } });
  if (r.status !== 201) throw new Error(`staff ${key}: ${r.status} ${r.raw}`);
  staff[key] = { token: await login(email, PW) };
}

const drivers = {};
for (const key of ['d1', 'd2']) {
  const email = `${key}.m7.${STAMP}@test.local`;
  await call('POST', '/auth/register', { body: { name: `Driver ${key}`, email, password: PW } });
  drivers[key] = { token: await login(email, PW), email };
}

const mkStation = async (companyId, code) => (await call('POST', '/stations', {
  token: superToken, body: { name: `Station ${code}`, stationCode: code, address: '1 Test Road', city: 'Delhi',
    state: 'Delhi', country: 'India', latitude: 28.6, longitude: 77.2, companyId } })).body.data.station.id;
const STA = await mkStation(A, `S7A-${S}`);
const STB = await mkStation(B, `S7B-${S}`);

const mkCharger = async (stationId, code) => {
  const r = await call('POST', '/chargers', { token: superToken, body: {
    stationId, name: `Charger ${code}`, chargerCode: code, ocppId: `OCPP7-${code}`,
    manufacturer: 'Delta', model: 'Sim', chargerType: 'DC', powerKw: 60 } });
  if (r.status !== 201) throw new Error(`charger ${code}: ${r.status} ${r.raw}`);
  return { id: r.body.data.charger.id, ocppId: r.body.data.charger.ocppId, token: r.body.data.authToken };
};
const chA = await mkCharger(STA, `C7A-${S}`);
const chB = await mkCharger(STB, `C7B-${S}`);

const mkConnector = async (chargerId, number, type) => {
  const r = await call('POST', `/chargers/${chargerId}/connectors`, {
    token: superToken, body: { connectorNumber: number, connectorType: type, powerKw: 60 } });
  if (r.status !== 201) throw new Error(`connector ${number}: ${r.status} ${r.raw}`);
  return r.body.data.connector.id;
};
const conA1 = await mkConnector(chA.id, 1, 'CCS2');
const conA2 = await mkConnector(chA.id, 2, 'CHAdeMO');
const conB1 = await mkConnector(chB.id, 1, 'CCS2');

const mkVehicle = async (token, plate, type) => {
  const r = await call('POST', '/users/me/vehicles', { token, body: {
    make: 'Tata', model: 'Nexon EV', registrationNumber: plate, connectorType: type, batteryCapacityKwh: 40 } });
  if (r.status !== 201) throw new Error(`vehicle ${plate}: ${r.status} ${r.raw}`);
  return r.body.data.vehicle.id;
};
const carCCS = await mkVehicle(drivers.d1.token, `DL7C${S}`, 'CCS2');
const carGBT = await mkVehicle(drivers.d1.token, `DL7G${S}`, 'GBT');
const carD2 = await mkVehicle(drivers.d2.token, `DL7D${S}`, 'CCS2');

const sessionState = async (id, token = superToken) =>
  (await call('GET', `/charging/sessions/${id}`, { token })).body?.data?.session;
const connectorState = async (chargerId, index = 0) =>
  (await call('GET', `/chargers/${chargerId}/connectors`, { token: superToken })).body?.data?.connectors?.[index];

console.log(`  setup complete (companies, staff, 2 drivers, 3 connectors, 3 vehicles)`);

/* ------------------------------------------- MODULE 6 ENDPOINT RETIREMENT */
console.log('\n=== MODULE 6 RAW COMMANDS ARE RETIRED (no phantom sessions) ===');
chk('raw remote-start endpoint is gone', 404,
  (await call('POST', `/chargers/${chA.id}/commands/remote-start`, { token: superToken, body: { connectorNumber: 1, idTag: 'ANYTAG-0001' } })).status);
chk('raw remote-stop endpoint is gone', 404,
  (await call('POST', `/chargers/${chA.id}/commands/remote-stop`, { token: superToken })).status);
chk('read-only connection diagnostics still work', 200,
  (await call('GET', `/chargers/${chA.id}/connection`, { token: superToken })).status);

/* ------------------------------------------------------- START: SAD PATHS */
console.log('\n=== START — GUARDS BEFORE ANY CHARGER IS CONNECTED ===');
chk('start on a charger that is not connected -> 409', 409,
  (await call('POST', '/charging/sessions', { token: drivers.d1.token, body: { connectorId: conA1 } })).status);
chk('anonymous start -> 401', 401,
  (await call('POST', '/charging/sessions', { body: { connectorId: conA1 } })).status);
chk('cpo_admin cannot start on a driver behalf -> 403', 403,
  (await call('POST', '/charging/sessions', { token: staff.cpoA.token, body: { connectorId: conA1 } })).status);
chk('operator cannot start -> 403', 403,
  (await call('POST', '/charging/sessions', { token: staff.opA.token, body: { connectorId: conA1 } })).status);
chk('unknown connector -> 404', 404,
  (await call('POST', '/charging/sessions', { token: drivers.d1.token, body: { connectorId: '0'.repeat(24) } })).status);
chk('malformed connector id -> 422', 422,
  (await call('POST', '/charging/sessions', { token: drivers.d1.token, body: { connectorId: 'not-an-id' } })).status);
chk('userId in body is rejected, not stripped -> 422', 422,
  (await call('POST', '/charging/sessions', { token: drivers.d1.token, body: { connectorId: conA1, userId: '0'.repeat(24) } })).status);
chk('companyId in body is rejected -> 422', 422,
  (await call('POST', '/charging/sessions', { token: drivers.d1.token, body: { connectorId: conA1, companyId: A } })).status);

/* ------------------------------------------------------------- CONNECT -- */
console.log('\n=== CHARGER CONNECTS ===');
const sim = new TestCharger(chA.ocppId, chA.token);
chk('charger connects to the gateway', true, (await sim.connect()).ok);
sim.startHeartbeat();
await sim.send('BootNotification', { chargePointVendor: 'Test', chargePointModel: 'M7' });
await sim.send('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' });
await sim.send('StatusNotification', { connectorId: 2, status: 'Available', errorCode: 'NoError' });
await sleep(200);

const view = (await call('GET', `/charging/connectors/${conA1}`, { token: drivers.d1.token })).body.data.connector;
chk('connector lookup says the plug is usable', true, view.canStart);
chk('connector lookup carries station name', true, typeof view.stationName === 'string' && view.stationName.length > 0);
chk('connector lookup carries power rating', 60, view.powerKw);

/* ------------------------------------------------------- VEHICLE MATCHING */
console.log('\n=== VEHICLE VALIDATION ===');
chk('vehicle whose plug type does not match -> 422', 422,
  (await call('POST', '/charging/sessions', { token: drivers.d1.token, body: { connectorId: conA1, vehicleId: carGBT } })).status);
chk('another driver vehicle -> 404', 404,
  (await call('POST', '/charging/sessions', { token: drivers.d1.token, body: { connectorId: conA1, vehicleId: carD2 } })).status);

/* -------------------------------------------------------- THE HAPPY PATH */
console.log('\n=== START (the full OCPP round trip) ===');
const startPromise = call('POST', '/charging/sessions', {
  token: drivers.d1.token, body: { connectorId: conA1, vehicleId: carCCS } });

const begun = await sim.acceptRemoteStartAndBegin({ meterStart: 0 });
const startRes = await startPromise;

chk('start returns 202 Accepted (not 201 — nothing is charging yet)', 202, startRes.status);
const sessionId = startRes.body?.data?.session?.id;
chk('session created', true, typeof sessionId === 'string');
chk('session begins in `initiating`', 'initiating', startRes.body?.data?.session?.status);
chk('RemoteStartTransaction reached the charger', true, begun.startCall !== null);
chk('the command carried the connector number', 1, begun.startCall?.payload?.connectorId);
chk('the command carried a session-issued idTag', true, typeof begun.idTag === 'string' && begun.idTag.length === 20);
chk('Authorize accepted the session idTag', 'Accepted', begun.auth?.idTagInfo?.status);
chk('StartTransaction accepted', 'Accepted', begun.start?.idTagInfo?.status);
chk('a transaction id was allocated', true, typeof begun.start?.transactionId === 'number');

await sleep(250);
const active = await sessionState(sessionId);
chk('session is now `active`', 'active', active.status);
chk('transactionId stored on the session', begun.start.transactionId, active.transactionId);
chk('startedAt recorded', true, active.startedAt !== null);
chk('startMeterWh recorded', 0, active.startMeterWh);
chk('userId is the driver, taken from the token', true, active.userId.length === 24);
chk('vehicleId stored', carCCS, active.vehicleId);
chk('companyId denormalised from the charger', A, active.companyId);
chk('stationId denormalised from the charger', STA, active.stationId);
chk('connectorNumber denormalised', 1, active.connectorNumber);
chk('connector reports charging', 'charging', (await connectorState(chA.id, 0)).status);

/* ------------------------------------------------- CONCURRENCY PROTECTION */
console.log('\n=== ONE OPEN SESSION PER CONNECTOR (the race the index closes) ===');
chk('same driver starting again on the busy connector -> 409', 409,
  (await call('POST', '/charging/sessions', { token: drivers.d1.token, body: { connectorId: conA1 } })).status);
chk('a DIFFERENT driver starting on the busy connector -> 409', 409,
  (await call('POST', '/charging/sessions', { token: drivers.d2.token, body: { connectorId: conA1 } })).status);

/* ONE CHARGE PER DRIVER. d1 is charging on connector 1; the FREE connector 2 beside it must still
 * be refused, with a message naming the running charge and its id so the app can link to it -
 * not a silent redirect. */
const secondPlug = await call('POST', '/charging/sessions', { token: drivers.d1.token, body: { connectorId: conA2 } });
chk('a driver already charging cannot start a second plug -> 409', 409, secondPlug.status);
chk('   the refusal names the running session', sessionId, secondPlug.body?.details?.activeSessionId);
chk('   and says why in words', true, /already have a charge in progress/i.test(secondPlug.body?.message ?? ''));

// Fire several starts at the same instant. Exactly one may survive; the rest must be refused
// by the database, not by a lucky application check.
const stormConnector = conA2;
await sim.send('StatusNotification', { connectorId: 2, status: 'Available', errorCode: 'NoError' });
await sleep(150);
sim.startAutoAccept();
const storm = await Promise.all([0, 1, 2, 3].map(() =>
  call('POST', '/charging/sessions', { token: drivers.d2.token, body: { connectorId: stormConnector } })));
sim.stopAutoAccept();
const accepted = storm.filter((r) => r.status === 202);
const conflicted = storm.filter((r) => r.status === 409);
chk('4 simultaneous starts -> exactly 1 accepted', 1, accepted.length);
chk('4 simultaneous starts -> the other 3 are 409', 3, conflicted.length);

// Release connector 2 explicitly rather than leaving it to the sweeper, so the rest of the
// run does not depend on timing.
const stormSessionId = accepted[0]?.body?.data?.session?.id;
if (stormSessionId) {
  await call('POST', `/charging/sessions/${stormSessionId}/stop`, { token: drivers.d2.token });
  chk('an unconfirmed session can be cancelled immediately', 'failed',
    (await sessionState(stormSessionId)).status);
}

/* ---------------------------------------------------------- METER VALUES */
console.log('\n=== METER VALUES ===');
const txn = begun.start.transactionId;
const send = (wh, extra = {}) => sim.send('MeterValues', {
  connectorId: 1, transactionId: txn, energyWh: wh, timestamp: new Date().toISOString(), ...extra });

for (const wh of [83.33, 166.66, 249.99]) { await send(wh); }
await sleep(250);
let cur = await sessionState(sessionId);
chk('running energy total matches the last reading', 249.99, cur.energyConsumedWh);
chk('energy also exposed in kWh', 0.25, cur.energyConsumedKwh);
chk('lastMeterWh tracks the newest reading', 249.99, cur.lastMeterWh);

let readings = (await call('GET', `/charging/sessions/${sessionId}/readings`, { token: drivers.d1.token })).body.data;
chk('three readings stored', 3, readings.count);
chk('readings come back oldest-first', true,
  readings.readings.every((r, i) => i === 0 || r.energyWh > readings.readings[i - 1].energyWh));

// The idempotency rule: nothing that fails to carry NEW energy may be stored.
await send(249.99);                       // exact duplicate
await send(200);                          // goes backwards
await send(-5);                           // negative
await sim.send('MeterValues', { connectorId: 1, transactionId: txn, energyWh: 249.99, timestamp: new Date().toISOString() });
await sleep(250);
readings = (await call('GET', `/charging/sessions/${sessionId}/readings`, { token: drivers.d1.token })).body.data;
chk('duplicate / backwards / negative readings are all dropped', 3, readings.count);
chk('energy total unchanged by the bad readings', 249.99, (await sessionState(sessionId)).energyConsumedWh);
chk('socket survived every rejected reading', true, sim.isOpen);

await send(333.32, { powerKw: 60, socPercent: 42 });
await sleep(250);
readings = (await call('GET', `/charging/sessions/${sessionId}/readings`, { token: drivers.d1.token })).body.data;
chk('a genuinely newer reading IS stored', 4, readings.count);
chk('optional powerKw persisted', 60, readings.readings[3].powerKw);
chk('optional socPercent persisted', 42, readings.readings[3].socPercent);

/* ---------------------------------------------------------------- READS */
console.log('\n=== READ SCOPING (driver by ownership, staff by company) ===');
chk('the driver sees their own session', 200,
  (await call('GET', `/charging/sessions/${sessionId}`, { token: drivers.d1.token })).status);
chk('another driver cannot see it -> 404', 404,
  (await call('GET', `/charging/sessions/${sessionId}`, { token: drivers.d2.token })).status);
chk('the owning CPO can see it', 200,
  (await call('GET', `/charging/sessions/${sessionId}`, { token: staff.cpoA.token })).status);
chk('the owning operator can see it', 200,
  (await call('GET', `/charging/sessions/${sessionId}`, { token: staff.opA.token })).status);
chk('a rival CPO gets 403, not 404 (no id probing)', 403,
  (await call('GET', `/charging/sessions/${sessionId}`, { token: staff.cpoB.token })).status);
chk('super_admin sees everything', 200,
  (await call('GET', `/charging/sessions/${sessionId}`, { token: superToken })).status);
chk('a rival CPO cannot read the meter curve either', 403,
  (await call('GET', `/charging/sessions/${sessionId}/readings`, { token: staff.cpoB.token })).status);
chk('another driver cannot read the meter curve', 404,
  (await call('GET', `/charging/sessions/${sessionId}/readings`, { token: drivers.d2.token })).status);

const d1List = (await call('GET', '/charging/sessions', { token: drivers.d1.token })).body.data;
chk('driver list contains only their own sessions', true,
  d1List.items.every((s) => s.userId === active.userId));
const cpoAList = (await call('GET', '/charging/sessions', { token: staff.cpoA.token })).body.data;
chk('CPO list contains only their own company', true, cpoAList.items.every((s) => s.companyId === A));
const cpoBList = (await call('GET', '/charging/sessions', { token: staff.cpoB.token })).body.data;
chk('the rival CPO list never leaks company A', false, cpoBList.items.some((s) => s.companyId === A));
chk('list is paginated', true, typeof cpoAList.total === 'number' && typeof cpoAList.totalPages === 'number');

const activeOnly = (await call('GET', '/charging/sessions?active=true', { token: staff.cpoA.token })).body.data;
chk('?active=true returns only unfinished sessions', true,
  activeOnly.items.every((s) => ['initiating', 'active', 'stopping'].includes(s.status)));

const myActive = (await call('GET', '/charging/sessions/active', { token: drivers.d1.token })).body.data;
chk('driver /sessions/active finds the running session', sessionId, myActive.session?.id);
chk('staff are not offered /sessions/active -> 403', 403,
  (await call('GET', '/charging/sessions/active', { token: staff.cpoA.token })).status);

/* ----------------------------------------------------------------- STOP */
console.log('\n=== STOP ===');
chk('another driver cannot stop this session -> 404', 404,
  (await call('POST', `/charging/sessions/${sessionId}/stop`, { token: drivers.d2.token })).status);
chk('a rival CPO cannot stop it -> 403', 403,
  (await call('POST', `/charging/sessions/${sessionId}/stop`, { token: staff.cpoB.token })).status);

const stopPromise = call('POST', `/charging/sessions/${sessionId}/stop`, { token: drivers.d1.token });
const stopCall = await sim.waitForCall('RemoteStopTransaction');
chk('RemoteStopTransaction reached the charger', true, stopCall !== null);
chk('the stop is addressed by transaction id', txn, stopCall?.payload?.transactionId);
sim.reply(stopCall.uid, { status: 'Accepted' });
const stopRes = await stopPromise;
chk('stop returns 202', 202, stopRes.status);
chk('session moves to `stopping`, not `completed`', 'stopping', stopRes.body.data.session.status);

await sim.send('StatusNotification', { connectorId: 1, status: 'Finishing', errorCode: 'NoError' });
const finalWh = 416.65;
const stopTxn = await sim.send('StopTransaction', {
  transactionId: txn, meterStop: finalWh, reason: 'Remote', timestamp: new Date().toISOString() });
chk('StopTransaction accepted', 'Accepted', stopTxn[2].idTagInfo.status);
await sim.send('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' });
await sleep(300);

const done = await sessionState(sessionId);
chk('only StopTransaction can complete a session', 'completed', done.status);
chk('endedAt recorded', true, done.endedAt !== null);
chk('endMeterWh is the charger final reading', finalWh, done.endMeterWh);
chk('energy = end meter - start meter', finalWh, done.energyConsumedWh);
chk('duration computed', true, typeof done.durationSeconds === 'number' && done.durationSeconds >= 0);
chk('stopReason records that WE asked', 'Remote', done.stopReason);
chk('connector released back to available', 'available', (await connectorState(chA.id, 0)).status);

chk('stopping an already-finished session -> 409', 409,
  (await call('POST', `/charging/sessions/${sessionId}/stop`, { token: drivers.d1.token })).status);
chk('the driver has no active session any more', null,
  (await call('GET', '/charging/sessions/active', { token: drivers.d1.token })).body.data.session);

/* ------------------------------------------------------- AFTER-THE-FACT */
console.log('\n=== A FINISHED SESSION IS CLOSED TO FURTHER TRAFFIC ===');
await send(500);
await sleep(250);
readings = (await call('GET', `/charging/sessions/${sessionId}/readings`, { token: drivers.d1.token })).body.data;
chk('MeterValues after completion are ignored', 4, readings.count);
chk('the completed energy total is frozen', finalWh, (await sessionState(sessionId)).energyConsumedWh);
chk('the used idTag no longer authorizes', 'Invalid',
  (await sim.send('Authorize', { idTag: begun.idTag }))[2].idTagInfo.status);
chk('a tag nobody issued never authorizes', 'Invalid',
  (await sim.send('Authorize', { idTag: 'EVDEADBEEFDEADBEEF00' }))[2].idTagInfo.status);

/* ------------------------------------------ WALK-UP START IS NOT ALLOWED */
console.log('\n=== A START WITH NO SESSION BEHIND IT IS REFUSED ===');
const walkUp = await sim.send('StartTransaction', {
  connectorId: 1, idTag: 'RFIDCARD-UNKNOWN-01', meterStart: 0, timestamp: new Date().toISOString() });
chk('unknown idTag -> idTagInfo Invalid', 'Invalid', walkUp[2].idTagInfo.status);
chk('protocol still gets a transactionId back', true, typeof walkUp[2].transactionId === 'number');
chk('the connector is still free afterwards', 202,
  (await (async () => {
    const p = call('POST', '/charging/sessions', { token: drivers.d1.token, body: { connectorId: conA1 } });
    const c = await sim.waitForCall('RemoteStartTransaction');
    if (c) sim.reply(c.uid, { status: 'Accepted' });
    return p;
  })()).status);

/* --------------------------------------------------- MID-SESSION DEATH -- */
console.log('\n=== CHARGER DISCONNECTS MID-SESSION ===');
const deathSession = (await call('GET', '/charging/sessions/active', { token: drivers.d1.token })).body.data.session;
// Confirm it, put energy into it, then kill the socket.
const deathCall = { payload: { connectorId: 1 } };
const deathTag = deathSession.idTag;
await sim.send('Authorize', { idTag: deathTag });
const deathStart = await sim.send('StartTransaction', {
  connectorId: 1, idTag: deathTag, meterStart: 1000, timestamp: new Date().toISOString() });
const deathTxn = deathStart[2].transactionId;
await sim.send('MeterValues', { connectorId: 1, transactionId: deathTxn, energyWh: 1500, timestamp: new Date().toISOString() });
await sleep(250);
chk('the replacement session is active', 'active', (await sessionState(deathSession.id)).status);

sim.close();
await sleep(800);
const dead = await sessionState(deathSession.id);
chk('a disconnect does not leave the session hanging', 'failed', dead.status);
chk('stopReason says the charger vanished', 'ChargerDisconnected', dead.stopReason);
chk('energy delivered before the disconnect is KEPT', 500, dead.energyConsumedWh);
chk('a failure reason is recorded for the driver', true, typeof dead.failureReason === 'string' && dead.failureReason.length > 0);
chk('the connector is released for the next driver', null,
  (await call('GET', '/charging/sessions/active', { token: drivers.d1.token })).body.data.session);

/* -------------------------------------------------- UNCONFIRMED START -- */
console.log(`\n=== START NEVER CONFIRMED (sweeper, waiting ~${START_TIMEOUT_S + 8}s) ===`);
const sim2 = new TestCharger(chA.ocppId, chA.token);
await sim2.connect();
sim2.startHeartbeat();
await sim2.send('BootNotification', { chargePointVendor: 'Test', chargePointModel: 'M7' });
await sim2.send('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' });
await sleep(200);

const ghostPromise = call('POST', '/charging/sessions', { token: drivers.d1.token, body: { connectorId: conA1 } });
const ghostCall = await sim2.waitForCall('RemoteStartTransaction');
sim2.reply(ghostCall.uid, { status: 'Accepted' });   // accepted... and then nothing ever happens
const ghost = await ghostPromise;
chk('the start is accepted by the charger', 202, ghost.status);
const ghostId = ghost.body.data.session.id;
chk('and sits in `initiating`', 'initiating', (await sessionState(ghostId)).status);
chk('the connector is reserved while it waits -> 409', 409,
  (await call('POST', '/charging/sessions', { token: drivers.d2.token, body: { connectorId: conA1 } })).status);

await sleep((START_TIMEOUT_S + 8) * 1000);
const swept = await sessionState(ghostId);
chk('the sweeper fails an unconfirmed session', 'failed', swept.status);
chk('stopReason is StartTimeout', 'StartTimeout', swept.stopReason);
chk('it is failed, never deleted (the driver keeps a record)', true, swept.id === ghostId);
chk('no energy is attributed to it', 0, swept.energyConsumedWh);

await sim2.send('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' });
await sleep(200);
chk('the connector is usable again after the sweep', 202,
  (await (async () => {
    const p = call('POST', '/charging/sessions', { token: drivers.d2.token, body: { connectorId: conA1 } });
    const c = await sim2.waitForCall('RemoteStartTransaction');
    if (c) sim2.reply(c.uid, { status: 'Accepted' });
    return p;
  })()).status);

/* ------------------------------------------------------- OPERATOR STOP -- */
console.log('\n=== OPERATOR FORCE-STOP (replaces Module 6 raw remote-stop) ===');
const opSession = (await call('GET', '/charging/sessions?active=true', { token: staff.opA.token })).body.data.items[0];
const opTag = (await sessionState(opSession.id)).idTag;
await sim2.send('Authorize', { idTag: opTag });
const opStart = await sim2.send('StartTransaction', {
  connectorId: 1, idTag: opTag, meterStart: 0, timestamp: new Date().toISOString() });
const opTxn = opStart[2].transactionId;
await sim2.send('MeterValues', { connectorId: 1, transactionId: opTxn, energyWh: 250, timestamp: new Date().toISOString() });
await sleep(200);

chk('a force-stop must give a reason -> 422', 422,
  (await call('POST', `/charging/sessions/${opSession.id}/stop`, { token: staff.opA.token })).status);
const opStopPromise = call('POST', `/charging/sessions/${opSession.id}/stop`, {
  token: staff.opA.token, body: { reason: 'Safety concern at the site' } });
const opStopCall = await sim2.waitForCall('RemoteStopTransaction');
chk('the operator force-stop reaches the charger', true, opStopCall !== null);
sim2.reply(opStopCall.uid, { status: 'Accepted' });
chk('operator may force-stop a session at their own station', 202, (await opStopPromise).status);

await sim2.send('StopTransaction', { transactionId: opTxn, meterStop: 250, reason: 'Remote', timestamp: new Date().toISOString() });
await sleep(300);
const opDone = await sessionState(opSession.id);
chk('the force-stopped session completes normally', 'completed', opDone.status);
chk('and the record matches what was actually delivered', 250, opDone.energyConsumedWh);
chk('the record says WHO stopped it', 'operator', opDone.stoppedByRole);
chk('and why - shown to the driver', 'Safety concern at the site', opDone.stopNote);

/* ------------------------------------------------- CROSS-COMPANY CHARGE */
console.log('\n=== A DRIVER MAY CHARGE AT ANY COMPANY STATION ===');
const simB = new TestCharger(chB.ocppId, chB.token);
await simB.connect();
simB.startHeartbeat();
await simB.send('BootNotification', { chargePointVendor: 'Test', chargePointModel: 'M7' });
await simB.send('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' });
await sleep(200);

const crossPromise = call('POST', '/charging/sessions', { token: drivers.d1.token, body: { connectorId: conB1 } });
const crossCall = await simB.waitForCall('RemoteStartTransaction');
if (crossCall) simB.reply(crossCall.uid, { status: 'Accepted' });
const cross = await crossPromise;
chk('a driver with no company relationship can still charge', 202, cross.status);
chk('the session is booked to the STATION owner, not the driver', B, cross.body.data.session.companyId);
chk('company A staff cannot see a charge at company B -> 403', 403,
  (await call('GET', `/charging/sessions/${cross.body.data.session.id}`, { token: staff.cpoA.token })).status);
chk('company B staff can', 200,
  (await call('GET', `/charging/sessions/${cross.body.data.session.id}`, { token: staff.cpoB.token })).status);

/* ------------------------------------------------------------- CLEANUP -- */
sim2.close(); simB.close();
await sleep(600);

console.log(`\n=========== MODULE 7: ${pass} passed, ${fail} failed ===========`);
if (fail) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
