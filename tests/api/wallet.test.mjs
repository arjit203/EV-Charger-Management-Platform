/* Module 10 verification — wallet, Razorpay payments, settlement.
   Real HMAC signatures (our own crypto, never stubbed), real OCPP sessions, real concurrency. */

import { createRequire } from 'module';
import crypto from 'crypto';
const require = createRequire(new URL('../../backend/', import.meta.url));
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://localhost:5000/api/v1';
const WS_BASE = process.env.WS_BASE || 'ws://localhost:5000/ocpp';
/* Must match RAZORPAY_KEY_SECRET in the backend env; falls back to the stub secret. */
const SECRET = process.env.RZP_SECRET || 'stub_secret_not_for_production';
const S = String(Date.now()).slice(-6);
const PW = 'WalletPass12345';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0; const failures = [];
const chk = (name, expected, actual) => {
  const e = JSON.stringify(expected), a = JSON.stringify(actual);
  if (e === a) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}  (expected ${e}, got ${a})`); failures.push(name); fail++; }
};

const call = async (m, p, o = {}) => {
  const h = { 'Content-Type': 'application/json', ...(o.headers ?? {}) };
  if (o.token) h.Authorization = `Bearer ${o.token}`;
  const r = await fetch(BASE + p, { method: m, headers: h, body: o.rawBody ?? (o.body && JSON.stringify(o.body)) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const must = async (m, p, o) => {
  const r = await call(m, p, o);
  if (r.status >= 400) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
};

const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
const rs = (paise) => `₹${(paise / 100).toFixed(2)}`;

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
    const uid = `w-${Math.random().toString(36).slice(2)}`;
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
const A = await mkCompany('M10 Alpha');
const B = await mkCompany('M10 Beta');

for (const [companyId, rupees] of [[A, 12], [B, 20]]) {
  const t = (await must('POST', '/tariffs', { token: su, body: { name: 'Rate', pricePerKwh: rupees, companyId } })).tariff;
  await must('PATCH', `/tariffs/${t.id}/status`, { token: su, body: { status: 'active' } });
}

const staff = {};
for (const [key, companyId, role] of [['cpoA', A, 'cpo_admin'], ['cpoB', B, 'cpo_admin']]) {
  const email = `${key}.m10.${S}@test.local`;
  await must('POST', '/users', { token: su, body: { name: `Staff ${key}`, email, password: PW, role, companyId } });
  staff[key] = { token: (await must('POST', '/auth/login', { body: { email, password: PW } })).token };
}

const drivers = {};
for (const key of ['d1', 'd2']) {
  const email = `${key}.m10.${S}@test.local`;
  const reg = await must('POST', '/auth/register', { body: { name: `Driver ${key}`, email, password: PW } });
  drivers[key] = { id: reg.user.id, token: (await must('POST', '/auth/login', { body: { email, password: PW } })).token };
}

const station = (await must('POST', '/stations', { token: su, body: { name: `M10 Station ${S}`, stationCode: `S10-${S}`,
  address: '1 Pay Road', city: 'Delhi', state: 'Delhi', country: 'India', latitude: 28.6, longitude: 77.2, companyId: A } })).station;
const ch = await must('POST', '/chargers', { token: su, body: { stationId: station.id, name: `M10 Charger ${S}`,
  chargerCode: `C10-${S}`, ocppId: `OCPP10-${S}`, manufacturer: 'Delta', model: 'Sim', chargerType: 'DC', powerKw: 60 } });
const conn = (await must('POST', `/chargers/${ch.charger.id}/connectors`, { token: su,
  body: { connectorNumber: 1, connectorType: 'CCS2', powerKw: 60 } })).connector;

const walletOf = async (token) => (await must('GET', '/wallet', { token })).wallet;
const sess = async (id) => (await must('GET', `/charging/sessions/${id}`, { token: su })).session;

/* ---------------------------------------------- MODULE 9 CARRYOVER (D13) - */
console.log('\n=== STEP 0 — the last active tariff cannot be deactivated ===');
const aTariff = (await must('GET', '/tariffs?status=active', { token: staff.cpoA.token })).items[0];
chk('D13. deactivating the only active tariff -> 409', 409,
  (await call('PATCH', `/tariffs/${aTariff.id}/status`, { token: staff.cpoA.token, body: { status: 'inactive' } })).status);
chk('D13. it is still active', 'active', (await must('GET', `/tariffs/${aTariff.id}`, { token: staff.cpoA.token })).tariff.status);

const replacement = (await must('POST', '/tariffs', { token: staff.cpoA.token, body: { name: 'Replacement', pricePerKwh: 12 } })).tariff;
chk('D13. the activate-a-replacement SWAP is unaffected', 200,
  (await call('PATCH', `/tariffs/${replacement.id}/status`, { token: staff.cpoA.token, body: { status: 'active' } })).status);
chk('D13. the old one was deactivated by the swap', 'inactive',
  (await must('GET', `/tariffs/${aTariff.id}`, { token: staff.cpoA.token })).tariff.status);

/* ------------------------------------------------------------- WALLET ---- */
console.log('\n=== WALLET ===');
const w1 = await walletOf(drivers.d1.token);
chk('1. a wallet is created on first access', true, typeof w1.id === 'string');
chk('1. starting balance is zero', 0, w1.balancePaise);
chk('2. driver can view their own wallet', 200, (await call('GET', '/wallet', { token: drivers.d1.token })).status);
chk('3. staff have no wallet -> 403', 403, (await call('GET', '/wallet', { token: staff.cpoA.token })).status);
chk('   anonymous -> 401', 401, (await call('GET', '/wallet')).status);

chk('4. a driver cannot set their balance (no such field) -> 422', 422,
  (await call('POST', '/wallet/recharge/order', { token: drivers.d1.token, body: { amount: 500, balancePaise: 100000 } })).status);
chk('4. nor userId', 422,
  (await call('POST', '/wallet/recharge/order', { token: drivers.d1.token, body: { amount: 500, userId: drivers.d2.id } })).status);
chk('5. the ledger starts empty', 0, (await must('GET', '/wallet/transactions', { token: drivers.d1.token })).total);

/* ------------------------------------------------------------ RECHARGE -- */
console.log('\n=== RECHARGE ORDER ===');
chk('7. below the minimum -> 422', 422,
  (await call('POST', '/wallet/recharge/order', { token: drivers.d1.token, body: { amount: 5 } })).status);
chk('7. above the maximum -> 422', 422,
  (await call('POST', '/wallet/recharge/order', { token: drivers.d1.token, body: { amount: 50000 } })).status);
chk('7. negative -> 422', 422,
  (await call('POST', '/wallet/recharge/order', { token: drivers.d1.token, body: { amount: -100 } })).status);
chk('7. zero -> 422', 422,
  (await call('POST', '/wallet/recharge/order', { token: drivers.d1.token, body: { amount: 0 } })).status);

const order = (await must('POST', '/wallet/recharge/order', { token: drivers.d1.token, body: { amount: 500 } })).order;
chk('6. a valid order is created', true, typeof order.providerOrderId === 'string');
chk('6. ₹500 is 50000 paise', 50000, order.amountPaise);
chk('6. the response carries the PUBLIC key only', true, order.keyId.startsWith('rzp_'));
chk('   and no secret leaks', false, JSON.stringify(order).includes('secret'));
console.log(`  (provider mode: ${order.mode})`);

/* ------------------------------------------------- SIGNATURE VERIFICATION */
console.log('\n=== SIGNATURE VERIFICATION (real HMAC, never stubbed) ===');
const payId = `pay_test${S}01`;
const goodSig = sign(`${order.providerOrderId}|${payId}`);

chk('9. a tampered payment id is rejected -> 400', 400,
  (await call('POST', '/wallet/recharge/verify', { token: drivers.d1.token, body: {
    razorpay_order_id: order.providerOrderId, razorpay_payment_id: 'pay_forged', razorpay_signature: goodSig } })).status);
chk('9. a tampered order id is rejected -> 400', 400,
  (await call('POST', '/wallet/recharge/verify', { token: drivers.d1.token, body: {
    razorpay_order_id: 'order_forged', razorpay_payment_id: payId, razorpay_signature: goodSig } })).status);
chk('9. a signature from the wrong secret is rejected -> 400', 400,
  (await call('POST', '/wallet/recharge/verify', { token: drivers.d1.token, body: {
    razorpay_order_id: order.providerOrderId, razorpay_payment_id: payId,
    razorpay_signature: crypto.createHmac('sha256', 'wrong').update(`${order.providerOrderId}|${payId}`).digest('hex') } })).status);
chk('   the wallet was never touched by any of those', 0, (await walletOf(drivers.d1.token)).balancePaise);

const verified = await must('POST', '/wallet/recharge/verify', { token: drivers.d1.token, body: {
  razorpay_order_id: order.providerOrderId, razorpay_payment_id: payId, razorpay_signature: goodSig } });
chk('8/10. a valid signature credits the wallet', 50000, verified.wallet.balancePaise);
chk('12. the payment is marked paid', 'paid', verified.payment.status);
chk('11. a ledger row was written', 1, (await must('GET', '/wallet/transactions', { token: drivers.d1.token })).total);
const firstEntry = (await must('GET', '/wallet/transactions', { token: drivers.d1.token })).items[0];
chk('11. it is a recharge credit', ['recharge', 'credit'], [firstEntry.type, firstEntry.direction]);
chk('11. balanceAfter is recorded', 50000, firstEntry.balanceAfterPaise);

/* --------------------------------------------------------- IDEMPOTENCY -- */
console.log('\n=== IDEMPOTENCY — the same payment cannot be credited twice ===');
const again = await must('POST', '/wallet/recharge/verify', { token: drivers.d1.token, body: {
  razorpay_order_id: order.providerOrderId, razorpay_payment_id: payId, razorpay_signature: goodSig } });
chk('13. a repeat verify reports alreadyProcessed', true, again.alreadyProcessed);
chk('13. and the balance did NOT move', 50000, again.wallet.balancePaise);
chk('13. still exactly one ledger row', 1, (await must('GET', '/wallet/transactions', { token: drivers.d1.token })).total);

// The real race: several concurrent verifies of one payment.
const order2 = (await must('POST', '/wallet/recharge/order', { token: drivers.d1.token, body: { amount: 100 } })).order;
const pay2 = `pay_test${S}02`;
const sig2 = sign(`${order2.providerOrderId}|${pay2}`);
const burst = await Promise.all([0, 1, 2, 3].map(() =>
  call('POST', '/wallet/recharge/verify', { token: drivers.d1.token, body: {
    razorpay_order_id: order2.providerOrderId, razorpay_payment_id: pay2, razorpay_signature: sig2 } })));
chk('28. 4 concurrent verifies all answered without error', true, burst.every((r) => r.status === 200));
chk('28. the wallet moved exactly once (₹500 + ₹100)', 60000, (await walletOf(drivers.d1.token)).balancePaise);
chk('28. exactly two ledger rows exist', 2, (await must('GET', '/wallet/transactions', { token: drivers.d1.token })).total);

/* ------------------------------------------------------------- WEBHOOK -- */
console.log('\n=== WEBHOOK ===');
const order3 = (await must('POST', '/wallet/recharge/order', { token: drivers.d1.token, body: { amount: 200 } })).order;
const pay3 = `pay_test${S}03`;
const hookBody = JSON.stringify({ event: 'payment.captured',
  payload: { payment: { entity: { id: pay3, order_id: order3.providerOrderId } } } });
const hookSig = sign(hookBody);

chk('15. a bad webhook signature -> 400', 400,
  (await call('POST', '/payments/webhook/razorpay', { rawBody: hookBody, headers: { 'x-razorpay-signature': 'nonsense' } })).status);
chk('15. a missing signature header -> 400', 400,
  (await call('POST', '/payments/webhook/razorpay', { rawBody: hookBody })).status);
chk('   the wallet was not touched', 60000, (await walletOf(drivers.d1.token)).balancePaise);

chk('14. a valid webhook is processed', 200,
  (await call('POST', '/payments/webhook/razorpay', { rawBody: hookBody, headers: { 'x-razorpay-signature': hookSig } })).status);
chk('14. the wallet was credited', 80000, (await walletOf(drivers.d1.token)).balancePaise);

const dupHook = await call('POST', '/payments/webhook/razorpay', { rawBody: hookBody, headers: { 'x-razorpay-signature': hookSig } });
chk('16. a DUPLICATE webhook returns 200, never a 4xx', 200, dupHook.status);
chk('16. it reports already processed', true, /already/i.test(dupHook.body.message));
chk('16. and the balance did not move', 80000, (await walletOf(drivers.d1.token)).balancePaise);

// Webhook vs client-verify racing for one payment.
const order4 = (await must('POST', '/wallet/recharge/order', { token: drivers.d1.token, body: { amount: 100 } })).order;
const pay4 = `pay_test${S}04`;
const body4 = JSON.stringify({ event: 'payment.captured',
  payload: { payment: { entity: { id: pay4, order_id: order4.providerOrderId } } } });
await Promise.all([
  call('POST', '/payments/webhook/razorpay', { rawBody: body4, headers: { 'x-razorpay-signature': sign(body4) } }),
  call('POST', '/wallet/recharge/verify', { token: drivers.d1.token, body: {
    razorpay_order_id: order4.providerOrderId, razorpay_payment_id: pay4,
    razorpay_signature: sign(`${order4.providerOrderId}|${pay4}`) } }),
]);
chk('17. webhook racing a client verify credits exactly once', 90000, (await walletOf(drivers.d1.token)).balancePaise);

chk('   an unrelated event type is acknowledged, not errored', 200,
  (await (async () => {
    const b = JSON.stringify({ event: 'payment.failed', payload: {} });
    return call('POST', '/payments/webhook/razorpay', { rawBody: b, headers: { 'x-razorpay-signature': sign(b) } });
  })()).status);

/* -------------------------------------------------- CHARGING SETTLEMENT - */
console.log('\n=== CHARGING SESSION SETTLEMENT ===');
const sim = new Sim(ch.charger.ocppId, ch.authToken);
await sim.connect();
sim.startHeartbeat();
await sim.send('BootNotification', { chargePointVendor: 'T', chargePointModel: 'M10' });
await sim.send('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' });
await sleep(400);

async function charge(token, meterStart, meterStop) {
  const req = call('POST', '/charging/sessions', { token, body: { connectorId: conn.id } });
  const cmd = await sim.waitForCall('RemoteStartTransaction');
  sim.reply(cmd.uid, { status: 'Accepted' });
  const res = await req;
  const id = res.body.data.session.id;
  await sim.send('Authorize', { idTag: cmd.payload.idTag });
  const st = await sim.send('StartTransaction', { connectorId: 1, idTag: cmd.payload.idTag, meterStart, timestamp: new Date().toISOString() });
  await sim.send('StatusNotification', { connectorId: 1, status: 'Charging', errorCode: 'NoError' });
  await sim.send('StopTransaction', { transactionId: st[2].transactionId, meterStop, reason: 'Remote', timestamp: new Date().toISOString() });
  await sim.send('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' });
  await sleep(1200);
  return id;
}

const balanceBefore = (await walletOf(drivers.d1.token)).balancePaise;
const paidSession = await charge(drivers.d1.token, 0, 5000);   // 5 kWh @ ₹12 = ₹60
const done = await sess(paidSession);

chk('18. the session completed', 'completed', done.status);
chk('19. it was priced at ₹60.00', 6000, done.amountPaise);
chk('22. and marked paid', 'paid', done.paymentStatus);
chk('19. the wallet was debited by exactly ₹60', balanceBefore - 6000, (await walletOf(drivers.d1.token)).balancePaise);

const ledger = await must('GET', '/wallet/transactions', { token: drivers.d1.token });
chk('20. a debit ledger row was written', 'session_debit', ledger.items[0].type);
chk('20. it references the session', paidSession, ledger.items[0].chargingSessionId);
chk('20. direction is debit', 'debit', ledger.items[0].direction);

const payments = await must('GET', '/payments', { token: drivers.d1.token });
const sessionPayment = payments.items.find((p) => p.chargingSessionId === paidSession);
chk('21. a PaymentTransaction exists for the session', true, Boolean(sessionPayment));
chk('21. it is internal, not Razorpay', 'internal', sessionPayment?.provider);
chk('22. and paid', 'paid', sessionPayment?.status);

/* ------------------------------------------------- INSUFFICIENT BALANCE - */
console.log('\n=== INSUFFICIENT BALANCE — the honest failure case ===');
// Drain driver 2's wallet to ₹20, then let them charge ₹60 worth.
const o5 = (await must('POST', '/wallet/recharge/order', { token: drivers.d2.token, body: { amount: 20 } })).order;
const p5 = `pay_test${S}05`;
await must('POST', '/wallet/recharge/verify', { token: drivers.d2.token, body: {
  razorpay_order_id: o5.providerOrderId, razorpay_payment_id: p5, razorpay_signature: sign(`${o5.providerOrderId}|${p5}`) } });
chk('   driver 2 has ₹20.00', 2000, (await walletOf(drivers.d2.token)).balancePaise);

const unpaidSession = await charge(drivers.d2.token, 0, 5000);  // ₹60 owed, ₹20 held
await sleep(500);
const short = await sess(unpaidSession);

chk('23. the session still COMPLETED — electricity cannot be un-delivered', 'completed', short.status);
chk('23. it was priced at ₹60.00', 6000, short.amountPaise);
chk('23. but is NOT marked paid', 'unpaid', short.paymentStatus);
chk('24. the wallet was NOT touched', 2000, (await walletOf(drivers.d2.token)).balancePaise);
chk('30. the balance never went negative', true, (await walletOf(drivers.d2.token)).balancePaise >= 0);

const d2Payments = await must('GET', '/payments', { token: drivers.d2.token });
const pendingPayment = d2Payments.items.find((p) => p.chargingSessionId === unpaidSession);
chk('23. the payment is PENDING, not falsely paid', 'pending', pendingPayment?.status);
chk('23. with a reason the driver can act on', true, /insufficient/i.test(pendingPayment?.failureReason ?? ''));

const w2 = await must('GET', '/wallet', { token: drivers.d2.token });
chk('   the wallet reports what is outstanding', 6000, w2.outstandingPaise);

/* ------------------------------------------------ AUTO-SETTLE ON TOP-UP - */
console.log('\n=== TOPPING UP SETTLES THE DEBT AUTOMATICALLY ===');
const o6 = (await must('POST', '/wallet/recharge/order', { token: drivers.d2.token, body: { amount: 100 } })).order;
const p6 = `pay_test${S}06`;
await must('POST', '/wallet/recharge/verify', { token: drivers.d2.token, body: {
  razorpay_order_id: o6.providerOrderId, razorpay_payment_id: p6, razorpay_signature: sign(`${o6.providerOrderId}|${p6}`) } });
await sleep(1500);

const settled = await sess(unpaidSession);
chk('   the outstanding session settled by itself', 'paid', settled.paymentStatus);
chk('   ₹20 + ₹100 - ₹60 = ₹60.00', 6000, (await walletOf(drivers.d2.token)).balancePaise);
chk('   nothing is outstanding now', 0, (await must('GET', '/wallet', { token: drivers.d2.token })).outstandingPaise);

/* ------------------------------------------------ CONCURRENT SETTLEMENT - */
console.log('\n=== CONCURRENT DEBIT — one session cannot be charged twice ===');
const raceSession = await charge(drivers.d1.token, 0, 2500);   // ₹30
const balanceAfterRace = (await walletOf(drivers.d1.token)).balancePaise;
chk('   it settled once', 'paid', (await sess(raceSession)).paymentStatus);

/*
 * The concurrent-settlement race is exercised IN-PROCESS by settlement-race.test.mjs, which
 * calls the compiled settleSession directly rather than through HTTP.
 *
 * Deliberately not via a test-only endpoint: a `/__test__/settle` route would be exactly the
 * kind of surface Module 7's D12 had to delete - something that exists for tests and becomes a
 * way to move money in production.
 *
 * What IS asserted here is the outcome that matters: a settled session stays settled, and the
 * repeated sweeper passes that run every 15s never move it again.
 */
const before = balanceAfterRace;
await sleep(1500);
chk('29. the sweeper does not re-charge a settled session', before, (await walletOf(drivers.d1.token)).balancePaise);
const rows = (await must('GET', '/wallet/transactions', { token: drivers.d1.token, })).items
  .filter((e) => e.chargingSessionId === raceSession);
chk('29. exactly one debit row survives for that session', 1, rows.length);

/* ----------------------------------------------------------- OWNERSHIP -- */
console.log('\n=== OWNERSHIP & COMPANY SCOPING ===');
chk('25. driver 2 cannot see driver 1 payment -> 404', 404,
  (await call('GET', `/payments/${sessionPayment.id}`, { token: drivers.d2.token })).status);
const d2List = await must('GET', '/payments', { token: drivers.d2.token });
chk('25. driver 2 list contains none of driver 1 payments', false,
  d2List.items.some((p) => p.userId === drivers.d1.id));
chk('26. there is no endpoint to pay another driver session', 404,
  (await call('POST', `/charging/sessions/${unpaidSession}/pay`, { token: drivers.d2.token, body: {} })).status);

chk('27. company A staff can see a collection at their station', 200,
  (await call('GET', `/payments/${sessionPayment.id}`, { token: staff.cpoA.token })).status);
chk('27. company B staff cannot -> 403', 403,
  (await call('GET', `/payments/${sessionPayment.id}`, { token: staff.cpoB.token })).status);
const bList = await must('GET', '/payments', { token: staff.cpoB.token });
chk('27. and company B list never leaks company A', false, bList.items.some((p) => p.companyId === A));

/* -------------------------------------------------------------- REFUND -- */
console.log('\n=== REFUND — recharge reversal only ===');
const rechargePayment = (await must('GET', '/payments', { token: drivers.d1.token })).items
  .find((p) => p.purpose === 'wallet_recharge' && p.status === 'paid');
chk('31. a driver cannot refund themselves -> 403', 403,
  (await call('POST', `/payments/${rechargePayment.id}/refund`, { token: drivers.d1.token })).status);
chk('31. a cpo_admin cannot either -> 403', 403,
  (await call('POST', `/payments/${rechargePayment.id}/refund`, { token: staff.cpoA.token })).status);

const beforeRefund = (await walletOf(drivers.d1.token)).balancePaise;
const refunded = await must('POST', `/payments/${rechargePayment.id}/refund`, { token: su });
chk('31. super_admin can reverse a recharge', 'refunded', refunded.payment.status);
chk('31. the wallet was debited by the recharge amount', beforeRefund - rechargePayment.amountPaise,
  (await walletOf(drivers.d1.token)).balancePaise);
chk('32. a duplicate refund is refused -> 409', 409,
  (await call('POST', `/payments/${rechargePayment.id}/refund`, { token: su })).status);
chk('   a session debit cannot be refunded -> 409', 409,
  (await call('POST', `/payments/${sessionPayment.id}/refund`, { token: su })).status);

/* ------------------------------------------------------- RECONCILIATION - */
console.log('\n=== THE LEDGER RECONSTRUCTS THE BALANCE ===');
const allEntries = await must('GET', '/wallet/transactions?limit=100', { token: drivers.d1.token });
const ledgerSum = allEntries.items.reduce((sum, e) => sum + (e.direction === 'credit' ? e.amountPaise : -e.amountPaise), 0);
chk('   summing the ledger equals the stored balance', (await walletOf(drivers.d1.token)).balancePaise, ledgerSum);

sim.close();
await sleep(400);

console.log(`\n=========== MODULE 10: ${pass} passed, ${fail} failed ===========`);
if (fail) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
