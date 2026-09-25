/*
 * Three-process end-to-end check: the REAL simulator binary + the API + Socket.IO observers.
 * Nothing is faked on the charger side — the simulator process speaks OCPP 1.6J to the gateway.
 *
 *   AUDIT_PORT=5000 node tests/e2e/charging-flow.mjs      (default port 5055)
 *
 * Needs the demo data (seed:demo + seed:activity). It ROTATES the OCPP tokens of the Deccan and
 * Kaveri demo chargers, tops up two demo wallets by Rs200 and leaves real sessions behind.
 */
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import crypto from 'crypto';

import { fileURLToPath } from 'url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '');
const require = createRequire(ROOT + '/backend/');
const mongoose = require('mongoose');
const { io: ioClient } = require('socket.io-client');

const PORT = process.env.AUDIT_PORT || '5055';
const HOST = `http://localhost:${PORT}`;
const BASE = `${HOST}/api/v1`;
const WS = `ws://localhost:${PORT}/ocpp`;

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) pass++; else fail++;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, token, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, body: json, data: json?.data };
}
async function login(email, password) {
  const r = await api('POST', '/auth/login', null, { email, password });
  if (r.status !== 200) throw new Error(`login ${email} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.data.token ?? r.data.accessToken;
}
async function waitFor(fn, ms, step = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
}
function socket(token, label) {
  const s = ioClient(HOST, { auth: { token }, transports: ['websocket'], reconnection: false });
  s.events = [];
  s.onAny((event, payload) => s.events.push({ event, payload, at: Date.now() }));
  s.label = label;
  return s;
}
function simulator(ocppId, token, extra = []) {
  const p = spawn(process.execPath, [ROOT + '/simulator/node_modules/tsx/dist/cli.mjs', 'src/index.ts',
    `--charger=${ocppId}`, `--token=${token}`, `--url=${WS}`, '--meterInterval=2', '--reconnectDelay=2', ...extra],
    { cwd: ROOT + '/simulator', stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = '';
  p.stdout.on('data', (d) => (p.log += d));
  p.stderr.on('data', (d) => (p.log += d));
  return p;
}

const env = readFileSync(ROOT + '/backend/.env', 'utf8');
const uri = env.split(/\r?\n/).find((l) => l.startsWith('MONGODB_URI=')).slice(12).trim();
await mongoose.connect(uri);
const db = mongoose.connection.db;
const oid = (s) => new mongoose.Types.ObjectId(String(s));

const procs = [];
const sockets = [];
try {
  /* ------------------------------------------------------------ setup --- */
  const admin = await login('admin@evcms.local', 'Admin@12345');
  const driverTok = await login('ananya@driver.local', 'Driver@12345');
  const driver2Tok = await login('rohit@driver.local', 'Driver@12345');
  const deccanCpo = await login('cpo@deccancharge.local', 'Cpo@12345');
  const kaveriOps = await login('ops@kaveriev.local', 'Ops@12345');
  const livantoCpo = await login('cpo@livanto.local', 'Cpo@12345');
  check('logins: super_admin, 2 drivers, 3 staff of 3 companies', true);

  const deccan = await db.collection('chargers').findOne({ ocppId: 'DCP-PUN-HJ-01-A' });
  const kavA = await db.collection('chargers').findOne({ ocppId: 'KEV-CHE-OMR-01-A' });
  const kavB = await db.collection('chargers').findOne({ ocppId: 'KEV-CHE-OMR-01-B' });
  const tokenFor = async (c) => (await api('POST', `/chargers/${c._id}/token`, admin)).data;
  const tD = await tokenFor(deccan);
  const tokD = tD?.authToken ?? tD?.token;
  check('regenerate OCPP token (super_admin)', !!tokD, tokD ? '' : JSON.stringify(tD));

  const conD = await db.collection('connectors').findOne({ chargerId: deccan._id, connectorNumber: 1 });
  const tariffD = await db.collection('tariffs').findOne({ companyId: deccan.companyId, status: 'active' });

  /* ------------------------------------------------- realtime observers --- */
  const sDeccan = socket(deccanCpo, 'deccan-cpo'); sockets.push(sDeccan);
  const sLivanto = socket(livantoCpo, 'livanto-cpo'); sockets.push(sLivanto);
  const sDriver = socket(driverTok, 'driver'); sockets.push(sDriver);
  const sAdmin = socket(admin, 'admin'); sockets.push(sAdmin);
  const connected = await waitFor(() => sockets.every((s) => s.connected), 8000);
  check('Socket.IO: 4 authenticated sockets connect', !!connected);
  const bad = ioClient(HOST, { auth: { token: 'garbage' }, transports: ['websocket'], reconnection: false });
  const badErr = await new Promise((r) => { bad.on('connect_error', (e) => r(e.message)); bad.on('connect', () => r(null)); setTimeout(() => r('timeout'), 5000); });
  check('Socket.IO: bad token rejected at handshake', !!badErr && badErr !== 'timeout', badErr);
  bad.close();

  /* ------------------------------------------------------ connect charger --- */
  const simD = simulator('DCP-PUN-HJ-01-A', tokD); procs.push(simD);
  const online = await waitFor(async () => (await db.collection('chargers').findOne({ _id: deccan._id })).isOnline, 15000);
  check('simulator connects, BootNotification accepted, charger isOnline', !!online);
  check('BootNotification/Heartbeat seen in simulator log', /Heartbeat|Boot/i.test(simD.log));
  const conn = sDeccan.events.find((e) => e.event === 'charger:connectivityChanged');
  check('realtime: charger:connectivityChanged reaches owning CPO', !!conn);
  check('isolation: Livanto CPO got NO Deccan events', !sLivanto.events.some((e) => JSON.stringify(e.payload).includes(String(deccan._id))));
  check('platform: super_admin sees the event', sAdmin.events.some((e) => e.event === 'charger:connectivityChanged'));

  /* ---------------------------------------------------- connector lookup --- */
  const look = await api('GET', `/charging/connectors/${conD._id}`, driverTok);
  check('connector lookup: valid id -> 200', look.status === 200, `status=${look.data?.connector?.status ?? look.data?.status}`);
  const lookBad = await api('GET', `/charging/connectors/${new mongoose.Types.ObjectId()}`, driverTok);
  check('connector lookup: unknown id -> 404', lookBad.status === 404, String(lookBad.status));
  const lookMal = await api('GET', `/charging/connectors/not-an-id`, driverTok);
  check('connector lookup: malformed id -> 400/422', [400, 422].includes(lookMal.status), String(lookMal.status));

  /* ------------------------------------------------------------ top-up --- */
  const secret = (env.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('RAZORPAY_KEY_SECRET=')) || '').slice(20).trim() || 'stub_secret_not_for_production';
  async function topUp(tok, rupees) {
    const o = await api('POST', '/wallet/recharge/order', tok, { amount: rupees });
    const order = o.data?.order;
    const payId = 'pay_audit' + Date.now() + Math.floor(Math.random() * 1000);
    const sig = crypto.createHmac('sha256', secret).update(`${order.providerOrderId}|${payId}`).digest('hex');
    const body = { razorpay_order_id: order.providerOrderId, razorpay_payment_id: payId, razorpay_signature: sig };
    const v1 = await api('POST', '/wallet/recharge/verify', tok, body);
    const v2 = await api('POST', '/wallet/recharge/verify', tok, body);
    return { o, v1, v2 };
  }
  const w0 = (await api('GET', '/wallet', driverTok)).data;
  const b0 = w0?.wallet?.balancePaise ?? w0?.balancePaise;
  const t = await topUp(driverTok, 200);
  check('top-up ₹200: order 201 + verify 200', t.o.status === 201 && t.v1.status === 200, `${t.o.status}/${t.v1.status} ${t.v1.body?.message ?? ''}`);
  const w1 = (await api('GET', '/wallet', driverTok)).data;
  const b1 = w1?.wallet?.balancePaise ?? w1?.balancePaise;
  check('replayed verify is idempotent (no 5xx)', t.v2.status < 500, `replay=${t.v2.status} delta=${b1 - b0}`);
  await topUp(driver2Tok, 200);

  /* -------------------------------------------------------- start charge --- */
  const walletBefore = (await api('GET', '/wallet', driverTok)).data;
  const balBefore = walletBefore?.wallet?.balancePaise ?? walletBefore?.balancePaise;
  check('wallet readable before charge', Number.isFinite(balBefore), `balance=${balBefore}`);

  const start = await api('POST', '/charging/sessions', driverTok, { connectorId: String(conD._id) });
  const session = start.data?.session ?? start.data;
  check('start charging -> 202 Accepted (charger confirms async)', start.status === 202, `${start.status} ${start.status !== 202 ? JSON.stringify(start.body) : session.status}`);
  const sid = session?.id ?? session?._id;
  const dup = await api('POST', '/charging/sessions', driverTok, { connectorId: String(conD._id) });
  check('duplicate start refused (409)', dup.status === 409, String(dup.status));
  const other = await api('POST', '/charging/sessions', driver2Tok, { connectorId: String(conD._id) });
  check('second driver on occupied connector refused', other.status === 409, String(other.status));

  const active = await waitFor(async () => (await db.collection('chargingsessions').findOne({ _id: oid(sid) }))?.status === 'active', 20000);
  check('RemoteStart -> simulator Authorize+StartTransaction -> session active', !!active);
  const dbS = await db.collection('chargingsessions').findOne({ _id: oid(sid) });
  check('session has OCPP transactionId', dbS.transactionId != null, `tx=${dbS.transactionId}`);
  check('tariff snapshotted from charger company', dbS.appliedPricePerKwhPaise === tariffD.pricePerKwhPaise, `${dbS.appliedPricePerKwhPaise} vs ${tariffD.pricePerKwhPaise}`);
  const conAfterStart = await db.collection('connectors').findOne({ _id: conD._id });
  check('connector status -> charging', ['charging', 'Charging'].includes(conAfterStart.status), conAfterStart.status);
  check('realtime: driver got session:statusChanged active', sDriver.events.some((e) => e.event === 'session:statusChanged' && e.payload?.session?.status === 'active'));
  check('realtime: CPO got connector:statusChanged', sDeccan.events.some((e) => e.event === 'connector:statusChanged'));

  await sleep(9000);
  const readings = await db.collection('meterreadings').find({ sessionId: oid(sid) }).sort({ meterTimestamp: 1 }).toArray();
  check('MeterValues stored (>=3 in 9s at 2s tick)', readings.length >= 3, `n=${readings.length}`);
  const mono = readings.every((r, i) => i === 0 || r.energyWh >= readings[i - 1].energyWh);
  check('meter readings monotonic', mono);
  const meterEvents = sDriver.events.filter((e) => e.event === 'session:meterUpdate').length;
  check('realtime: driver receives session:meterUpdate live', meterEvents >= 2, `n=${meterEvents}`);
  check('isolation: Livanto CPO got no meter updates', !sLivanto.events.some((e) => e.event === 'session:meterUpdate'));

  /* ---------------------------------------------------------- RBAC on stop --- */
  const stopByOther = await api('POST', `/charging/sessions/${sid}/stop`, driver2Tok, {});
  check('other driver cannot stop my session', [403, 404].includes(stopByOther.status), String(stopByOther.status));
  const stopByLivanto = await api('POST', `/charging/sessions/${sid}/stop`, livantoCpo, {});
  check('other company CPO cannot stop it', [403, 404].includes(stopByLivanto.status), String(stopByLivanto.status));
  const readByKaveri = await api('GET', `/charging/sessions/${sid}`, kaveriOps);
  check('other company operator cannot read it', [403, 404].includes(readByKaveri.status), String(readByKaveri.status));

  /* ---------------------------------------------------------------- stop --- */
  const stop = await api('POST', `/charging/sessions/${sid}/stop`, driverTok, {});
  check('driver stop -> 200/202', [200, 202].includes(stop.status), `${stop.status} ${JSON.stringify(stop.body).slice(0, 160)}`);
  const stop2 = await api('POST', `/charging/sessions/${sid}/stop`, driverTok, {});
  check('second stop is harmless (no 5xx)', stop2.status < 500, String(stop2.status));
  const done = await waitFor(async () => {
    const s = await db.collection('chargingsessions').findOne({ _id: oid(sid) });
    return s?.status === 'completed' && s.paymentStatus === 'paid' ? s : null;
  }, 25000);
  check('RemoteStop -> StopTransaction -> session completed & settled', !!done, done ? `${done.status}/${done.paymentStatus}` : 'timeout');
  if (done) {
    const expected = Math.round((done.energyConsumedWh * done.appliedPricePerKwhPaise) / 1000);
    check('amount = round(Wh × paise/kWh ÷ 1000)', done.amountPaise === expected, `${done.energyConsumedWh}Wh × ${done.appliedPricePerKwhPaise} -> ${done.amountPaise} (expected ${expected})`);
    const lastR = await db.collection('meterreadings').find({ sessionId: oid(sid) }).sort({ meterTimestamp: -1 }).limit(1).next();
    check('energy = meterStop - meterStart', Math.abs(done.energyConsumedWh - ((done.endMeterWh ?? 0) - (done.startMeterWh ?? 0))) < 0.001, `${done.startMeterWh}->${done.endMeterWh} = ${done.energyConsumedWh}`);
    const wtx = await db.collection('wallettransactions').find({ chargingSessionId: oid(sid) }).toArray();
    check('exactly one wallet debit for the session', wtx.length === 1, `n=${wtx.length}`);
    if (wtx[0]) {
      check('debit amount equals session amount', wtx[0].amountPaise === done.amountPaise, `${wtx[0].amountPaise} vs ${done.amountPaise}`);
      check('ledger before-after = amount', wtx[0].balanceBeforePaise - wtx[0].balanceAfterPaise === done.amountPaise);
    }
    const ptx = await db.collection('paymenttransactions').find({ chargingSessionId: oid(sid) }).toArray();
    check('payment record(s) for session', ptx.length >= 1 && ptx.filter((p) => p.status === 'success' || p.status === 'captured' || p.status === 'paid').length <= 1, `n=${ptx.length} statuses=${ptx.map((p) => p.status).join(',')}`);
    const walletAfter = (await api('GET', '/wallet', driverTok)).data;
    const balAfter = walletAfter?.wallet?.balancePaise ?? walletAfter?.balancePaise;
    check('wallet API balance = before - amount', balAfter === balBefore - done.amountPaise, `${balBefore} -> ${balAfter} (−${done.amountPaise})`);
    check('wallet never negative', balAfter >= 0);
    await sleep(2500);
    const conEnd = await db.collection('connectors').findOne({ _id: conD._id });
    check('connector back to available', conEnd.status === 'available', conEnd.status);
    const hist = await api('GET', '/charging/sessions?limit=5', driverTok);
    check('driver history shows the completed session', JSON.stringify(hist.data).includes(sid));
    const cpoList = await api('GET', '/charging/sessions?limit=5', deccanCpo);
    check('CPO session list shows it', JSON.stringify(cpoList.data).includes(sid));
    const livList = await api('GET', '/charging/sessions?limit=100', livantoCpo);
    check('other CPO session list does NOT show it', !JSON.stringify(livList.data).includes(sid));
    const ov = await api('GET', '/analytics/overview', deccanCpo);
    check('CPO analytics overview responds', ov.status === 200, JSON.stringify(ov.data).slice(0, 200));
    const notes = await api('GET', '/notifications?limit=10', driverTok);
    const types = (notes.data?.items ?? []).filter((n) => n.referenceId === sid).map((n) => n.type);
    check('driver notified: charging completed + payment', types.includes('charging_completed') && types.some((t) => t.startsWith('payment')), types.join(','));
  }

  /* ------------------------------------------------ disconnect & reconnect --- */
  simD.kill();
  const off = await waitFor(async () => !(await db.collection('chargers').findOne({ _id: deccan._id })).isOnline, 15000);
  check('simulator killed -> charger marked offline', !!off);
  check('realtime: offline pushed to CPO', sDeccan.events.filter((e) => e.event === 'charger:connectivityChanged').some((e) => e.payload?.isOnline === false));
  const offStart = await api('POST', '/charging/sessions', driverTok, { connectorId: String(conD._id) });
  check('start on OFFLINE charger refused', offStart.status >= 400 && offStart.status < 500, `${offStart.status} ${offStart.body?.message}`);
  const simD2 = simulator('DCP-PUN-HJ-01-A', tokD); procs.push(simD2);
  const back = await waitFor(async () => (await db.collection('chargers').findOne({ _id: deccan._id })).isOnline, 15000);
  check('charger reconnects (new process) -> online', !!back);
  const wrong = simulator('DCP-PUN-HJ-01-A', 'wrong-token'); procs.push(wrong);
  await sleep(4000);
  check('wrong OCPP token rejected (charger stays with the good connection)', /401|reject|Unauthorized|close/i.test(wrong.log), wrong.log.split('\n').slice(-3).join(' | ').slice(0, 160));
  wrong.kill();

  /* ------------------------------------------------- two chargers at once --- */
  const tA = await tokenFor(kavA); const tB = await tokenFor(kavB);
  const simA = simulator('KEV-CHE-OMR-01-A', tA.authToken ?? tA.token); procs.push(simA);
  const simB = simulator('KEV-CHE-OMR-01-B', tB.authToken ?? tB.token); procs.push(simB);
  const both = await waitFor(async () => {
    const [a, b] = await Promise.all([db.collection('chargers').findOne({ _id: kavA._id }), db.collection('chargers').findOne({ _id: kavB._id })]);
    return a.isOnline && b.isOnline;
  }, 15000);
  check('two simulators online simultaneously', !!both);
  const cA = await db.collection('connectors').findOne({ chargerId: kavA._id });
  const cB = await db.collection('connectors').findOne({ chargerId: kavB._id });
  const sA = await api('POST', '/charging/sessions', driverTok, { connectorId: String(cA._id) });
  const sB = await api('POST', '/charging/sessions', driver2Tok, { connectorId: String(cB._id) });
  check('two drivers start on two chargers', sA.status === 202 && sB.status === 202, `${sA.status}/${sB.status} ${sA.body?.message ?? ''} ${sB.body?.message ?? ''}`);
  const idA = (sA.data?.session ?? sA.data)?.id, idB = (sB.data?.session ?? sB.data)?.id;
  const bothActive = await waitFor(async () => {
    const r = await db.collection('chargingsessions').find({ _id: { $in: [oid(idA), oid(idB)] } }).toArray();
    return r.length === 2 && r.every((s) => s.status === 'active');
  }, 20000);
  check('both sessions active', !!bothActive);
  await sleep(6000);
  const stopA = await api('POST', `/charging/sessions/${idA}/stop`, kaveriOps, { reason: 'audit: operator stop' });
  check('operator of owning company can stop a session', [200, 202].includes(stopA.status), `${stopA.status} ${stopA.body?.message ?? ''}`);
  const aDone = await waitFor(async () => (await db.collection('chargingsessions').findOne({ _id: oid(idA) }))?.status === 'completed', 20000);
  const bNow = await db.collection('chargingsessions').findOne({ _id: oid(idB) });
  check('stopping A leaves B charging (no interference)', !!aDone && bNow.status === 'active', `A done=${!!aDone} B=${bNow.status}`);
  const rA = await db.collection('meterreadings').countDocuments({ sessionId: oid(idA) });
  const rB = await db.collection('meterreadings').countDocuments({ sessionId: oid(idB) });
  check('each session has its own readings', rA > 0 && rB > 0, `A=${rA} B=${rB}`);
  const stopB = await api('POST', `/charging/sessions/${idB}/stop`, driver2Tok, {});
  const bDone = await waitFor(async () => {
    const s = await db.collection('chargingsessions').findOne({ _id: oid(idB) });
    return s?.status === 'completed' && s.paymentStatus === 'paid' ? s : null;
  }, 20000);
  check('B completes and settles', !!bDone && [200, 202].includes(stopB.status), bDone ? bDone.paymentStatus : 'timeout');
  const aS = await db.collection('chargingsessions').findOne({ _id: oid(idA) });
  check('operator-stopped session recorded stoppedByRole=operator', aS.stoppedByRole === 'operator', aS.stoppedByRole);
  for (const id of [idA, idB]) {
    const n = await db.collection('wallettransactions').countDocuments({ chargingSessionId: oid(id) });
    const s = await db.collection('chargingsessions').findOne({ _id: oid(id) });
    check(`session ${id.slice(-4)}: ${s.paymentStatus}, debits=${n}`, (s.amountPaise === 0 && n === 0) || (s.paymentStatus === 'paid' && n === 1) || (s.paymentStatus !== 'paid' && n === 0));
  }
} catch (e) {
  check('script error', false, e.stack);
} finally {
  for (const p of procs) try { p.kill(); } catch {}
  for (const s of sockets) s.close();
  await sleep(1500);
  await mongoose.disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
