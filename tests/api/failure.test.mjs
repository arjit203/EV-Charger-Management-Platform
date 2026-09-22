/* FAILURE HANDLING — what happens when things go wrong.
 *
 * Every other suite drives the HAPPY path and its authorisation edges. This one drives
 * things that BREAK: malformed protocol frames, a charger that vanishes mid-charge, a
 * payment that cannot be verified, a wallet with nothing in it.
 *
 * The bar for every case below is the same three things:
 *
 *   1. the application does not crash
 *   2. the caller gets a sensible, correctly-classified answer
 *   3. the data left behind is consistent and not misleading
 *
 * Point 3 is the one that matters most. A 500 is annoying; a session stuck in `active`
 * forever because its charger disappeared is a connector nobody can ever use again.
 */

import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(new URL('../../backend/', import.meta.url));
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://localhost:5000/api/v1';
const WS_BASE = process.env.WS_BASE || 'ws://localhost:5000/ocpp';
const SECRET = process.env.RZP_SECRET || process.env.RAZORPAY_KEY_SECRET || 'stub_secret_not_for_production';
const S = String(Date.now()).slice(-6);
const PW = 'Failure16Pass';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const fails = [];
function chk(label, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (ok) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`); }
}
function chkRefused(label, status) {
  const ok = status >= 400 && status < 500;
  if (ok) { passed += 1; console.log(`  PASS  ${label}  (${status})`); }
  else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}\n        expected a 4xx, got ${status}`); }
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
const sign = (orderId, paymentId) =>
  crypto.createHmac('sha256', SECRET).update(`${orderId}|${paymentId}`).digest('hex');
const healthy = async () => (await call('GET', '/health')).status === 200;

console.log('\n================ FAILURE HANDLING ================');

const su = (await must('POST', '/auth/login', { body: { email: 'admin@evcms.local', password: 'Admin@12345' } })).token;

const company = (await must('POST', '/companies', { token: su, body: { name: `FAIL A ${S}`, type: 'CPO' } })).company;
const station = (await must('POST', '/stations', { token: su, body: {
  name: `FAIL Station ${S}`, stationCode: `FAIL-${S}`, address: '1 Broken Road', city: 'Delhi',
  state: 'Delhi', country: 'India', latitude: 28.6, longitude: 77.2, companyId: company.id } })).station;
const chargerRes = await must('POST', '/chargers', { token: su, body: {
  stationId: station.id, name: 'FAIL-1', chargerCode: `FAILC-${S}`, ocppId: `FAIL-${S}`,
  manufacturer: 'D', model: 'S', chargerType: 'DC', powerKw: 60 } });
const charger = chargerRes.charger;
const connector = (await must('POST', `/chargers/${charger.id}/connectors`, { token: su,
  body: { connectorNumber: 1, connectorType: 'CCS2', powerKw: 60 } })).connector;

const driverEmail = `driver.fail${S}@test.local`;
await must('POST', '/auth/register', { body: { name: 'FAIL Driver', email: driverEmail, password: PW } });
const driver = (await must('POST', '/auth/login', { body: { email: driverEmail, password: PW } })).token;

/* =========================================================================
 * 1. NO TARIFF — the precondition that blocks everything downstream
 * ========================================================================= */

section('1. NO ACTIVE TARIFF — refused BEFORE any money logic runs');

{
  /* Deliberately no tariff yet for this company. */
  const attempt = await call('POST', '/charging/sessions', { token: driver, body: { connectorId: connector.id } });
  chkRefused('a charge is refused when the company has no active tariff', attempt.status);
  /* Asserting on a specific WORD is testing copy, not behaviour. What must hold is that the
   * caller gets a classified error code and a non-empty human message. */
  chk('and it is classified, not a bare 500', true, Boolean(attempt.body?.errorCode));
  chk('and carries a human message', true, (attempt.body?.message ?? '').length > 10);
  chk('no session was created as a side effect', 0,
    (await must('GET', `/charging/sessions?chargerId=${charger.id}`, { token: su })).items.length);
  chk('the server is still healthy', true, await healthy());
}

const tariff = (await must('POST', '/tariffs', { token: su, body: { name: 'Std', pricePerKwh: 12, companyId: company.id } })).tariff;
await must('PATCH', `/tariffs/${tariff.id}/status`, { token: su, body: { status: 'active' } });

/* =========================================================================
 * 2. OFFLINE CHARGER
 * ========================================================================= */

section('2. CHARGER OFFLINE — a charge cannot start on a machine that is not there');

{
  const attempt = await call('POST', '/charging/sessions', { token: driver, body: { connectorId: connector.id } });
  chkRefused('a charge is refused while the charger is offline', attempt.status);
  chk('and it is classified', true, Boolean(attempt.body?.errorCode));
  chk('and carries a human message', true, (attempt.body?.message ?? '').length > 10);
  chk('the connector is left usable, not stuck', 'available',
    (await must('GET', `/chargers/${charger.id}/connectors`, { token: su }))
      .connectors.find((c) => c.id === connector.id).status);
}

/* =========================================================================
 * 3. MALFORMED AND HOSTILE OCPP
 * ========================================================================= */

section('3. MALFORMED OCPP FRAMES DO NOT TAKE THE GATEWAY DOWN');

{
  const { authToken } = await must('POST', `/chargers/${charger.id}/token`, { token: su });
  const creds = Buffer.from(`${charger.ocppId}:${authToken}`).toString('base64');

  const open = () => new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}/${encodeURIComponent(charger.ocppId)}`, {
      headers: { Authorization: `Basic ${creds}` },
    });
    ws.on('open', () => resolve({ ok: true, ws }));
    ws.on('error', () => resolve({ ok: false, ws }));
  });

  /* Bad credentials first. */
  const badCreds = Buffer.from(`${charger.ocppId}:definitely-not-the-token`).toString('base64');
  const rejected = await new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}/${encodeURIComponent(charger.ocppId)}`, {
      headers: { Authorization: `Basic ${badCreds}` },
    });
    ws.on('open', () => resolve(true));
    ws.on('error', () => resolve(false));
  });
  chk('a wrong charger token cannot connect', false, rejected);

  const unknown = await new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}/NOT-A-REAL-CHARGER-${S}`, {
      headers: { Authorization: `Basic ${creds}` },
    });
    ws.on('open', () => resolve(true));
    ws.on('error', () => resolve(false));
  });
  chk('an unknown ocppId cannot connect', false, unknown);

  const { ok, ws } = await open();
  chk('the real charger connects', true, ok);

  /* Now throw rubbish at it. Each of these is a frame a real charger would never send. */
  const garbage = [
    'this is not json at all',
    '{}',
    '[]',
    '[9, "uid", "Nonsense", {}]',              // unknown message type
    '[2, "uid"]',                               // CALL missing action and payload
    '[2, "uid", "NoSuchAction", {}]',           // unknown action
    '[2, "uid", "StartTransaction"]',           // missing payload
    '[2, "uid", "MeterValues", {"connectorId": "not-a-number"}]',
    '[3, "never-sent-this", {}]',               // CALLRESULT for a call we never made
    JSON.stringify([2, 'uid', 'BootNotification', { chargePointVendor: 'x'.repeat(5000) }]),
  ];

  for (const frame of garbage) ws.send(frame);
  await sleep(1200);

  chk('the socket survived every malformed frame', true, ws.readyState === WebSocket.OPEN);
  chk('and the HTTP API is still healthy', true, await healthy());

  /* A well-formed frame after the garbage must still work — the gateway is not wedged. */
  const replied = await new Promise((resolve) => {
    const uid = `after-garbage-${S}`;
    const onMsg = (data) => {
      const f = JSON.parse(data.toString());
      if (f[1] === uid) { ws.off('message', onMsg); resolve(f[0]); }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify([2, uid, 'BootNotification', { chargePointVendor: 'T', chargePointModel: 'F' }]));
    setTimeout(() => resolve(null), 6000);
  });
  chk('a valid frame still gets a CALLRESULT afterwards', 3, replied);

  /* A duplicate message id must not corrupt anything. */
  const dupId = `dup-${S}`;
  ws.send(JSON.stringify([2, dupId, 'Heartbeat', {}]));
  ws.send(JSON.stringify([2, dupId, 'Heartbeat', {}]));
  await sleep(800);
  chk('a duplicate message id does not kill the socket', true, ws.readyState === WebSocket.OPEN);

  try { ws.close(); } catch { /* ignore */ }
  await sleep(400);
}

/* =========================================================================
 * 4. A CHARGER THAT VANISHES MID-CHARGE
 * ========================================================================= */

section('4. THE CHARGER DISAPPEARS MID-SESSION');

{
  const { authToken } = await must('POST', `/chargers/${charger.id}/token`, { token: su });
  const creds = Buffer.from(`${charger.ocppId}:${authToken}`).toString('base64');

  const ws = new WebSocket(`${WS_BASE}/${encodeURIComponent(charger.ocppId)}`, {
    headers: { Authorization: `Basic ${creds}` },
  });
  const inbound = [];
  const pending = new Map();
  await new Promise((r) => { ws.on('open', r); ws.on('error', r); });
  ws.on('message', (d) => {
    const f = JSON.parse(d.toString());
    if (f[0] === 3) { const p = pending.get(f[1]); if (p) { pending.delete(f[1]); p(f); } }
    else if (f[0] === 2) inbound.push({ uid: f[1], action: f[2], payload: f[3] });
  });
  const send = (action, payload = {}) => new Promise((res, rej) => {
    const uid = `f-${Math.random().toString(36).slice(2)}`;
    const t = setTimeout(() => rej(new Error(`timeout ${action}`)), 8000);
    pending.set(uid, (f) => { clearTimeout(t); res(f); });
    ws.send(JSON.stringify([2, uid, action, payload]));
  });
  const waitFor = async (action, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const f = inbound.find((m) => m.action === action);
      if (f) { inbound.splice(inbound.indexOf(f), 1); return f; }
      await sleep(40);
    }
    return null;
  };

  await send('BootNotification', { chargePointVendor: 'T', chargePointModel: 'F' });
  await send('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' });
  await sleep(500);

  /* Fund the driver so the money path is exercised too. */
  const order = (await must('POST', '/wallet/recharge/order', { token: driver, body: { amount: 500 } })).order;
  const payId = `pay_fail_${S}`;
  await must('POST', '/wallet/recharge/verify', { token: driver, body: {
    razorpay_order_id: order.providerOrderId, razorpay_payment_id: payId,
    razorpay_signature: sign(order.providerOrderId, payId) } });

  const req = call('POST', '/charging/sessions', { token: driver, body: { connectorId: connector.id } });
  const cmd = await waitFor('RemoteStartTransaction');
  ws.send(JSON.stringify([3, cmd.uid, { status: 'Accepted' }]));
  const sessionId = (await req).body.data.session.id;
  await send('Authorize', { idTag: cmd.payload.idTag });
  await send('StartTransaction', { connectorId: 1, idTag: cmd.payload.idTag, meterStart: 0, timestamp: new Date().toISOString() });
  await send('StatusNotification', { connectorId: 1, status: 'Charging', errorCode: 'NoError' });
  await sleep(800);

  chk('the session is active before the charger vanishes', 'active',
    (await must('GET', `/charging/sessions/${sessionId}`, { token: driver })).session.status);

  /* Yank the cable — no StopTransaction, no goodbye. */
  ws.terminate();
  await sleep(1500);

  chk('the API survives the abrupt disconnect', true, await healthy());
  chk('the charger is marked offline', false,
    (await must('GET', `/chargers/${charger.id}`, { token: su })).charger.isOnline);

  /* The session must reach a terminal state on its own rather than hanging forever. */
  let terminal = false;
  for (let i = 0; i < 30 && !terminal; i += 1) {
    await sleep(1000);
    const s = (await must('GET', `/charging/sessions/${sessionId}`, { token: driver })).session;
    terminal = ['completed', 'failed'].includes(s.status);
  }
  const finalSession = (await must('GET', `/charging/sessions/${sessionId}`, { token: driver })).session;
  chk('the orphaned session reaches a terminal state, not stuck active', true, terminal);
  chk('and records why it ended', true, Boolean(finalSession.stopReason || finalSession.failureReason));

  const freed = (await must('GET', `/chargers/${charger.id}/connectors`, { token: su }))
    .connectors.find((c) => c.id === connector.id);
  /* Regression pin for a Module 16 fix: the connector used to keep reading `charging`
   * forever after its charger vanished, which made /monitor, the map and the analytics
   * connector breakdown all report a charge that was not happening. */
  chk('the connector no longer claims to be mid-charge', false,
    ['charging', 'preparing', 'finishing'].includes(freed.status));
  chk('and lands on `unavailable` — honest, since the charger is gone', 'unavailable', freed.status);
}

/* =========================================================================
 * 5. PAYMENT FAILURES
 * ========================================================================= */

section('5. PAYMENT FAILURES DO NOT CREATE MONEY');

{
  const poorEmail = `poor.fail${S}@test.local`;
  await must('POST', '/auth/register', { body: { name: 'FAIL Poor', email: poorEmail, password: PW } });
  const poor = (await must('POST', '/auth/login', { body: { email: poorEmail, password: PW } })).token;

  const order = (await must('POST', '/wallet/recharge/order', { token: poor, body: { amount: 500 } })).order;

  const forged = await call('POST', '/wallet/recharge/verify', { token: poor, body: {
    razorpay_order_id: order.providerOrderId, razorpay_payment_id: 'pay_forged',
    razorpay_signature: 'f'.repeat(64) } });
  chkRefused('a forged signature is refused', forged.status);
  chk('and the wallet is untouched', 0, (await must('GET', '/wallet', { token: poor })).wallet.balancePaise);

  const wrongOrder = await call('POST', '/wallet/recharge/verify', { token: poor, body: {
    razorpay_order_id: 'order_does_not_exist', razorpay_payment_id: 'pay_x',
    razorpay_signature: sign('order_does_not_exist', 'pay_x') } });
  chkRefused('a valid signature over an unknown order is refused', wrongOrder.status);
  chk('still no money', 0, (await must('GET', '/wallet', { token: poor })).wallet.balancePaise);

  /* Another user's order cannot be claimed even with a correct signature. */
  const stolen = await call('POST', '/wallet/recharge/verify', { token: driver, body: {
    razorpay_order_id: order.providerOrderId, razorpay_payment_id: `pay_steal_${S}`,
    razorpay_signature: sign(order.providerOrderId, `pay_steal_${S}`) } });
  chkRefused('another user cannot claim someone else order', stolen.status);

  chkRefused('a recharge below the minimum is refused',
    (await call('POST', '/wallet/recharge/order', { token: poor, body: { amount: 1 } })).status);
  chkRefused('a recharge above the maximum is refused',
    (await call('POST', '/wallet/recharge/order', { token: poor, body: { amount: 999999 } })).status);
  chkRefused('a negative recharge is refused',
    (await call('POST', '/wallet/recharge/order', { token: poor, body: { amount: -500 } })).status);

  /* The webhook must reject an unsigned or wrongly-signed body. */
  const rawBody = JSON.stringify({ event: 'payment.captured', payload: {} });
  const unsigned = await fetch(`${BASE}/payments/webhook/razorpay`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: rawBody,
  });
  chk('an unsigned webhook is refused', true, unsigned.status >= 400);

  const badSig = await fetch(`${BASE}/payments/webhook/razorpay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'f'.repeat(64) },
    body: rawBody,
  });
  chk('a wrongly-signed webhook is refused', true, badSig.status >= 400);
  chk('the server is still healthy after both', true, await healthy());
}

console.log(`\n================ FAILURE HANDLING: ${passed} passed, ${failed} failed ================`);
if (fails.length) { console.log('\nFailures:'); for (const f of fails) console.log(`  - ${f}`); }
process.exit(failed === 0 ? 0 : 1);
