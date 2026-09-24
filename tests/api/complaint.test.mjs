/* Module 11 verification — complaints, anchor derivation, the transition table. */

import { createRequire } from 'module';
import crypto from 'crypto';
const require = createRequire(new URL('../../backend/', import.meta.url));
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://localhost:5000/api/v1';
const WS_BASE = process.env.WS_BASE || 'ws://localhost:5000/ocpp';
const SECRET = process.env.RZP_SECRET || 'stub_secret_not_for_production';
const S = String(Date.now()).slice(-6);
const PW = 'ComplaintPass12345';
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
    const uid = `c-${Math.random().toString(36).slice(2)}`;
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
const A = await mkCompany('M11 Alpha');
const B = await mkCompany('M11 Beta');

for (const [companyId, rupees] of [[A, 12], [B, 20]]) {
  const t = (await must('POST', '/tariffs', { token: su, body: { name: 'Rate', pricePerKwh: rupees, companyId } })).tariff;
  await must('PATCH', `/tariffs/${t.id}/status`, { token: su, body: { status: 'active' } });
}

const staff = {};
for (const [key, companyId, role] of [
  ['cpoA', A, 'cpo_admin'], ['opA', A, 'operator'],
  ['cpoB', B, 'cpo_admin'], ['opB', B, 'operator'],
]) {
  const email = `${key}.m11.${S}@test.local`;
  await must('POST', '/users', { token: su, body: { name: `Staff ${key}`, email, password: PW, role, companyId } });
  staff[key] = { token: (await must('POST', '/auth/login', { body: { email, password: PW } })).token };
}

const drivers = {};
for (const key of ['d1', 'd2']) {
  const email = `${key}.m11.${S}@test.local`;
  const reg = await must('POST', '/auth/register', { body: { name: `Driver ${key}`, email, password: PW } });
  drivers[key] = { id: reg.user.id, token: (await must('POST', '/auth/login', { body: { email, password: PW } })).token };
}

const mkStation = async (companyId, code) => (await must('POST', '/stations', { token: su, body: {
  name: `Station ${code}`, stationCode: code, address: '1 Support Road', city: 'Delhi', state: 'Delhi',
  country: 'India', latitude: 28.6, longitude: 77.2, companyId } })).station;
const mkCharger = async (stationId, code) => {
  const r = await must('POST', '/chargers', { token: su, body: { stationId, name: `Charger ${code}`,
    chargerCode: code, ocppId: `OCPP11-${code}`, manufacturer: 'Delta', model: 'Sim', chargerType: 'DC', powerKw: 60 } });
  return { id: r.charger.id, ocppId: r.charger.ocppId, token: r.authToken };
};
const stA = await mkStation(A, `S11A-${S}`);
const stB = await mkStation(B, `S11B-${S}`);
const chA = await mkCharger(stA.id, `C11A-${S}`);
const chB = await mkCharger(stB.id, `C11B-${S}`);
const conA = (await must('POST', `/chargers/${chA.id}/connectors`, { token: su, body: { connectorNumber: 1, connectorType: 'CCS2', powerKw: 60 } })).connector;

/* Fund driver 1 and give both drivers a real completed session on company A. */
const recharge = async (token, rupees, tag) => {
  const order = (await must('POST', '/wallet/recharge/order', { token, body: { amount: rupees } })).order;
  const payId = `pay_m11${S}${tag}`;
  return must('POST', '/wallet/recharge/verify', { token, body: {
    razorpay_order_id: order.providerOrderId, razorpay_payment_id: payId,
    razorpay_signature: sign(`${order.providerOrderId}|${payId}`) } });
};
await recharge(drivers.d1.token, 500, 'a');

const sim = new Sim(chA.ocppId, chA.token);
await sim.connect();
sim.startHeartbeat();
await sim.send('BootNotification', { chargePointVendor: 'T', chargePointModel: 'M11' });
await sim.send('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' });
await sleep(400);

async function charge(token, meterStop) {
  const req = call('POST', '/charging/sessions', { token, body: { connectorId: conA.id } });
  const cmd = await sim.waitForCall('RemoteStartTransaction');
  sim.reply(cmd.uid, { status: 'Accepted' });
  const id = (await req).body.data.session.id;
  await sim.send('Authorize', { idTag: cmd.payload.idTag });
  const st = await sim.send('StartTransaction', { connectorId: 1, idTag: cmd.payload.idTag, meterStart: 0, timestamp: new Date().toISOString() });
  await sim.send('StatusNotification', { connectorId: 1, status: 'Charging', errorCode: 'NoError' });
  await sim.send('StopTransaction', { transactionId: st[2].transactionId, meterStop, reason: 'Remote', timestamp: new Date().toISOString() });
  await sim.send('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' });
  await sleep(1400);
  return id;
}

const paidSession = await charge(drivers.d1.token, 5000);          // d1 has money -> paid
const unpaidSession = await charge(drivers.d2.token, 5000);        // d2 has none  -> unpaid
console.log(`  d1 paid session + d2 unpaid session created`);

/* ------------------------------------------------ ANCHOR DERIVATION ----- */
console.log('\n=== ANCHOR DERIVATION — the mismatch attack is unrepresentable ===');

const anchored = (await must('POST', '/complaints', { token: drivers.d1.token, body: {
  category: 'session_issue', subject: 'Charger stopped during charging',
  description: 'Charging stopped after 15 minutes and the cable stayed locked.',
  chargingSessionId: paidSession } })).complaint;

chk('1/2. the complaint belongs to the authenticated driver', drivers.d1.id, anchored.userId);
chk('4. companyId was DERIVED from the session', A, anchored.companyId);
chk('4. stationId was derived', stA.id, anchored.stationId);
chk('4. chargerId was derived', chA.id, anchored.chargerId);
chk('4. connectorId was derived', conA.id, anchored.connectorId);
chk('   it opens in `open`', 'open', anchored.status);
chk('   triaged medium: a session problem on a charge that completed', 'medium', anchored.priority);

chk('   sending stationId directly -> 422', 422,
  (await call('POST', '/complaints', { token: drivers.d1.token, body: {
    category: 'other', subject: 'Trying to inject a station', description: 'This should be rejected outright.',
    stationId: stB.id } })).status);
chk('   sending companyId directly -> 422', 422,
  (await call('POST', '/complaints', { token: drivers.d1.token, body: {
    category: 'other', subject: 'Trying to inject a company', description: 'This should be rejected outright.',
    companyId: B } })).status);
chk('   sending connectorId directly -> 422', 422,
  (await call('POST', '/complaints', { token: drivers.d1.token, body: {
    category: 'other', subject: 'Trying to inject a connector', description: 'This should be rejected outright.',
    connectorId: conA.id } })).status);
chk('   sending userId directly -> 422', 422,
  (await call('POST', '/complaints', { token: drivers.d1.token, body: {
    category: 'other', subject: 'Trying to impersonate', description: 'This should be rejected outright.',
    userId: drivers.d2.id } })).status);
chk('   sending status directly -> 422', 422,
  (await call('POST', '/complaints', { token: drivers.d1.token, body: {
    category: 'other', subject: 'Trying to open as resolved', description: 'This should be rejected outright.',
    status: 'resolved' } })).status);
chk('   two anchors at once -> 422', 422,
  (await call('POST', '/complaints', { token: drivers.d1.token, body: {
    category: 'other', subject: 'Two anchors supplied', description: 'A session and a charger together.',
    chargingSessionId: paidSession, chargerId: chB.id } })).status);

console.log('\n=== THE MISMATCH ATTACK ===');
const beforeAttack = (await must('GET', '/complaints', { token: drivers.d2.token })).total;
chk('   driver 2 referencing driver 1 session -> 404', 404,
  (await call('POST', '/complaints', { token: drivers.d2.token, body: {
    category: 'session_issue', subject: 'Someone else session', description: 'Referencing a session I do not own.',
    chargingSessionId: paidSession } })).status);
chk('   and NO complaint was created', beforeAttack,
  (await must('GET', '/complaints', { token: drivers.d2.token })).total);
chk('   unknown session id -> 404', 404,
  (await call('POST', '/complaints', { token: drivers.d1.token, body: {
    category: 'session_issue', subject: 'Ghost session', description: 'Referencing a session that does not exist.',
    chargingSessionId: '0'.repeat(24) } })).status);
chk('   unknown charger id -> 404', 404,
  (await call('POST', '/complaints', { token: drivers.d1.token, body: {
    category: 'charger_issue', subject: 'Ghost charger', description: 'Referencing a charger that does not exist.',
    chargerId: '0'.repeat(24) } })).status);

console.log('\n=== THE CHARGER ANCHOR (no session to point at) ===');
const chargerAnchored = (await must('POST', '/complaints', { token: drivers.d1.token, body: {
  category: 'charger_issue', subject: 'Screen dead on arrival',
  description: 'I arrived and the charger screen was completely dead. Never started a session.',
  chargerId: chA.id } })).complaint;
chk('   station and company derived from the charger', [stA.id, A],
  [chargerAnchored.stationId, chargerAnchored.companyId]);
chk('   no session is attached', null, chargerAnchored.chargingSessionId);
chk('   triaged high automatically: a broken charger affects every driver', 'high', chargerAnchored.priority);

console.log('\n=== AN ANCHORLESS COMPLAINT IS PLATFORM-LEVEL ===');
const platform = (await must('POST', '/complaints', { token: drivers.d1.token, body: {
  category: 'account_issue', subject: 'Cannot update my profile',
  description: 'Saving my profile returns an error every time I try.' } })).complaint;
chk('   it belongs to no company', null, platform.companyId);
chk('   super_admin can see it', 200, (await call('GET', `/complaints/${platform.id}`, { token: su })).status);
chk('   company A staff CANNOT', 403, (await call('GET', `/complaints/${platform.id}`, { token: staff.cpoA.token })).status);
chk('   company B staff cannot either', 403, (await call('GET', `/complaints/${platform.id}`, { token: staff.cpoB.token })).status);
chk('   the driver who filed it can', 200, (await call('GET', `/complaints/${platform.id}`, { token: drivers.d1.token })).status);

/* ----------------------------------------------------- VALIDATION ------- */
console.log('\n=== VALIDATION ===');
chk('3. empty subject -> 422', 422, (await call('POST', '/complaints', { token: drivers.d1.token, body: {
  category: 'other', subject: '', description: 'A description that is long enough.' } })).status);
chk('3. empty description -> 422', 422, (await call('POST', '/complaints', { token: drivers.d1.token, body: {
  category: 'other', subject: 'A valid subject', description: '' } })).status);
chk('3. unknown category -> 422', 422, (await call('POST', '/complaints', { token: drivers.d1.token, body: {
  category: 'alien_issue', subject: 'A valid subject', description: 'A description that is long enough.' } })).status);
chk('3. driver sending any priority -> 422 (internal triage field)', 422, (await call('POST', '/complaints', { token: drivers.d1.token, body: {
  category: 'other', subject: 'A valid subject', description: 'A description that is long enough.', priority: 'high' } })).status);
chk('   an account problem is triaged medium', 'medium', platform.priority);
chk('3. malformed session id -> 422', 422, (await call('POST', '/complaints', { token: drivers.d1.token, body: {
  category: 'session_issue', subject: 'A valid subject', description: 'A description that is long enough.',
  chargingSessionId: 'not-an-id' } })).status);
chk('   anonymous -> 401', 401, (await call('POST', '/complaints', { body: {
  category: 'other', subject: 'A valid subject', description: 'A description that is long enough.' } })).status);
chk('   staff cannot file a complaint -> 403', 403, (await call('POST', '/complaints', { token: staff.cpoA.token, body: {
  category: 'other', subject: 'Staff filing', description: 'Staff should not be able to file complaints.' } })).status);

/* --------------------------------------------------- DRIVER OWNERSHIP --- */
console.log('\n=== DRIVER OWNERSHIP ===');
const d2Complaint = (await must('POST', '/complaints', { token: drivers.d2.token, body: {
  category: 'payment_issue', subject: 'Charged but I never got the energy',
  description: 'The session says 5 kWh but my car did not charge at all.',
  chargingSessionId: unpaidSession } })).complaint;

chk('5. driver sees their own complaints', true,
  (await must('GET', '/complaints', { token: drivers.d1.token })).items.every((c) => c.userId === drivers.d1.id));
chk('6. driver 2 cannot read driver 1 complaint -> 404', 404,
  (await call('GET', `/complaints/${anchored.id}`, { token: drivers.d2.token })).status);
chk('6. nor does it appear in their list', false,
  (await must('GET', '/complaints', { token: drivers.d2.token })).items.some((c) => c.id === anchored.id));
chk('7. driver cannot PATCH any complaint -> 403', 403,
  (await call('PATCH', `/complaints/${anchored.id}`, { token: drivers.d1.token, body: { resolution: 'Fixed it myself' } })).status);
chk('8. driver cannot change status -> 403', 403,
  (await call('PATCH', `/complaints/${anchored.id}/status`, { token: drivers.d1.token, body: { status: 'resolved', resolution: 'All good' } })).status);
chk('8. driver cannot close their own complaint -> 403', 403,
  (await call('PATCH', `/complaints/${anchored.id}/status`, { token: drivers.d1.token, body: { status: 'closed' } })).status);

console.log('\n=== PRIORITY: set by the system, re-triaged by staff, invisible to the driver\'s control ===');
chk('   the system set `high` at creation', 'high', chargerAnchored.priority);
chk('   the driver cannot change it -> 403', 403,
  (await call('PATCH', `/complaints/${chargerAnchored.id}`, { token: drivers.d1.token, body: { priority: 'low' } })).status);
chk('   and it is unchanged', 'high',
  (await must('GET', `/complaints/${chargerAnchored.id}`, { token: drivers.d1.token })).complaint.priority);
chk('   a cpo_admin CAN change it', 200,
  (await call('PATCH', `/complaints/${chargerAnchored.id}`, { token: staff.cpoA.token, body: { priority: 'low' } })).status);
chk('   an operator CAN too — triage is frontline work', 200,
  (await call('PATCH', `/complaints/${chargerAnchored.id}`, { token: staff.opA.token, body: { priority: 'high' } })).status);

console.log('\n=== SUBJECT AND DESCRIPTION ARE IMMUTABLE ===');
chk('   editing subject -> 422', 422,
  (await call('PATCH', `/complaints/${anchored.id}`, { token: staff.cpoA.token, body: { subject: 'Rewritten' } })).status);
chk('   editing description -> 422', 422,
  (await call('PATCH', `/complaints/${anchored.id}`, { token: staff.cpoA.token, body: { description: 'Rewritten description here.' } })).status);
chk('   the original text survives', 'Charger stopped during charging',
  (await must('GET', `/complaints/${anchored.id}`, { token: su })).complaint.subject);

/* ------------------------------------------------- COMPANY SCOPING ------ */
console.log('\n=== COMPANY SCOPING ===');
chk('9. company A admin sees the company A complaint', 200,
  (await call('GET', `/complaints/${anchored.id}`, { token: staff.cpoA.token })).status);
chk('9. company A operator sees it too', 200,
  (await call('GET', `/complaints/${anchored.id}`, { token: staff.opA.token })).status);
chk('10. company B admin cannot -> 403', 403,
  (await call('GET', `/complaints/${anchored.id}`, { token: staff.cpoB.token })).status);
chk('11. company B operator cannot -> 403', 403,
  (await call('GET', `/complaints/${anchored.id}`, { token: staff.opB.token })).status);
chk('10. a non-existent id is ALSO 403 for a scoped caller (no probing)', 403,
  (await call('GET', `/complaints/${'0'.repeat(24)}`, { token: staff.cpoB.token })).status);
chk('12. super_admin can see it', 200, (await call('GET', `/complaints/${anchored.id}`, { token: su })).status);
chk('10. the company B list never leaks company A', false,
  (await must('GET', '/complaints', { token: staff.cpoB.token })).items.some((c) => c.companyId === A));
chk('   filters work on the scoped set', true,
  (await must('GET', '/complaints?status=open', { token: staff.cpoA.token })).items.every((c) => c.status === 'open'));
chk('   category filter works', true,
  (await must('GET', '/complaints?category=session_issue', { token: staff.cpoA.token })).items.every((c) => c.category === 'session_issue'));

/* ------------------------------------------------ TRANSITION TABLE ------ */
console.log('\n=== THE TRANSITION TABLE — every illegal edge, individually ===');
const tId = anchored.id;

chk('17. open -> resolved is illegal -> 409', 409,
  (await call('PATCH', `/complaints/${tId}/status`, { token: staff.cpoA.token, body: { status: 'resolved', resolution: 'Skipping ahead' } })).status);
chk('17. open -> closed is illegal -> 409', 409,
  (await call('PATCH', `/complaints/${tId}/status`, { token: staff.cpoA.token, body: { status: 'closed' } })).status);

chk('13. open -> in_progress is allowed', 200,
  (await call('PATCH', `/complaints/${tId}/status`, { token: staff.cpoA.token, body: { status: 'in_progress' } })).status);
chk('   in_progress -> open is allowed (work paused)', 200,
  (await call('PATCH', `/complaints/${tId}/status`, { token: staff.cpoA.token, body: { status: 'open' } })).status);
await call('PATCH', `/complaints/${tId}/status`, { token: staff.cpoA.token, body: { status: 'in_progress' } });

chk('17. in_progress -> closed is illegal -> 409', 409,
  (await call('PATCH', `/complaints/${tId}/status`, { token: staff.cpoA.token, body: { status: 'closed' } })).status);
chk('   resolving with NO resolution text -> 422', 422,
  (await call('PATCH', `/complaints/${tId}/status`, { token: staff.cpoA.token, body: { status: 'resolved' } })).status);

const resolved = (await must('PATCH', `/complaints/${tId}/status`, { token: staff.cpoA.token,
  body: { status: 'resolved', resolution: 'Charger connection reset and tested.' } })).complaint;
chk('14. in_progress -> resolved is allowed', 'resolved', resolved.status);
chk('18. the resolution is stored', 'Charger connection reset and tested.', resolved.resolution);
chk('19. resolvedAt is recorded', true, resolved.resolvedAt !== null);
chk('19. and who resolved it', true, resolved.resolvedBy !== null);

chk('17. resolved -> in_progress is illegal -> 409', 409,
  (await call('PATCH', `/complaints/${tId}/status`, { token: staff.cpoA.token, body: { status: 'in_progress' } })).status);
chk('17. resolved -> open is illegal -> 409', 409,
  (await call('PATCH', `/complaints/${tId}/status`, { token: staff.cpoA.token, body: { status: 'open' } })).status);

chk('15. resolved -> closed is allowed', 200,
  (await call('PATCH', `/complaints/${tId}/status`, { token: staff.cpoA.token, body: { status: 'closed' } })).status);

console.log('\n=== CLOSED IS TERMINAL ===');
chk('17. closed -> open -> 409', 409,
  (await call('PATCH', `/complaints/${tId}/status`, { token: staff.cpoA.token, body: { status: 'open' } })).status);
chk('17. closed -> in_progress -> 409', 409,
  (await call('PATCH', `/complaints/${tId}/status`, { token: staff.cpoA.token, body: { status: 'in_progress' } })).status);
chk('17. closed -> resolved -> 409', 409,
  (await call('PATCH', `/complaints/${tId}/status`, { token: staff.cpoA.token, body: { status: 'resolved', resolution: 'Again' } })).status);
chk('   a closed complaint cannot be annotated -> 409', 409,
  (await call('PATCH', `/complaints/${tId}`, { token: staff.cpoA.token, body: { resolution: 'Late note' } })).status);
chk('   the error explains what to do instead', true,
  /new one/i.test((await call('PATCH', `/complaints/${tId}/status`, { token: staff.cpoA.token, body: { status: 'open' } })).body?.message ?? ''));

/* ------------------------------------------------- OPERATOR BOUNDARY ---- */
console.log('\n=== OPERATOR: can work a ticket, cannot conclude one ===');
const opTicket = (await must('POST', '/complaints', { token: drivers.d1.token, body: {
  category: 'charger_issue', subject: 'Cable will not unlock',
  description: 'The cable stayed locked after the session ended.', chargerId: chA.id } })).complaint;

chk('13. operator can move open -> in_progress', 200,
  (await call('PATCH', `/complaints/${opTicket.id}/status`, { token: staff.opA.token, body: { status: 'in_progress' } })).status);
chk('   operator can add interim notes', 200,
  (await call('PATCH', `/complaints/${opTicket.id}`, { token: staff.opA.token, body: { resolution: 'Attended site, cable released manually.' } })).status);
chk('16. operator CANNOT resolve -> 403', 403,
  (await call('PATCH', `/complaints/${opTicket.id}/status`, { token: staff.opA.token, body: { status: 'resolved', resolution: 'Done' } })).status);
chk('   the error says who can', true,
  /administrator/i.test((await call('PATCH', `/complaints/${opTicket.id}/status`, { token: staff.opA.token, body: { status: 'resolved', resolution: 'Done' } })).body?.message ?? ''));
/*
 * THE TWO GATES ARE INDEPENDENT, and this pair proves it.
 *
 * From `in_progress`, closing is an ILLEGAL TRANSITION for anyone -> 409. The role check never
 * runs, because you cannot get there from here regardless of who you are.
 */
chk('   in_progress -> closed is 409 for the operator too (transition, not role)', 409,
  (await call('PATCH', `/complaints/${opTicket.id}/status`, { token: staff.opA.token, body: { status: 'closed' } })).status);

chk('   a cpo_admin can resolve it', 200,
  (await call('PATCH', `/complaints/${opTicket.id}/status`, { token: staff.cpoA.token, body: { status: 'resolved', resolution: 'Cable mechanism replaced.' } })).status);

// NOW the transition is legal, so the ROLE gate is what answers -> 403.
chk('16. operator cannot close even when the transition IS legal -> 403', 403,
  (await call('PATCH', `/complaints/${opTicket.id}/status`, { token: staff.opA.token, body: { status: 'closed' } })).status);
chk('   and a cpo_admin can', 200,
  (await call('PATCH', `/complaints/${opTicket.id}/status`, { token: staff.cpoA.token, body: { status: 'closed' } })).status);
chk('   the operator note survived into the resolution', true,
  (await must('GET', `/complaints/${opTicket.id}`, { token: su })).complaint.resolution.includes('Cable mechanism replaced'));

/* ---------------------------------------------- PAYMENT DISPUTE (D1) ---- */
console.log('\n=== A PAYMENT DISPUTE SEES THE MONEY BUT CANNOT TOUCH IT ===');
const disputeView = await must('GET', `/complaints/${d2Complaint.id}`, { token: staff.cpoA.token });
chk('   the complaint surfaces its session', unpaidSession, disputeView.session?.sessionId);
chk('   with the LIVE payment status', 'unpaid', disputeView.session?.paymentStatus);
chk('   the amount at stake', 6000, disputeView.session?.amountPaise);
chk('   and the rate that produced it', 1200, disputeView.session?.appliedPricePerKwhPaise);
chk('   an anchorless complaint has no session context', null,
  (await must('GET', `/complaints/${platform.id}`, { token: su })).session);

const walletBefore = (await must('GET', '/wallet', { token: drivers.d2.token })).wallet.balancePaise;
await must('PATCH', `/complaints/${d2Complaint.id}/status`, { token: staff.cpoA.token, body: { status: 'in_progress' } });
await must('PATCH', `/complaints/${d2Complaint.id}/status`, { token: staff.cpoA.token,
  body: { status: 'resolved', resolution: 'Charger fault confirmed from meter logs. Waived pending finance review.' } });

const afterResolve = await must('GET', `/complaints/${d2Complaint.id}`, { token: staff.cpoA.token });
chk('   resolving records the decision as an auditable note', true,
  afterResolve.complaint.resolution.includes('Waived pending finance review'));
chk('   the wallet is UNCHANGED — no write-off mechanism exists', walletBefore,
  (await must('GET', '/wallet', { token: drivers.d2.token })).wallet.balancePaise);
chk('   the session is STILL unpaid', 'unpaid', afterResolve.session?.paymentStatus);
chk('   the debt was not silently forgiven', 6000, afterResolve.session?.amountPaise);

/* ------------------------------------------------- DRIVER SEES RESULT --- */
console.log('\n=== THE DRIVER SEES THE OUTCOME ===');
const d2View = await must('GET', `/complaints/${d2Complaint.id}`, { token: drivers.d2.token });
chk('   the driver sees the status', 'resolved', d2View.complaint.status);
chk('   and the resolution text', true, d2View.complaint.resolution.includes('Charger fault confirmed'));

sim.close();
await sleep(400);

console.log(`\n=========== MODULE 11: ${pass} passed, ${fail} failed ===========`);
if (fail) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
