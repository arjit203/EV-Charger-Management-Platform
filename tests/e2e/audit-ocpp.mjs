/*
 * Live-charger audit with REAL simulator processes (default backend :5000):
 *   three chargers at once, occupied-connector lookup, simulator fault keys (connector fault,
 *   charge-point fault, mid-charge fault, clear), arrears refusal on an ONLINE charger, a charge
 *   that ends unpaid and is settled by a later top-up, and the connector state sequence over
 *   Socket.IO (Available -> Preparing -> Charging -> Finishing -> Available).
 *
 * Rotates the OCPP tokens of the three Livanto demo chargers. Creates one @test.local driver
 * (removed by `npm run test:clean`).
 */
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '');
const require = createRequire(ROOT + '/backend/');
const mongoose = require('mongoose');
const { io: ioClient } = require('socket.io-client');

const PORT = process.env.AUDIT_PORT || '5000';
const HOST = `http://localhost:${PORT}`;
const BASE = `${HOST}/api/v1`;
const env = Object.fromEntries(readFileSync(ROOT + '/backend/.env', 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const SECRET = env.RAZORPAY_KEY_SECRET || 'stub_secret_not_for_production';

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d !== '' ? '  — ' + d : ''}`); };
const section = (t) => console.log(`\n=== ${t} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, token, body) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await r.json().catch(() => null);
  return { status: r.status, body: json, data: json?.data };
}
const login = async (e, p) => (await api('POST', '/auth/login', null, { email: e, password: p })).data.token;
async function waitFor(fn, ms, step = 300) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); } return null; }
function sim(ocppId, token) {
  const p = spawn(process.execPath, [ROOT + '/simulator/node_modules/tsx/dist/cli.mjs', ROOT + '/tests/e2e/sim-keys.ts', `--charger=${ocppId}`, `--token=${token}`, `--url=ws://localhost:${PORT}/ocpp`, '--meterInterval=2'], { cwd: ROOT + '/simulator', stdio: ['pipe', 'pipe', 'pipe'] });
  p.log = ''; p.stdout.on('data', (d) => (p.log += d)); p.stderr.on('data', (d) => (p.log += d));
  p.key = (k) => p.stdin.write(k + '\n');
  return p;
}
async function topUp(token, rupees) {
  const order = (await api('POST', '/wallet/recharge/order', token, { amount: rupees })).data.order;
  const payId = 'pay_audit' + Date.now() + Math.floor(Math.random() * 1e4);
  return api('POST', '/wallet/recharge/verify', token, { razorpay_order_id: order.providerOrderId, razorpay_payment_id: payId, razorpay_signature: crypto.createHmac('sha256', SECRET).update(`${order.providerOrderId}|${payId}`).digest('hex') });
}

await mongoose.connect(env.MONGODB_URI);
const db = mongoose.connection.db;
const oid = (s) => new mongoose.Types.ObjectId(String(s));
const procs = [], sockets = [];

try {
  const admin = await login('admin@evcms.local', 'Admin@12345');
  const cpo = await login('cpo@livanto.local', 'Cpo@12345');
  const drivers = [await login('ananya@driver.local', 'Driver@12345'), await login('rohit@driver.local', 'Driver@12345'), await login('priya@driver.local', 'Driver@12345')];
  for (const d of drivers) await topUp(d, 300);
  // A driver with NO session of their own, so a refusal can only be about the connector.
  const bystanderEmail = `audit.bystander.${Date.now()}@test.local`;
  await api('POST', '/auth/register', null, { name: 'Audit Bystander', email: bystanderEmail, password: 'AuditPass#1' });
  const bystander = await login(bystanderEmail, 'AuditPass#1');
  const liv = await db.collection('companies').findOne({ name: 'Livanto Green' });
  const chargers = await db.collection('chargers').find({ companyId: liv._id }).sort({ ocppId: 1 }).toArray();
  const connectorOf = async (c) => db.collection('connectors').findOne({ chargerId: c._id, connectorNumber: 1 });

  const s = ioClient(HOST, { auth: { token: cpo }, transports: ['websocket'], reconnection: false });
  s.events = []; s.onAny((event, payload) => s.events.push({ event, payload })); sockets.push(s);
  await waitFor(() => s.connected, 8000);

  /* ------------------------------------------------------- three at once */
  section('§7 — three simulators, three drivers, at once');
  const sims = [];
  for (const c of chargers) {
    const t = (await api('POST', `/chargers/${c._id}/token`, admin)).data.authToken;
    const p = sim(c.ocppId, t); procs.push(p); sims.push(p);
  }
  const allOnline = await waitFor(async () => (await db.collection('chargers').countDocuments({ companyId: liv._id, isOnline: true })) === 3, 20000);
  check('3 simulators online together', !!allOnline);
  const cons = await Promise.all(chargers.map(connectorOf));
  const started = await Promise.all(cons.map((c, i) => api('POST', '/charging/sessions', drivers[i], { connectorId: String(c._id) })));
  check('3 starts accepted', started.every((r) => r.status === 202), started.map((r) => `${r.status} ${r.body?.message ?? ''}`).join(' | '));
  const ids = started.map((r) => r.data?.session?.id);
  if (ids.some((x) => !x)) throw new Error('a start was refused — nothing below can run');
  const active = await waitFor(async () => (await db.collection('chargingsessions').countDocuments({ _id: { $in: ids.map(oid) }, status: 'active' })) === 3, 20000);
  check('all 3 sessions active', !!active);

  section('§5C — occupied connector');
  const occ = await api('GET', `/charging/connectors/${cons[0]._id}`, bystander);
  const occStatus = occ.data?.connector?.status;
  check('lookup of a connector in use reports it busy', ['charging', 'occupied'].includes(occStatus), `status=${occStatus} payload=${JSON.stringify(occ.data).slice(0, 160)}`);
  const occStart = await api('POST', '/charging/sessions', bystander, { connectorId: String(cons[0]._id) });
  check('start on it by someone else refused FOR BEING IN USE', occStart.status === 409 && !/already have a charge/i.test(occStart.body?.message), `${occStart.status} "${occStart.body?.message}"`);

  await sleep(6000);
  const readings = await Promise.all(ids.map((id) => db.collection('meterreadings').countDocuments({ sessionId: oid(id) })));
  check('each of the 3 sessions has its own readings', readings.every((n) => n >= 2), readings.join('/'));

  section('§7 — fault mid-charge (simulator key f on charger #2)');
  sims[1].key('f');
  const failedMid = await waitFor(async () => { const x = await db.collection('chargingsessions').findOne({ _id: oid(ids[1]) }); return x.status === 'failed' ? x : null; }, 15000);
  check('connector fault mid-charge fails that session', !!failedMid, failedMid ? `${failedMid.stopReason}: ${failedMid.failureReason}` : 'timeout');
  if (failedMid) {
    const settled = await waitFor(async () => (await db.collection('chargingsessions').findOne({ _id: oid(ids[1]) })).paymentStatus === 'paid', 15000);
    const n = await db.collection('wallettransactions').countDocuments({ chargingSessionId: oid(ids[1]) });
    check('energy delivered before the fault is billed once', failedMid.energyConsumedWh > 0 && !!settled && n === 1, `${failedMid.energyConsumedWh}Wh debits=${n}`);
  }
  const other = await db.collection('chargingsessions').find({ _id: { $in: [oid(ids[0]), oid(ids[2])] } }).toArray();
  check('the other two sessions keep charging', other.every((x) => x.status === 'active'), other.map((x) => x.status).join('/'));
  const fc = await db.collection('connectors').findOne({ _id: cons[1]._id });
  check('faulted connector stored as faulted', fc.status === 'faulted', `${fc.status} ${fc.errorCode ?? ''}`);
  const fLook = await api('GET', `/charging/connectors/${cons[1]._id}`, bystander);
  const fStart = await api('POST', '/charging/sessions', bystander, { connectorId: String(cons[1]._id) });
  check('faulted connector: lookup says faulted, start refused for the FAULT (charger online)', fLook.data?.connector?.status === 'faulted' && fStart.status === 409 && !/not currently connected|already have a charge/i.test(fStart.body?.message), `lookup=${fLook.data?.connector?.status} start=${fStart.status} "${fStart.body?.message}"`);
  sims[1].key('c');
  const cleared = await waitFor(async () => (await db.collection('connectors').findOne({ _id: cons[1]._id })).status === 'available', 10000);
  check('clear faults -> connector available again', !!cleared);

  section('§6/§8 — stop two sessions, connector states over Socket.IO');
  for (const i of [0, 2]) await api('POST', `/charging/sessions/${ids[i]}/stop`, drivers[i], {});
  const bothDone = await waitFor(async () => (await db.collection('chargingsessions').countDocuments({ _id: { $in: [oid(ids[0]), oid(ids[2])] }, status: 'completed', paymentStatus: 'paid' })) === 2, 25000);
  check('both completed and paid', !!bothDone);
  for (const i of [0, 2]) check(`session ${i + 1}: exactly one debit`, (await db.collection('wallettransactions').countDocuments({ chargingSessionId: oid(ids[i]) })) === 1);
  await sleep(1500);
  const seq = s.events.filter((e) => e.event === 'connector:statusChanged' && String(e.payload.connectorId) === String(cons[0]._id)).map((e) => e.payload.status);
  const dedup = seq.filter((x, i) => x !== seq[i - 1]);
  check('connector sequence pushed live: available→preparing→charging→finishing→available', ['preparing', 'charging', 'finishing', 'available'].every((x) => dedup.includes(x)) && dedup.indexOf('preparing') < dedup.indexOf('charging') && dedup.indexOf('charging') < dedup.lastIndexOf('finishing'), dedup.join(' → '));
  const sessSeq = s.events.filter((e) => e.event === 'session:statusChanged' && e.payload.session?.id === ids[0]).map((e) => e.payload.session.status);
  check('session statuses pushed live: initiating→active→stopping→completed', ['initiating', 'active', 'completed'].every((x) => sessSeq.includes(x)), [...new Set(sessSeq)].join(' → '));

  section('§7 — charge-point fault (key m, connectorId 0)');
  sims[0].key('m');
  const hw = await waitFor(async () => { const c = await db.collection('chargers').findOne({ _id: chargers[0]._id }); return c.hardwareStatus !== 'operative' ? c : null; }, 10000);
  check('charger hardwareStatus leaves operative', !!hw, hw?.hardwareStatus);
  const mStart = await api('POST', '/charging/sessions', drivers[0], { connectorId: String(cons[0]._id) });
  check('start refused while the machine is faulted (plugs still "available")', mStart.status === 409 && !/not currently connected/i.test(mStart.body?.message), `${mStart.status} "${mStart.body?.message}"`);
  check('realtime: charger:hardwareStatusChanged pushed', s.events.some((e) => e.event === 'charger:hardwareStatusChanged'));
  sims[0].key('c');
  const hwOk = await waitFor(async () => (await db.collection('chargers').findOne({ _id: chargers[0]._id })).hardwareStatus === 'operative', 10000);
  check('clear -> operative again', !!hwOk);

  section('§10 — arrears refusal on an ONLINE charger');
  const kabir = await login('kabir@driver.local', 'Driver@12345');
  const kStart = await api('POST', '/charging/sessions', kabir, { connectorId: String(cons[2]._id) });
  check('driver in arrears refused, for the ARREARS (not connectivity)', [402, 403, 409].includes(kStart.status) && !/not currently connected/i.test(kStart.body?.message), `${kStart.status} "${kStart.body?.message}"`);
  if (kStart.status === 202) await api('POST', `/charging/sessions/${kStart.data.session.id}/stop`, kabir, {});

  section('§10 — charge with an empty wallet, settled by a later top-up');
  const email = `audit.${Date.now()}@test.local`;
  const reg = await api('POST', '/auth/register', null, { name: 'Audit Driver', email, password: 'AuditPass#1' });
  const fresh = reg.data?.token ?? await login(email, 'AuditPass#1');
  check('fresh driver registered', [200, 201].includes(reg.status), String(reg.status));
  const fs = await api('POST', '/charging/sessions', fresh, { connectorId: String(cons[2]._id) });
  check('₹0 wallet, no arrears: charge allowed to start', fs.status === 202, `${fs.status} ${fs.body?.message ?? ''}`);
  const fid = fs.data?.session?.id;
  if (fid) {
    await waitFor(async () => (await db.collection('chargingsessions').findOne({ _id: oid(fid) }))?.status === 'active', 15000);
    await sleep(6000);
    await api('POST', `/charging/sessions/${fid}/stop`, fresh, {});
    const unpaid = await waitFor(async () => { const x = await db.collection('chargingsessions').findOne({ _id: oid(fid) }); return x.status === 'completed' ? x : null; }, 20000);
    await sleep(2000);
    const u2 = await db.collection('chargingsessions').findOne({ _id: oid(fid) });
    const pay = await db.collection('paymenttransactions').findOne({ chargingSessionId: oid(fid) });
    check('completes UNPAID, payment pending (insufficient balance)', !!unpaid && u2.paymentStatus === 'unpaid' && pay?.status === 'pending', `${u2.status}/${u2.paymentStatus} payment=${pay?.status} "${pay?.failureReason}" ${u2.amountPaise}p`);
    const w0 = (await api('GET', '/wallet', fresh)).data.wallet.balancePaise;
    check('wallet not driven negative', w0 === 0, String(w0));
    const notes = (await api('GET', '/notifications', fresh)).data.items.map((n) => n.type);
    check('driver told payment is pending', notes.includes('payment_pending'), notes.join(','));
    await topUp(fresh, 50);
    const paid = await waitFor(async () => (await db.collection('chargingsessions').findOne({ _id: oid(fid) })).paymentStatus === 'paid', 20000);
    const w1 = (await api('GET', '/wallet', fresh)).data.wallet.balancePaise;
    const debits = await db.collection('wallettransactions').countDocuments({ chargingSessionId: oid(fid) });
    check('top-up settles it: paid, one debit, balance = 5000 − amount', !!paid && debits === 1 && w1 === 5000 - u2.amountPaise, `paid=${!!paid} debits=${debits} balance=${w1} amount=${u2.amountPaise}`);
  }

  section('§7 — every simulator stops cleanly');
  for (const p of sims) p.key('q');
  const off = await waitFor(async () => (await db.collection('chargers').countDocuments({ companyId: liv._id, isOnline: true })) === 0, 15000);
  check('all 3 chargers offline after their simulators quit', !!off);
} catch (e) {
  check('script error', false, e.stack);
} finally {
  for (const p of procs) try { p.kill(); } catch {}
  for (const x of sockets) x.close();
  await sleep(1000);
  await mongoose.disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
}
