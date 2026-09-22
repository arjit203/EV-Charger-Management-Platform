/* MODULE 13 - Analytics & Dashboards.
 *
 * The module is read-only, so the risk is not corruption, it is MISREPORTING. Every check
 * below asserts a NUMBER against fixture data whose correct answer is known in advance,
 * rather than asserting that a request returned 200.
 *
 * Part A  real traffic through the real path (wallet -> OCPP -> settlement), delta-asserted
 * Part B  backdated rows inserted directly, because date anchoring cannot be staged live
 * Part C  validation and RBAC
 * Part D  zero state
 */

import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(new URL('../../backend/', import.meta.url));
const WebSocket = require('ws');
const mongoose = require('mongoose');
require('dotenv').config({ path: fileURLToPath(new URL('../../backend/.env', import.meta.url)) });

const BASE = process.env.BASE || 'http://localhost:5000/api/v1';
const WS_BASE = process.env.WS_BASE || 'ws://localhost:5000/ocpp';
const SECRET = process.env.RZP_SECRET || 'stub_secret_not_for_production';
const S = String(Date.now()).slice(-6);
const PW = 'Analytics13Pass';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const fails = [];

function chk(label, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    fails.push(label);
    console.log(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
  }
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

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

/* --------------------------------------------------------------- simulator */

class Sim {
  constructor(o, t) { this.ocppId = o; this.token = t; this.pending = new Map(); this.inbound = []; this.beat = null; }
  connect() {
    const creds = Buffer.from(`${this.ocppId}:${this.token}`).toString('base64');
    return new Promise((res) => {
      const s = new WebSocket(`${WS_BASE}/${encodeURIComponent(this.ocppId)}`, { headers: { Authorization: `Basic ${creds}` } });
      this.socket = s;
      s.on('open', () => res(true));
      s.on('error', () => res(false));
      s.on('message', (d) => {
        const f = JSON.parse(d.toString());
        if (f[0] === 3 || f[0] === 4) { const p = this.pending.get(f[1]); if (p) { this.pending.delete(f[1]); p(f); } }
        else if (f[0] === 2) this.inbound.push({ uid: f[1], action: f[2], payload: f[3] });
      });
    });
  }
  send(a, p = {}) {
    const uid = `m13-${Math.random().toString(36).slice(2)}`;
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

/* ------------------------------------------------------------------- setup */

console.log('\n================ MODULE 13 - ANALYTICS ================');

const su = (await must('POST', '/auth/login', { body: { email: 'admin@evcms.local', password: 'Admin@12345' } })).token;

const overview = (token, qs = '') => must('GET', `/analytics/overview${qs}`, { token });

/* Company A - carries the live traffic. */
const coA = (await must('POST', '/companies', { token: su, body: { name: `M13 Alpha ${S}`, type: 'CPO' } })).company;
const tA = (await must('POST', '/tariffs', { token: su, body: { name: 'Standard DC', pricePerKwh: 12, companyId: coA.id } })).tariff;
await must('PATCH', `/tariffs/${tA.id}/status`, { token: su, body: { status: 'active' } });

const stA = (await must('POST', '/stations', { token: su, body: { name: `M13 Alpha Station ${S}`, stationCode: `M13A-${S}`,
  address: '1 Analytics Way', city: 'Delhi', state: 'Delhi', country: 'India', latitude: 28.6, longitude: 77.2, companyId: coA.id } })).station;
const chA = await must('POST', '/chargers', { token: su, body: { stationId: stA.id, name: 'CH-A1',
  chargerCode: `M13AC-${S}`, ocppId: `M13A-${S}`, manufacturer: 'Delta', model: 'Sim', chargerType: 'DC', powerKw: 60 } });
const cnA = (await must('POST', `/chargers/${chA.charger.id}/connectors`, { token: su,
  body: { connectorNumber: 1, connectorType: 'CCS2', powerKw: 60 } })).connector;

const cpoAEmail = `cpo.a13.${S}@test.local`;
await must('POST', '/users', { token: su, body: { name: 'M13 CPO A', email: cpoAEmail, password: PW, role: 'cpo_admin', companyId: coA.id } });
const cpoA = (await must('POST', '/auth/login', { body: { email: cpoAEmail, password: PW } })).token;

const opAEmail = `ops.a13.${S}@test.local`;
await must('POST', '/users', { token: su, body: { name: 'M13 OPS A', email: opAEmail, password: PW, role: 'operator', companyId: coA.id } });
const opA = (await must('POST', '/auth/login', { body: { email: opAEmail, password: PW } })).token;

/* Company B - the rival. Never touched by any traffic; used for isolation. */
const coB = (await must('POST', '/companies', { token: su, body: { name: `M13 Beta ${S}`, type: 'CPO' } })).company;
const tB = (await must('POST', '/tariffs', { token: su, body: { name: 'Standard DC', pricePerKwh: 14, companyId: coB.id } })).tariff;
await must('PATCH', `/tariffs/${tB.id}/status`, { token: su, body: { status: 'active' } });
const cpoBEmail = `cpo.b13.${S}@test.local`;
await must('POST', '/users', { token: su, body: { name: 'M13 CPO B', email: cpoBEmail, password: PW, role: 'cpo_admin', companyId: coB.id } });
const cpoB = (await must('POST', '/auth/login', { body: { email: cpoBEmail, password: PW } })).token;

const dAEmail = `driver.a13.${S}@test.local`;
await must('POST', '/auth/register', { body: { name: 'M13 Driver A', email: dAEmail, password: PW } });
const drvA = (await must('POST', '/auth/login', { body: { email: dAEmail, password: PW } })).token;

const dBEmail = `driver.b13.${S}@test.local`;
await must('POST', '/auth/register', { body: { name: 'M13 Driver B', email: dBEmail, password: PW } });
const drvB = (await must('POST', '/auth/login', { body: { email: dBEmail, password: PW } })).token;

const A = `?companyId=${coA.id}`;

/* =========================================================================
 * PART D (run first, while company A is genuinely empty) - ZERO STATE
 * ========================================================================= */

section('D. ZERO STATE - a company with no data reads 0, never null');

{
  const o = await overview(su, A);

  chk('zero state: sessions.total is 0', 0, o.sessions.total);
  chk('zero state: energyWh is 0 (a number, not null)', 0, o.sessions.energyWh);
  chk('zero state: energyKwh is 0', 0, o.sessions.energyKwh);
  chk('zero state: revenuePaise is 0', 0, o.revenue.revenuePaise);
  chk('zero state: unpaidPaise is 0', 0, o.revenue.unpaidPaise);
  chk('zero state: complaints.total is 0', 0, o.complaints.total);
  chk('zero state: openNow is 0', 0, o.complaints.openNow);

  /* The failure this guards: $group over an empty match returns NO documents, so a
   * response built from the raw result is missing keys and the UI renders undefined. */
  chk('zero state: every session status key present', ['initiating', 'active', 'stopping', 'completed', 'failed'],
    Object.keys(o.sessions.byStatus));
  chk('zero state: all session status counts are 0', true,
    Object.values(o.sessions.byStatus).every((v) => v === 0));
  chk('zero state: every charger status key present', ['available', 'unavailable', 'faulted', 'maintenance'],
    Object.keys(o.fleet.chargersByStatus));
  chk('zero state: every connector status key present',
    ['available', 'occupied', 'faulted', 'unavailable', 'preparing', 'charging', 'finishing'],
    Object.keys(o.fleet.connectorsByStatus));
  chk('zero state: every complaint status key present', ['open', 'in_progress', 'resolved', 'closed'],
    Object.keys(o.complaints.byStatus));
  chk('zero state: no value anywhere in the payload is null', false,
    JSON.stringify(o).includes(':null'));

  /* The fleet IS populated - it is a snapshot, not a windowed metric. */
  chk('fleet snapshot counts the station that exists', 1, o.fleet.stations);
  chk('fleet snapshot counts the charger that exists', 1, o.fleet.chargers);
  chk('fleet snapshot counts the connector that exists', 1, o.fleet.connectors);
  chk('the charger is offline before the simulator connects', 1, o.fleet.chargersOffline);
  chk('no sessions are active yet', 0, o.fleet.activeSessions);

  const series = await must('GET', `/analytics/sessions${A}`, { token: su });
  chk('zero state: the daily series is still fully populated', 30, series.points.length);
  chk('zero state: every day is zero, not missing', true,
    series.points.every((p) => p.sessions === 0 && p.energyWh === 0));

  const stations = await must('GET', `/analytics/stations${A}`, { token: su });
  chk('zero state: the station leaderboard is an empty array', [], stations.stations);
}

/* =========================================================================
 * PART A - REAL TRAFFIC. The authoritative-source decisions, in rupees.
 * ========================================================================= */

section('A1. REVENUE EXCLUDES WALLET RECHARGES  (D1)');

/* Baseline taken UNSCOPED, as super_admin. This is the only caller for whom the
 * `purpose: session_debit` filter can possibly matter - a company-scoped caller never sees
 * recharges anyway, because a recharge carries companyId: null. Deltas rather than absolute
 * values, so other data in the database cannot affect the result. */
const platformBefore = (await overview(su)).revenue.revenuePaise;

const orderA = (await must('POST', '/wallet/recharge/order', { token: drvA, body: { amount: 500 } })).order;
const payAId = `pay_m13a${S}`;
await must('POST', '/wallet/recharge/verify', { token: drvA, body: { razorpay_order_id: orderA.providerOrderId,
  razorpay_payment_id: payAId, razorpay_signature: sign(`${orderA.providerOrderId}|${payAId}`) } });

const walletA = await must('GET', '/wallet', { token: drvA });
chk('the Rs500 recharge really did land in the wallet', 50000, walletA.wallet.balancePaise);

const platformAfterRecharge = (await overview(su)).revenue.revenuePaise;
chk('PLATFORM revenue is UNCHANGED by a Rs500 recharge (delta = 0 paise)',
  0, platformAfterRecharge - platformBefore);
chk('company A revenue is still 0 after the recharge', 0, (await overview(su, A)).revenue.revenuePaise);

section('A2. ENERGY IS THE SESSION FIGURE, NOT A SUM OF METER READINGS  (D2)');

const sim = new Sim(chA.charger.ocppId, chA.authToken);
await sim.connect();
sim.startHeartbeat();
await sim.send('BootNotification', { chargePointVendor: 'Test', chargePointModel: 'M13' });
await sim.send('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' });
await sleep(400);

async function runSession(driverToken, meterStops) {
  const req = call('POST', '/charging/sessions', { token: driverToken, body: { connectorId: cnA.id } });
  const cmd = await sim.waitForCall('RemoteStartTransaction');
  sim.reply(cmd.uid, { status: 'Accepted' });
  const sessionId = (await req).body.data.session.id;
  await sim.send('Authorize', { idTag: cmd.payload.idTag });
  const st = await sim.send('StartTransaction', { connectorId: 1, idTag: cmd.payload.idTag, meterStart: 0, timestamp: new Date().toISOString() });
  const txn = st[2].transactionId;
  await sim.send('StatusNotification', { connectorId: 1, status: 'Charging', errorCode: 'NoError' });

  for (const wh of meterStops) {
    await sim.send('MeterValues', { connectorId: 1, transactionId: txn, energyWh: wh, timestamp: new Date().toISOString() });
  }
  await sleep(250);

  const final = meterStops[meterStops.length - 1];
  await sim.send('StopTransaction', { transactionId: txn, meterStop: final, reason: 'Remote', timestamp: new Date().toISOString() });
  await sim.send('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError' });
  await sleep(1600);
  return sessionId;
}

/* Cumulative meter: 0 -> 1666 -> 3333 -> 5000 Wh. Delivered = 5000 Wh = 5 kWh.
 * Summing the READINGS would give 1666 + 3333 + 5000 = 9999 Wh, which is the bug D2 names. */
const sessionA1 = await runSession(drvA, [1666, 3333, 5000]);

const readings = await must('GET', `/charging/sessions/${sessionA1}/readings`, { token: drvA });
const readingSum = readings.readings.reduce((acc, r) => acc + r.energyWh, 0);

{
  const o = await overview(su, A);
  chk('analytics reports 5000 Wh delivered', 5000, o.sessions.energyWh);
  chk('analytics reports 5.000 kWh delivered', 5, o.sessions.energyKwh);
  chk('the naive sum of cumulative meter readings would have been higher', true, readingSum > 5000);
  chk('analytics does NOT report the sum of meter readings', false, o.sessions.energyWh === readingSum);
  chk('one session counted', 1, o.sessions.total);
  chk('and it is counted as completed', 1, o.sessions.byStatus.completed);
}

section('A3. A PAID SESSION IS REVENUE - AND ONLY THE SESSION, NOT THE TOP-UP  (D1)');

/* 5000 Wh at Rs12/kWh = 6000 paise = Rs60.00 */
{
  const o = await overview(su, A);
  chk('company A revenue is exactly Rs60.00 (6000 paise)', 6000, o.revenue.revenuePaise);
  chk('company A revenue in rupees is 60', 60, o.revenue.revenueRupees);
  chk('exactly one payment made it up that total', 1, o.revenue.payments);
  chk('nothing is outstanding', 0, o.revenue.unpaidPaise);

  const platformNow = (await overview(su)).revenue.revenuePaise;
  chk('PLATFORM revenue moved by exactly 6000 paise across a Rs500 top-up AND a Rs60 charge',
    6000, platformNow - platformBefore);
}

section('A4. DELIVERED BUT UNCOLLECTED IS ENERGY, NOT REVENUE');

/* Driver B has never topped up. The charge is delivered anyway - Module 10's design. */
const sessionB1 = await runSession(drvB, [1666, 3333, 5000]);

{
  const o = await overview(su, A);
  chk('the unfunded charge still counts as a session', 2, o.sessions.total);
  chk('the electricity it delivered IS counted - 10000 Wh total', 10000, o.sessions.energyWh);
  chk('but revenue is UNCHANGED at Rs60.00', 6000, o.revenue.revenuePaise);
  chk('the shortfall is reported as outstanding: Rs60.00', 6000, o.revenue.unpaidPaise);
  chk('one session is outstanding', 1, o.revenue.unpaidSessions);
}

section('A5. THE MONEY APPEARS WHEN IT IS ACTUALLY COLLECTED');

const orderB = (await must('POST', '/wallet/recharge/order', { token: drvB, body: { amount: 500 } })).order;
const payBId = `pay_m13b${S}`;
await must('POST', '/wallet/recharge/verify', { token: drvB, body: { razorpay_order_id: orderB.providerOrderId,
  razorpay_payment_id: payBId, razorpay_signature: sign(`${orderB.providerOrderId}|${payBId}`) } });

/* The settlement sweeper runs every 15s; wait past one full cycle. */
let settled = false;
for (let i = 0; i < 24 && !settled; i += 1) {
  await sleep(1000);
  settled = (await must('GET', `/charging/sessions/${sessionB1}`, { token: drvB })).session.paymentStatus === 'paid';
}
chk('the sweeper settled the outstanding session once funds arrived', true, settled);

{
  const o = await overview(su, A);
  chk('revenue is now Rs120.00 - the second charge, not the second top-up', 12000, o.revenue.revenuePaise);
  chk('two payments', 2, o.revenue.payments);
  chk('nothing outstanding any more', 0, o.revenue.unpaidPaise);
  chk('energy is unchanged by the collection', 10000, o.sessions.energyWh);

  const platformNow = (await overview(su)).revenue.revenuePaise;
  chk('PLATFORM delta across TWO Rs500 top-ups and TWO Rs60 charges is 12000 paise, not 112000',
    12000, platformNow - platformBefore);
}

section('A6. SELF-CONSISTENCY - the totals agree with the breakdowns');

{
  const o = await overview(su, A);
  const sessions = await must('GET', `/analytics/sessions${A}`, { token: su });
  const revenue = await must('GET', `/analytics/revenue${A}`, { token: su });
  const stations = await must('GET', `/analytics/stations${A}`, { token: su });

  chk('overview sessions == sum of the daily session series',
    o.sessions.total, sessions.points.reduce((a, p) => a + p.sessions, 0));
  chk('overview energy == sum of the daily energy series',
    o.sessions.energyWh, sessions.points.reduce((a, p) => a + p.energyWh, 0));
  chk('overview revenue == sum of the daily revenue series',
    o.revenue.revenuePaise, revenue.points.reduce((a, p) => a + p.revenuePaise, 0));
  chk('the series endpoint totals match the overview totals',
    o.sessions.total, sessions.totals.total);
  chk('per-station sessions sum to the overview total',
    o.sessions.total, stations.stations.reduce((a, s) => a + s.sessions, 0));
  chk('per-station energy sums to the overview total',
    o.sessions.energyWh, stations.stations.reduce((a, s) => a + s.energyWh, 0));
  chk('per-station revenue sums to the overview total',
    o.revenue.revenuePaise, stations.stations.reduce((a, s) => a + s.revenuePaise, 0));
  chk('the leaderboard names the real station', stA.name, stations.stations[0].name);
}

sim.close();
await sleep(300);

/* =========================================================================
 * PART B - DATE ANCHORING AND BOUNDARIES. Rows written directly, because a
 * backdated `paidAt` cannot be produced by driving the live API.
 * ========================================================================= */

section('B. DATE ANCHORING (D5) AND INCLUSIVE UTC BOUNDARIES (D4)');

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const oid = (v) => new mongoose.Types.ObjectId(v);

/* A fresh company so the fixture numbers are the ONLY numbers in scope. */
const coC = (await must('POST', '/companies', { token: su, body: { name: `M13 Gamma ${S}`, type: 'CPO' } })).company;
const stC = (await must('POST', '/stations', { token: su, body: { name: `M13 Gamma Station ${S}`, stationCode: `M13C-${S}`,
  address: '3 Backdate Road', city: 'Pune', state: 'Maharashtra', country: 'India', latitude: 18.5, longitude: 73.8, companyId: coC.id } })).station;
const cpoCEmail = `cpo.c13.${S}@test.local`;
await must('POST', '/users', { token: su, body: { name: 'M13 CPO C', email: cpoCEmail, password: PW, role: 'cpo_admin', companyId: coC.id } });
const cpoC = (await must('POST', '/auth/login', { body: { email: cpoCEmail, password: PW } })).token;

const C = `?companyId=${coC.id}`;
const me = (await must('GET', '/auth/me', { token: drvA })).user;

let seq = 0;
const baseSession = (startedAt, extra = {}) => ({
  userId: oid(me.id),
  vehicleId: null,
  companyId: oid(coC.id),
  stationId: oid(stC.id),
  chargerId: oid(chA.charger.id),
  connectorId: oid(cnA.id),
  connectorNumber: 1,
  transactionId: null,
  idTag: `M13X${S}${seq += 1}`,
  status: 'completed',
  requestedAt: startedAt,
  startedAt,
  endedAt: startedAt,
  startMeterWh: 0,
  lastMeterWh: 1000,
  endMeterWh: 1000,
  energyConsumedWh: 1000,
  stopReason: 'Remote',
  failureReason: null,
  appliedTariffId: null,
  appliedPricePerKwhPaise: 1200,
  amountPaise: 1200,
  paymentStatus: 'paid',
  createdAt: startedAt,
  updatedAt: startedAt,
  ...extra,
});

const SEP10 = new Date('2026-09-10T12:00:00.000Z');
const SEP12 = new Date('2026-09-12T08:00:00.000Z');
const DAY_START = new Date('2026-09-11T00:00:00.000Z');
const DAY_END = new Date('2026-09-11T23:59:59.999Z');

const split = await db.collection('chargingsessions').insertOne(baseSession(SEP10));
const edgeLow = await db.collection('chargingsessions').insertOne(baseSession(DAY_START));
const edgeHigh = await db.collection('chargingsessions').insertOne(baseSession(DAY_END));

/* The payment for the Sep-10 charge lands on Sep 12 - the driver topped up two days later.
 * This is exactly the gap Module 10 created on purpose. */
await db.collection('paymenttransactions').insertOne({
  userId: oid(me.id),
  walletId: oid(walletA.wallet.id),
  purpose: 'session_debit',
  provider: 'internal',
  chargingSessionId: split.insertedId,
  companyId: oid(coC.id),
  amountPaise: 1200,
  status: 'paid',
  providerOrderId: null,
  providerPaymentId: null,
  attempts: 1,
  failureReason: null,
  paidAt: SEP12,
  createdAt: SEP10,
  updatedAt: SEP12,
});

/* A recharge on the SAME day, deliberately carrying a companyId it would never really have,
 * so that the `purpose` filter is the ONLY thing that can exclude it. If revenue were
 * "every paid payment", this Rs500 would land in company C's Sep-12 revenue. */
await db.collection('paymenttransactions').insertOne({
  userId: oid(me.id),
  walletId: oid(walletA.wallet.id),
  purpose: 'wallet_recharge',
  provider: 'razorpay',
  chargingSessionId: null,
  companyId: oid(coC.id),
  amountPaise: 50000,
  status: 'paid',
  providerOrderId: `order_m13c${S}`,
  providerPaymentId: `pay_m13c${S}`,
  attempts: 1,
  failureReason: null,
  paidAt: SEP12,
  createdAt: SEP12,
  updatedAt: SEP12,
});

{
  const sep10 = await overview(su, `${C}&from=2026-09-10&to=2026-09-10`);
  chk('Sep 10: the charge is counted', 1, sep10.sessions.total);
  chk('Sep 10: its energy is counted', 1000, sep10.sessions.energyWh);
  chk('Sep 10: NO revenue - the money had not moved yet', 0, sep10.revenue.revenuePaise);

  const sep12 = await overview(su, `${C}&from=2026-09-12&to=2026-09-12`);
  chk('Sep 12: NO session - the charge happened two days earlier', 0, sep12.sessions.total);
  chk('Sep 12: no energy', 0, sep12.sessions.energyWh);
  chk('Sep 12: the revenue lands HERE, on paidAt', 1200, sep12.revenue.revenuePaise);

  chk('Sep 12: the Rs500 recharge is NOT revenue, even carrying a companyId',
    1200, sep12.revenue.revenuePaise);
  chk('Sep 12: a naive sum of paid payments would have reported Rs512.00', false,
    sep12.revenue.revenuePaise === 51200);
  chk('Sep 12: exactly one payment counted, not two', 1, sep12.revenue.payments);
}

{
  const day = await overview(su, `${C}&from=2026-09-11&to=2026-09-11`);
  chk('boundary: 00:00:00.000 and 23:59:59.999 are BOTH inside a one-day range', 2, day.sessions.total);
  chk('boundary: both energies counted', 2000, day.sessions.energyWh);

  const sep10 = await overview(su, `${C}&from=2026-09-10&to=2026-09-10`);
  chk('boundary: neither leaks into the previous day', 1, sep10.sessions.total);

  const span = await overview(su, `${C}&from=2026-09-10&to=2026-09-12`);
  chk('an inclusive 3-day span covers all three charges', 3, span.sessions.total);
  chk('and reports 3 days, not 2', 3, span.range.days);
  chk('the window ends at 23:59:59.999Z', '2026-09-12T23:59:59.999Z', span.range.to);
  chk('the window starts at 00:00:00.000Z', '2026-09-10T00:00:00.000Z', span.range.from);

  const series = await must('GET', `/analytics/sessions${C}&from=2026-09-10&to=2026-09-12`, { token: su });
  chk('the daily series has one point per day', 3, series.points.length);
  chk('day 1 carries one session', 1, series.points[0].sessions);
  chk('day 2 carries the two boundary sessions', 2, series.points[1].sessions);
  chk('day 3 carries none', 0, series.points[2].sessions);
  chk('the days are labelled in UTC', ['2026-09-10', '2026-09-11', '2026-09-12'], series.points.map((p) => p.date));

  const rev = await must('GET', `/analytics/revenue${C}&from=2026-09-10&to=2026-09-12`, { token: su });
  chk('revenue appears on day 3, where the money moved', [0, 0, 1200], rev.points.map((p) => p.revenuePaise));
}

/* =========================================================================
 * PART C - VALIDATION, SCOPING AND RBAC
 * ========================================================================= */

section('C1. THE WINDOW MUST BE WELL FORMED');

chk('from after to is rejected', 400,
  (await call('GET', `/analytics/overview?from=2026-09-12&to=2026-09-10`, { token: su })).status);
chk('a non-date is rejected', 400,
  (await call('GET', `/analytics/overview?from=yesterday`, { token: su })).status);
chk('a date that does not exist is rejected', 400,
  (await call('GET', `/analytics/overview?from=2026-02-31`, { token: su })).status);
chk('a full ISO timestamp is rejected - the format cannot promise what it ignores', 400,
  (await call('GET', `/analytics/overview?from=2026-09-10T10:00:00Z`, { token: su })).status);
chk('an unknown query parameter is rejected, not ignored', 400,
  (await call('GET', `/analytics/overview?form=2026-09-10`, { token: su })).status);
chk('an over-long range is rejected', 400,
  (await call('GET', `/analytics/overview?from=2020-01-01&to=2026-09-10`, { token: su })).status);
chk('a bad limit on the leaderboard is rejected', 400,
  (await call('GET', `/analytics/stations?limit=0`, { token: su })).status);
chk('the same day for from and to is legal', 200,
  (await call('GET', `/analytics/overview?from=2026-09-11&to=2026-09-11`, { token: su })).status);

section('C2. COMPANY SCOPING - a rival sees nothing, and cannot ask');

{
  const a = await overview(cpoA, '');
  chk('company A admin sees company A energy', 10000, a.sessions.energyWh);
  chk('company A admin sees company A revenue', 12000, a.revenue.revenuePaise);

  const b = await overview(cpoB, '');
  chk('company B admin sees ZERO sessions', 0, b.sessions.total);
  chk('company B admin sees ZERO energy', 0, b.sessions.energyWh);
  chk('company B admin sees ZERO revenue', 0, b.revenue.revenuePaise);
  chk('company B admin sees none of company A stations', 0, b.fleet.stations);

  /* A dropped field looks like success - Module 9's rule, and it is worse for a read:
   * a cpo_admin who thinks they are viewing a rival would be shown their own numbers. */
  const probe = await call('GET', `/analytics/overview?companyId=${coA.id}`, { token: cpoB });
  chk('company B naming company A is a VISIBLE 422, not a silent rescope', 422, probe.status);
  chk('and the error names the offending field', 'companyId', probe.body.details.field);

  const selfProbe = await call('GET', `/analytics/overview?companyId=${coB.id}`, { token: cpoB });
  chk('even naming their OWN company is rejected - one mechanism, no exceptions', 422, selfProbe.status);

  chk('super_admin naming a company that does not exist gets 404, not a wall of zeros', 404,
    (await call('GET', `/analytics/overview?companyId=${'0'.repeat(24)}`, { token: su })).status);
  chk('a malformed companyId is rejected', 400,
    (await call('GET', `/analytics/overview?companyId=nope`, { token: su })).status);
}

section('C3. RBAC - the operator is narrower than the cpo_admin');

{
  chk('operator CAN read the overview', 200, (await call('GET', '/analytics/overview', { token: opA })).status);
  chk('operator CAN read the session series', 200, (await call('GET', '/analytics/sessions', { token: opA })).status);
  chk('operator CAN read the station leaderboard', 200, (await call('GET', '/analytics/stations', { token: opA })).status);
  chk('operator CANNOT read revenue', 403, (await call('GET', '/analytics/revenue', { token: opA })).status);

  const o = await overview(opA, '');
  chk('the revenue key is ABSENT for an operator, not null', undefined, o.revenue);
  chk('but they see the operational numbers', 10000, o.sessions.energyWh);
  chk('and the fleet', 1, o.fleet.chargers);

  const s = await must('GET', '/analytics/stations', { token: opA });
  chk('the leaderboard carries no revenue column for an operator', undefined, s.stations[0].revenuePaise);
  chk('but still carries energy', 10000, s.stations[0].energyWh);

  chk('a driver cannot read the overview', 403, (await call('GET', '/analytics/overview', { token: drvA })).status);
  chk('a driver cannot read revenue', 403, (await call('GET', '/analytics/revenue', { token: drvA })).status);
  chk('a driver cannot read the session series', 403, (await call('GET', '/analytics/sessions', { token: drvA })).status);
  chk('a driver cannot read the station leaderboard', 403, (await call('GET', '/analytics/stations', { token: drvA })).status);
  chk('an anonymous caller is rejected', 401, (await call('GET', '/analytics/overview')).status);
}

section('C4. COMPLAINTS FEED THE DASHBOARD');

{
  const complaint = (await must('POST', '/complaints', { token: drvA, body: { category: 'session_issue',
    subject: 'The charge stopped early on me',
    description: 'It ended before my car was anywhere near full.',
    chargingSessionId: sessionA1 } })).complaint;

  const o = await overview(su, A);
  chk('the complaint is counted', 1, o.complaints.total);
  chk('and counted as open', 1, o.complaints.byStatus.open);
  chk('openNow reflects it', 1, o.complaints.openNow);

  await must('PATCH', `/complaints/${complaint.id}/status`, { token: cpoA, body: { status: 'in_progress' } });
  await must('PATCH', `/complaints/${complaint.id}/status`, { token: cpoA, body: { status: 'resolved', resolution: 'Cable reseated and retested.' } });

  const after = await overview(su, A);
  chk('after resolution it is no longer open', 0, after.complaints.byStatus.open);
  chk('it is counted as resolved', 1, after.complaints.byStatus.resolved);
  chk('openNow drops to zero', 0, after.complaints.openNow);
  chk('the total is unchanged - it was still filed', 1, after.complaints.total);

  chk('company B sees none of it', 0, (await overview(cpoB, '')).complaints.total);
}

/* ---------------------------------------------------------------- teardown */

await mongoose.disconnect();

console.log(`\n================ MODULE 13: ${passed} passed, ${failed} failed ================`);
if (fails.length) {
  console.log('\nFailures:');
  for (const f of fails) console.log(`  - ${f}`);
}
process.exit(failed === 0 ? 0 : 1);
