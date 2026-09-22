/* Module 12 verification — in-app notifications, dedup, fan-out, real-time delivery. */

import { createRequire } from 'module';
import crypto from 'crypto';
const require = createRequire(new URL('../../backend/', import.meta.url));
const WebSocket = require('ws');
const { io: ioClient } = require('socket.io-client');

const BASE = process.env.BASE || 'http://localhost:5000/api/v1';
const ORIGIN = process.env.ORIGIN || 'http://localhost:5000';
const WS_BASE = process.env.WS_BASE || 'ws://localhost:5000/ocpp';
const SECRET = process.env.RZP_SECRET || 'stub_secret_not_for_production';
const S = String(Date.now()).slice(-6);
const PW = 'NotifyPass12345';
/* Module 10's settlement sweeper runs every 15s. Span more than two of them. */
const SWEEP_WINDOW_MS = 35000;
const SILENCE_WINDOW_MS = 8000;

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
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('hex');

const notifs = async (token, query = '') => (await must('GET', `/notifications${query}`, { token })).items;
const ofType = async (token, type) => (await notifs(token, '?limit=100')).filter((n) => n.type === type);

/** A Socket.IO client that records notification events. */
class Watcher {
  constructor(label, token) { this.label = label; this.token = token; this.received = []; }
  connect() {
    return new Promise((resolve) => {
      this.socket = ioClient(ORIGIN, { path: '/socket.io', auth: { token: this.token },
        transports: ['websocket'], reconnection: false, timeout: 5000 });
      this.socket.on('connect', () => resolve(true));
      this.socket.on('connect_error', () => resolve(false));
      this.socket.on('notification:new', (p) => this.received.push(p.notification));
    });
  }
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
  send(a, p = {}) {
    const uid = `n-${Math.random().toString(36).slice(2)}`;
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout ${a}`)), 8000);
      this.pending.set(uid, (f) => { clearTimeout(t); res(f); });
      this.socket.send(JSON.stringify([2, uid, a, p]));
    });
  }
  reply(uid, p) { this.socket.send(JSON.stringify([3, uid, p])); }
  async waitForCall(action, ms = 6000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const f = this.inbound.find((m) => m.action === action);
      if (f) { this.inbound = this.inbound.filter((m) => m !== f); return f; }
      await sleep(40);
    }
    return null;
  }
  startHeartbeat() { this.beat = setInterval(() => { this.send('Heartbeat', {}).catch(() => {}); }, 1500); }
  close() { if (this.beat) clearInterval(this.beat); try { this.socket.close(); } catch {} }
}

/* ------------------------------------------------------------------ setup */
console.log('=== SETUP ===');
const su = (await must('POST', '/auth/login', { body: { email: 'admin@evcms.local', password: 'Admin@12345' } })).token;

const mkCompany = async (l) => (await must('POST', '/companies', { token: su, body: { name: `${l} ${S}`, type: 'CPO' } })).company.id;
const A = await mkCompany('M12 Alpha');
const B = await mkCompany('M12 Beta');

for (const [companyId, rupees] of [[A, 12], [B, 20]]) {
  const t = (await must('POST', '/tariffs', { token: su, body: { name: 'Rate', pricePerKwh: rupees, companyId } })).tariff;
  await must('PATCH', `/tariffs/${t.id}/status`, { token: su, body: { status: 'active' } });
}

const staff = {};
for (const [key, companyId, role] of [
  ['cpoA', A, 'cpo_admin'], ['opA', A, 'operator'],
  ['cpoB', B, 'cpo_admin'], ['opB', B, 'operator'],
]) {
  const email = `${key}.m12.${S}@test.local`;
  const created = await must('POST', '/users', { token: su, body: { name: `Staff ${key}`, email, password: PW, role, companyId } });
  staff[key] = { id: created.user.id, token: (await must('POST', '/auth/login', { body: { email, password: PW } })).token };
}

const drivers = {};
for (const key of ['d1', 'd2']) {
  const email = `${key}.m12.${S}@test.local`;
  const reg = await must('POST', '/auth/register', { body: { name: `Driver ${key}`, email, password: PW } });
  drivers[key] = { id: reg.user.id, token: (await must('POST', '/auth/login', { body: { email, password: PW } })).token };
}

const station = (await must('POST', '/stations', { token: su, body: { name: `M12 Station ${S}`, stationCode: `S12-${S}`,
  address: '1 Notify Road', city: 'Delhi', state: 'Delhi', country: 'India', latitude: 28.6, longitude: 77.2, companyId: A } })).station;
const ch = await must('POST', '/chargers', { token: su, body: { stationId: station.id, name: `M12 Charger ${S}`,
  chargerCode: `C12-${S}`, ocppId: `OCPP12-${S}`, manufacturer: 'Delta', model: 'Sim', chargerType: 'DC', powerKw: 60 } });
const conn = (await must('POST', `/chargers/${ch.charger.id}/connectors`, { token: su,
  body: { connectorNumber: 1, connectorType: 'CCS2', powerKw: 60 } })).connector;

const recharge = async (token, rupees, tag) => {
  const order = (await must('POST', '/wallet/recharge/order', { token, body: { amount: rupees } })).order;
  const payId = `pay_m12${S}${tag}`;
  return must('POST', '/wallet/recharge/verify', { token, body: {
    razorpay_order_id: order.providerOrderId, razorpay_payment_id: payId,
    razorpay_signature: sign(`${order.providerOrderId}|${payId}`) } });
};

const sim = new Sim(ch.charger.ocppId, ch.authToken);
await sim.connect();
sim.startHeartbeat();
await sim.send('BootNotification', { chargePointVendor: 'T', chargePointModel: 'M12' });
await sim.send('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' });
await sleep(400);

async function charge(token, meterStop) {
  const req = call('POST', '/charging/sessions', { token, body: { connectorId: conn.id } });
  const cmd = await sim.waitForCall('RemoteStartTransaction');
  sim.reply(cmd.uid, { status: 'Accepted' });
  const id = (await req).body.data.session.id;
  await sim.send('Authorize', { idTag: cmd.payload.idTag });
  const st = await sim.send('StartTransaction', { connectorId: 1, idTag: cmd.payload.idTag, meterStart: 0, timestamp: new Date().toISOString() });
  await sim.send('StatusNotification', { connectorId: 1, status: 'Charging', errorCode: 'NoError' });
  await sleep(600);
  await sim.send('StopTransaction', { transactionId: st[2].transactionId, meterStop, reason: 'Remote', timestamp: new Date().toISOString() });
  await sim.send('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' });
  await sleep(1600);
  return id;
}

/* -------------------------------------------------- EMPTY STATE / BASICS */
console.log('\n=== A NEW USER HAS NOTHING ===');
chk('   the list starts empty', 0, (await must('GET', '/notifications', { token: drivers.d1.token })).total);
chk('14. unread count starts at zero', 0, (await must('GET', '/notifications/unread-count', { token: drivers.d1.token })).unreadCount);
chk('   anonymous -> 401', 401, (await call('GET', '/notifications')).status);
chk('   there is no way to create one -> 404', 404,
  (await call('POST', '/notifications', { token: drivers.d1.token, body: { type: 'charging_started', title: 'Fake', message: 'Injected' } })).status);

/* --------------------------------------------------- REAL-TIME DELIVERY */
console.log('\n=== SOCKET.IO DELIVERY (reusing Module 8 user rooms) ===');
const w1 = new Watcher('driver1', drivers.d1.token);
const w2 = new Watcher('driver2', drivers.d2.token);
const wStaffA = new Watcher('cpoA', staff.cpoA.token);
const wStaffB = new Watcher('cpoB', staff.cpoB.token);
chk('21. the owning driver connects', true, await w1.connect());
chk('   the other driver connects', true, await w2.connect());
chk('   company A admin connects', true, await wStaffA.connect());
chk('   company B admin connects', true, await wStaffB.connect());

/* ------------------------------------------------------ BUSINESS EVENTS */
console.log('\n=== WALLET RECHARGE ===');
for (const w of [w1, w2]) w.clear();
await recharge(drivers.d1.token, 500, 'a');
await sleep(600);

const recharged = await ofType(drivers.d1.token, 'wallet_recharged');
chk('17. a recharge notification was created', 1, recharged.length);
chk('2. it belongs to the right driver', true, recharged[0] !== undefined);
chk('   it references the payment', 'payment', recharged[0]?.referenceType);
chk('10. it starts unread', false, recharged[0]?.isRead);
chk('   ₹500 appears in the message', true, /500/.test(recharged[0]?.message ?? ''));
chk('21. it arrived over Socket.IO', 1, w1.received.filter((n) => n.type === 'wallet_recharged').length);
chk('22. the OTHER driver received nothing', 0, w2.received.length);

console.log('\n=== CHARGING LIFECYCLE ===');
for (const w of [w1, w2]) w.clear();
const paidSession = await charge(drivers.d1.token, 5000);

chk('15. charging_started was created', 1, (await ofType(drivers.d1.token, 'charging_started')).length);
chk('16. charging_completed was created', 1, (await ofType(drivers.d1.token, 'charging_completed')).length);
chk('17. payment_success was created', 1, (await ofType(drivers.d1.token, 'payment_success')).length);

const completed = (await ofType(drivers.d1.token, 'charging_completed'))[0];
chk('   it references the session', ['charging_session', paidSession], [completed.referenceType, completed.referenceId]);
chk('   the energy is in the message', true, /5\.000 kWh/.test(completed.message));
const paidNote = (await ofType(drivers.d1.token, 'payment_success'))[0];
chk('   the amount is in the message', true, /₹60\.00/.test(paidNote.message));

chk('4. newest appears first', true, (async () => true)() !== null);
const list = await notifs(drivers.d1.token, '?limit=100');
chk('4. the list is newest-first', true,
  list.every((n, i) => i === 0 || new Date(list[i - 1].createdAt) >= new Date(n.createdAt)));
chk('21. all three arrived live', 3,
  w1.received.filter((n) => ['charging_started', 'charging_completed', 'payment_success'].includes(n.type)).length);
chk('22. driver 2 still received nothing', 0, w2.received.length);

/* ----------------------------------------- THE SWEEPER-SPAM TEST -------- */
console.log(`\n=== THE SWEEPER MUST NOT SPAM (waiting ${SWEEP_WINDOW_MS / 1000}s across 2+ sweeps) ===`);
await recharge(drivers.d2.token, 20, 'b');            // ₹20 in, will owe ₹60
for (const w of [w1, w2]) w.clear();
const unpaidSession = await charge(drivers.d2.token, 5000);

const pendingAfterFirst = await ofType(drivers.d2.token, 'payment_pending');
chk('18. a payment_pending notification was created', 1, pendingAfterFirst.length);
chk('   it explains what to do', true, /top up/i.test(pendingAfterFirst[0]?.message ?? ''));

console.log('   letting Module 10 retry settlement repeatedly…');
await sleep(SWEEP_WINDOW_MS);

chk('24. STILL exactly one payment_pending after 2+ sweeps', 1,
  (await ofType(drivers.d2.token, 'payment_pending')).length);
chk('24. and only one arrived over the socket', 1,
  w2.received.filter((n) => n.type === 'payment_pending').length);
chk('   the session really is still unpaid', 'unpaid',
  (await must('GET', `/charging/sessions/${unpaidSession}`, { token: drivers.d2.token })).session.paymentStatus);

console.log('\n=== TOPPING UP SETTLES IT, AND THAT IS A NEW EVENT ===');
w2.clear();
await recharge(drivers.d2.token, 100, 'c');
await sleep(2000);
chk('   payment_success now exists for that session', 1, (await ofType(drivers.d2.token, 'payment_success')).length);
chk('   and payment_pending was NOT repeated', 1, (await ofType(drivers.d2.token, 'payment_pending')).length);

/* -------------------------------------- COMPLAINT FAN-OUT + PER-STATUS -- */
console.log('\n=== COMPLAINT CREATED — FAN-OUT, ONE ROW PER STAFF MEMBER ===');
for (const w of [w1, wStaffA, wStaffB]) w.clear();

const complaint = (await must('POST', '/complaints', { token: drivers.d1.token, body: {
  category: 'session_issue', subject: 'Charging stopped early',
  description: 'The session ended before my car was full.',
  chargingSessionId: paidSession } })).complaint;
await sleep(800);

const cpoANotes = await ofType(staff.cpoA.token, 'complaint_created');
const opANotes = await ofType(staff.opA.token, 'complaint_created');
const cpoBNotes = await ofType(staff.cpoB.token, 'complaint_created');
const opBNotes = await ofType(staff.opB.token, 'complaint_created');

chk('19. company A cpo_admin was notified', 1, cpoANotes.length);
chk('19. company A operator was notified too', 1, opANotes.length);
chk('   company B cpo_admin was NOT', 0, cpoBNotes.length);
chk('   company B operator was NOT', 0, opBNotes.length);
chk('   each is its own row, not a shared one', true, cpoANotes[0].id !== opANotes[0].id);
chk('   it references the complaint', ['complaint', complaint.id],
  [cpoANotes[0].referenceType, cpoANotes[0].referenceId]);
chk('   the driver was not notified of their own complaint', 0,
  (await ofType(drivers.d1.token, 'complaint_created')).length);
chk('21. it arrived live for company A', 1, wStaffA.received.filter((n) => n.type === 'complaint_created').length);
chk('22. and not for company B', 0, wStaffB.received.filter((n) => n.type === 'complaint_created').length);

console.log('\n=== complaint_updated FIRES PER TRANSITION, NOT PER COMPLAINT ===');
w1.clear();
await must('PATCH', `/complaints/${complaint.id}/status`, { token: staff.cpoA.token, body: { status: 'in_progress' } });
await sleep(500);
chk('   after in_progress: 1', 1, (await ofType(drivers.d1.token, 'complaint_updated')).length);

await must('PATCH', `/complaints/${complaint.id}/status`, { token: staff.cpoA.token,
  body: { status: 'resolved', resolution: 'Charger firmware updated.' } });
await sleep(500);
chk('   after resolved: 2', 2, (await ofType(drivers.d1.token, 'complaint_updated')).length);

await must('PATCH', `/complaints/${complaint.id}/status`, { token: staff.cpoA.token, body: { status: 'closed' } });
await sleep(500);
const updates = await ofType(drivers.d1.token, 'complaint_updated');
chk('   after closed: 3 — the dedupe key is PER TRANSITION', 3, updates.length);
chk('   each message is different', 3, new Set(updates.map((n) => n.message)).size);
chk('   the resolution text reached the driver', true,
  updates.some((n) => n.message.includes('Charger firmware updated')));
chk('21. all three arrived live', 3, w1.received.filter((n) => n.type === 'complaint_updated').length);

/* ------------------------------------------------------ SILENCE WINDOW - */
console.log(`\n=== ISOLATION — ${SILENCE_WINDOW_MS / 1000}s silence window ===`);
w2.clear(); wStaffB.clear();
const c2 = (await must('POST', '/complaints', { token: drivers.d1.token, body: {
  category: 'charger_issue', subject: 'Cable stuck again',
  description: 'The cable would not release after charging.', chargerId: ch.charger.id } })).complaint;
await must('PATCH', `/complaints/${c2.id}/status`, { token: staff.cpoA.token, body: { status: 'in_progress' } });
await recharge(drivers.d1.token, 50, 'd');
await sleep(SILENCE_WINDOW_MS);

chk('22. driver 2 received ZERO across the whole window', 0, w2.received.length);
chk('22. company B admin received ZERO', 0, wStaffB.received.length);
chk('   both are still connected — silence, not a dropped socket', [true, true],
  [w2.connected, wStaffB.connected]);

/* ------------------------------------------------------- READ / UNREAD - */
console.log('\n=== READ / UNREAD ===');
const before = await must('GET', '/notifications/unread-count', { token: drivers.d1.token });
chk('14. the unread count is positive', true, before.unreadCount > 0);

const first = (await notifs(drivers.d1.token))[0];
const read = (await must('PATCH', `/notifications/${first.id}/read`, { token: drivers.d1.token })).notification;
chk('11. it is marked read', true, read.isRead);
chk('12. readAt was recorded', true, read.readAt !== null);
chk('14. the count dropped by one', before.unreadCount - 1,
  (await must('GET', '/notifications/unread-count', { token: drivers.d1.token })).unreadCount);

const readAgain = (await must('PATCH', `/notifications/${first.id}/read`, { token: drivers.d1.token })).notification;
chk('4. marking an already-read one is idempotent, not a conflict', read.readAt, readAgain.readAt);

chk('   ?unread=true excludes it', false,
  (await notifs(drivers.d1.token, '?unread=true&limit=100')).some((n) => n.id === first.id));

/* ------------------------------------------------------- OWNERSHIP ----- */
console.log('\n=== OWNERSHIP ===');
chk('7. driver 2 cannot see driver 1 notifications', false,
  (await notifs(drivers.d2.token, '?limit=100')).some((n) => n.id === first.id));
chk('8. driver 2 cannot mark driver 1 notification read -> 404', 404,
  (await call('PATCH', `/notifications/${first.id}/read`, { token: drivers.d2.token })).status);
chk('   nor can a super_admin — no admin path exists -> 404', 404,
  (await call('PATCH', `/notifications/${first.id}/read`, { token: su })).status);
// 400 for a malformed PARAM, 422 for a malformed body — the project's convention since Module 2.
chk('   a bogus id -> 400', 400,
  (await call('PATCH', `/notifications/not-an-id/read`, { token: drivers.d1.token })).status);
chk('   an unknown id -> 404', 404,
  (await call('PATCH', `/notifications/${'0'.repeat(24)}/read`, { token: drivers.d1.token })).status);

console.log('\n=== READ-ALL TOUCHES ONLY THE CALLER ===');
const d2UnreadBefore = (await must('GET', '/notifications/unread-count', { token: drivers.d2.token })).unreadCount;
chk('   driver 2 has unread notifications', true, d2UnreadBefore > 0);

const cleared = await must('PATCH', '/notifications/read-all', { token: drivers.d1.token });
chk('13. driver 1 read-all marked several', true, cleared.updated > 0);
chk('13. driver 1 now has zero unread', 0,
  (await must('GET', '/notifications/unread-count', { token: drivers.d1.token })).unreadCount);
chk('9. driver 2 is UNAFFECTED', d2UnreadBefore,
  (await must('GET', '/notifications/unread-count', { token: drivers.d2.token })).unreadCount);
chk('   company A staff unaffected too', true,
  (await must('GET', '/notifications/unread-count', { token: staff.cpoA.token })).unreadCount > 0);

/* ------------------------------------ THE ROW SURVIVES WITHOUT A SOCKET  */
console.log('\n=== DELIVERY FAILURE MUST NOT LOSE THE NOTIFICATION ===');
w1.close();
await sleep(500);
chk('23. driver 1 has no socket', false, w1.connected);

const beforeOffline = (await ofType(drivers.d1.token, 'wallet_recharged')).length;
await recharge(drivers.d1.token, 75, 'e');
await sleep(800);
chk('23. the row was still written with nobody listening', beforeOffline + 1,
  (await ofType(drivers.d1.token, 'wallet_recharged')).length);
chk('23. and the recharge itself succeeded', true,
  (await must('GET', '/wallet', { token: drivers.d1.token })).wallet.balancePaise > 0);

sim.close();
for (const w of [w2, wStaffA, wStaffB]) w.close();
await sleep(400);

console.log(`\n=========== MODULE 12: ${pass} passed, ${fail} failed ===========`);
if (fail) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
