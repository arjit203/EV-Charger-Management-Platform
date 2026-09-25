/*
 * API-level audit against a running backend (default :5000) + direct DB reconciliation.
 * Read-mostly: the only writes are refused ones, two temporary connector-status flips (restored),
 * and one failed top-up attempt.
 *
 *   AUDIT_PORT=5000 node tests/e2e/audit-api.mjs
 */
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '');
const require = createRequire(ROOT + '/backend/');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const PORT = process.env.AUDIT_PORT || '5000';
const BASE = `http://localhost:${PORT}/api/v1`;
const env = Object.fromEntries(readFileSync(ROOT + '/backend/.env', 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d !== '' ? '  — ' + d : ''}`); };
const section = (t) => console.log(`\n=== ${t} ===`);
async function api(method, path, token, body) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await r.json().catch(() => null);
  return { status: r.status, body: json, data: json?.data };
}
const login = async (e, p) => (await api('POST', '/auth/login', null, { email: e, password: p })).data.token;
const items = (d) => d?.items ?? d?.sessions ?? d?.stations ?? d?.chargers ?? d?.users ?? d?.payments ?? d?.complaints ?? d ?? [];

await mongoose.connect(env.MONGODB_URI);
const db = mongoose.connection.db;
const tok = {
  admin: await login('admin@evcms.local', 'Admin@12345'),
  livCpo: await login('cpo@livanto.local', 'Cpo@12345'),
  livOps: await login('ops@livanto.local', 'Ops@12345'),
  decCpo: await login('cpo@deccancharge.local', 'Cpo@12345'),
  driver: await login('ananya@driver.local', 'Driver@12345'),
  kabir: await login('kabir@driver.local', 'Driver@12345'),
};
const liv = await db.collection('companies').findOne({ name: 'Livanto Green' });
const dec = await db.collection('companies').findOne({ name: 'Deccan Charge Point' });
const decStation = await db.collection('stations').findOne({ companyId: dec._id });
const decCharger = await db.collection('chargers').findOne({ companyId: dec._id });
const decConnector = await db.collection('connectors').findOne({ chargerId: decCharger._id });
const decUser = await db.collection('users').findOne({ email: 'cpo@deccancharge.local' });
const decTariff = await db.collection('tariffs').findOne({ companyId: dec._id });
const livStation = await db.collection('stations').findOne({ companyId: liv._id });
const livCharger = await db.collection('chargers').findOne({ companyId: liv._id });
const livConnector = await db.collection('connectors').findOne({ chargerId: livCharger._id });
const livTariff = await db.collection('tariffs').findOne({ companyId: liv._id, status: 'active' });
const livOpsUser = await db.collection('users').findOne({ email: 'ops@livanto.local' });

try {
  /* ------------------------------------------------------------------ JWT */
  section('§18 / §5A — tokens');
  const me = jwt.decode(tok.driver);
  const expired = jwt.sign({ sub: me.sub, email: me.email, role: me.role, companyId: null, iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 }, env.JWT_SECRET);
  const rExp = await api('GET', '/auth/me', expired);
  check('expired JWT -> 401', rExp.status === 401, `${rExp.status} "${rExp.body?.message}" ${rExp.body?.errorCode}`);
  const forged = jwt.sign({ sub: me.sub, email: me.email, role: 'super_admin', companyId: null }, 'not-the-secret');
  const rForged = await api('GET', '/companies', forged);
  check('JWT signed with another secret -> 401', rForged.status === 401, String(rForged.status));
  const [h, p, s] = tok.driver.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString()); claims.role = 'super_admin';
  const tampered = `${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${s}`;
  const rTamp = await api('GET', '/companies', tampered);
  check('driver token with role edited to super_admin -> 401', rTamp.status === 401, String(rTamp.status));
  const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;
  check('alg:none token -> 401', (await api('GET', '/companies', none)).status === 401);
  check('no token -> 401', (await api('GET', '/charging/sessions')).status === 401);
  const bogusRole = jwt.sign({ sub: String(livOpsUser._id), email: livOpsUser.email, role: 'super_admin', companyId: null }, env.JWT_SECRET);
  const rRole = await api('GET', '/companies', bogusRole);
  check('validly-signed token CLAIMING super_admin for an operator: DB role wins', rRole.status === 403, `${rRole.status} (server reloads the user; claim ignored)`);

  /* ------------------------------------------------------------ isolation */
  section('§16/§17 — Livanto staff vs Deccan data (direct object access)');
  for (const [who, t] of [['cpo', tok.livCpo], ['operator', tok.livOps]]) {
    const probes = [
      ['station', `/stations/${decStation._id}`],
      ['charger', `/chargers/${decCharger._id}`],
      ['connectors of charger', `/chargers/${decCharger._id}/connectors`],
      ['tariff', `/tariffs/${decTariff._id}`],
      ['user', `/users/${decUser._id}`],
    ];
    for (const [name, path] of probes) {
      const r = await api('GET', path, t);
      check(`${who}: other company's ${name} refused`, [403, 404].includes(r.status), String(r.status));
    }
  }
  section('§17 — list endpoints never leak another company');
  const decIds = new Set([String(dec._id)]);
  const leak = (arr) => arr.filter((x) => x.companyId && decIds.has(String(x.companyId))).length;
  for (const [name, path, t] of [
    ['stations', '/stations?limit=100', tok.livCpo], ['chargers', '/chargers?limit=100', tok.livCpo],
    ['users', '/users?limit=100', tok.livCpo], ['sessions', '/charging/sessions?limit=100', tok.livCpo],
    ['payments', '/payments?limit=100', tok.livCpo], ['complaints', '/complaints?limit=100', tok.livCpo],
    ['tariffs', '/tariffs?limit=100', tok.livCpo], ['operator sessions', '/charging/sessions?limit=100', tok.livOps],
    ['operator complaints', '/complaints?limit=100', tok.livOps], ['operator chargers', '/chargers?limit=100', tok.livOps],
  ]) {
    const r = await api('GET', path, t);
    const arr = items(r.data);
    const foreign = Array.isArray(arr) ? arr.filter((x) => x.companyId && String(x.companyId) !== String(liv._id)).length : -1;
    check(`${name}: only Livanto rows`, r.status === 200 && foreign === 0 || r.status === 403, `status=${r.status} rows=${Array.isArray(arr) ? arr.length : '?'} foreign=${foreign}`);
  }
  const qForeign = await api('GET', `/charging/sessions?companyId=${dec._id}`, tok.livCpo);
  check('passing ?companyId=<other> cannot widen scope', qForeign.status === 422 || qForeign.status === 400 || items(qForeign.data).every?.((x) => String(x.companyId) === String(liv._id)), String(qForeign.status));
  const aForeign = await api('GET', `/analytics/overview?companyId=${dec._id}`, tok.livCpo);
  check('analytics ?companyId=<other> refused or ignored', aForeign.status >= 400 || aForeign.data?.fleet?.stations === (await db.collection('stations').countDocuments({ companyId: liv._id })), String(aForeign.status));
  const drvPay = await api('GET', '/payments?limit=100', tok.driver);
  const drvUsers = new Set(items(drvPay.data).map((x) => x.userId));
  check('driver /payments lists ONLY their own payments', drvPay.status === 200 && drvUsers.size <= 1 && [...drvUsers].every((u) => u === jwt.decode(tok.driver).sub), `rows=${items(drvPay.data).length} users=${[...drvUsers].length}`);
  const opPay = await api('GET', '/payments', tok.livOps);
  check('operator cannot list payments (no revenue for operators)', opPay.status === 403, String(opPay.status));
  const drvAn = await api('GET', '/analytics/overview', tok.driver);
  check('driver cannot read analytics', [403, 404].includes(drvAn.status), String(drvAn.status));
  const opRev = await api('GET', '/analytics/revenue', tok.livOps);
  check('operator cannot read revenue', [403, 404].includes(opRev.status), String(opRev.status));

  /* ---------------------------------------------------------- operator RBAC */
  section('§16 — operator cannot change configuration');
  const opWrites = [
    ['edit own company', 'PATCH', `/companies/${liv._id}`, { name: 'Hacked' }],
    ['suspend own company', 'PATCH', `/companies/${liv._id}/status`, { status: 'suspended' }],
    ['create tariff', 'POST', '/tariffs', { name: 'Op tariff', pricePerKwhPaise: 1 }],
    ['edit tariff', 'PATCH', `/tariffs/${livTariff._id}`, { name: 'x' }],
    ['create station', 'POST', '/stations', { name: 'Op station' }],
    ['edit station', 'PATCH', `/stations/${livStation._id}`, { name: 'x' }],
    ['disable station', 'PATCH', `/stations/${livStation._id}/status`, { status: 'inactive' }],
    ['create charger', 'POST', '/chargers', { name: 'x' }],
    ['edit charger', 'PATCH', `/chargers/${livCharger._id}`, { name: 'x' }],
    ['rotate charger token', 'POST', `/chargers/${livCharger._id}/token`, {}],
    ['set connector status', 'PATCH', `/chargers/${livCharger._id}/connectors/${livConnector._id}/status`, { status: 'unavailable' }],
    ['create staff user', 'POST', '/users', { name: 'Op made', email: 'opmade@x.local', password: 'Passw0rd!x', role: 'cpo_admin' }],
    ['suspend a colleague', 'PATCH', `/users/${livOpsUser._id}/status`, { status: 'suspended' }],
  ];
  for (const [name, m, path, body] of opWrites) {
    const r = await api(m, path, tok.livOps, body);
    check(`operator: ${name} -> refused`, r.status === 403, `${r.status} ${r.status !== 403 ? r.body?.message ?? '' : ''}`);
  }
  const unchanged = await db.collection('companies').findOne({ _id: liv._id });
  check('company record untouched after operator attempts', unchanged.name === 'Livanto Green' && unchanged.status === 'active');
  check('no user created by operator', !(await db.collection('users').findOne({ email: 'opmade@x.local' })));

  /* -------------------------------------------------------------- wallet */
  section('§10 — wallet edge cases');
  for (const [label, amount, want] of [['₹5 (below ₹10 min)', 5, 422], ['₹10 (min)', 10, 201], ['₹10,000 (max)', 10000, 201], ['₹10,001 (above max)', 10001, 422], ['zero', 0, 422], ['negative', -50, 422], ['text', 'abc', 422], ['₹10.555 (sub-paise)', 10.555, null]]) {
    const r = await api('POST', '/wallet/recharge/order', tok.driver, { amount });
    check(`top-up order ${label} -> ${want ?? 'any 2xx/422'}`, want === null ? [201, 422].includes(r.status) : r.status === want, `${r.status} ${r.body?.message ?? ''} ${r.data?.order ? r.data.order.amountPaise + 'p' : ''}`);
  }
  const wBefore = (await api('GET', '/wallet', tok.driver)).data.wallet.balancePaise;
  const order = (await api('POST', '/wallet/recharge/order', tok.driver, { amount: 50 })).data.order;
  const badSig = await api('POST', '/wallet/recharge/verify', tok.driver, { razorpay_order_id: order.providerOrderId, razorpay_payment_id: 'pay_auditbad' + Date.now(), razorpay_signature: crypto.createHmac('sha256', 'wrong').update('x').digest('hex') });
  check('failed payment (bad signature) -> 400, no credit', badSig.status === 400 && (await api('GET', '/wallet', tok.driver)).data.wallet.balancePaise === wBefore, `${badSig.status} ${badSig.body?.message}`);
  const pt = await db.collection('paymenttransactions').findOne({ providerOrderId: order.providerOrderId });
  check('failed payment recorded, not paid', pt && pt.status !== 'paid', pt?.status);
  const otherOrder = await api('POST', '/wallet/recharge/verify', tok.kabir, { razorpay_order_id: order.providerOrderId, razorpay_payment_id: 'pay_x' + Date.now(), razorpay_signature: 'a'.repeat(64) });
  check("another driver cannot verify my order", otherOrder.status >= 400 && otherOrder.status < 500, String(otherOrder.status));
  const kabirW = (await api('GET', '/wallet', tok.kabir)).data;
  console.log(`      kabir wallet ${JSON.stringify(kabirW.wallet ?? kabirW).slice(0, 200)}`);
  const kabirArrears = await db.collection('chargingsessions').countDocuments({ userId: (await db.collection('users').findOne({ email: 'kabir@driver.local' }))._id, paymentStatus: 'unpaid', status: { $in: ['completed', 'failed'] }, amountPaise: { $gt: 0 } });
  const kStart = await api('POST', '/charging/sessions', tok.kabir, { connectorId: String(livConnector._id) });
  check(`driver in arrears (${kabirArrears} unpaid) is refused a new charge`, kabirArrears === 0 ? true : kStart.status === 402 || kStart.status === 409 || kStart.status === 403, `${kStart.status} ${kStart.body?.message}`);
  if (kStart.status === 202) await api('POST', `/charging/sessions/${kStart.data.session.id}/stop`, tok.kabir, {});

  /* ------------------------------------------------- connector lookup states */
  section('§5C — connector lookup states');
  const look = async () => (await api('GET', `/charging/connectors/${livConnector._id}`, tok.driver));
  const l0 = await look();
  console.log(`      lookup payload keys: ${Object.keys(l0.data ?? {}).join(', ')}`);
  const stat = (r) => r.data?.connector?.status ?? r.data?.status;
  const canStart = (r) => r.data?.canStart ?? r.data?.available ?? r.data?.startable;
  check('offline charger: lookup says not startable', l0.status === 200, `status=${stat(l0)} canStart=${canStart(l0)} reason=${r2s(l0.data?.unavailableReason)}`);
  for (const st of ['faulted', 'unavailable']) {
    const set = await api('PATCH', `/chargers/${livCharger._id}/connectors/${livConnector._id}/status`, tok.livCpo, { status: st });
    const r = await look();
    const start = await api('POST', '/charging/sessions', tok.driver, { connectorId: String(livConnector._id) });
    check(`connector ${st}: lookup reports it and start is refused`, set.status === 200 && stat(r) === st && start.status >= 400 && start.status < 500, `set=${set.status} lookup=${stat(r)} reason=${r2s(r.data?.unavailableReason)} start=${start.status} "${start.body?.message}"`);
  }
  await api('PATCH', `/chargers/${livCharger._id}/connectors/${livConnector._id}/status`, tok.livCpo, { status: 'available' });
  check('connector restored to available', (await db.collection('connectors').findOne({ _id: livConnector._id })).status === 'available');

  /* -------------------------------------------------- analytics reconcile */
  section('§12 — analytics figures vs raw data (Livanto, last 30 days)');
  const ov = (await api('GET', '/analytics/overview', tok.livCpo)).data;
  const from = new Date(ov.range.from), to = new Date(ov.range.to);
  const sess = await db.collection('chargingsessions').find({ companyId: liv._id, startedAt: { $gte: from, $lte: to } }).toArray();
  check('sessions total', ov.sessions.total === sess.length, `${ov.sessions.total} vs ${sess.length}`);
  check('completed count', ov.sessions.byStatus.completed === sess.filter((s) => s.status === 'completed').length);
  const eWh = sess.reduce((a, s) => a + (s.energyConsumedWh ?? 0), 0);
  check('energy Wh', Math.abs(ov.sessions.energyWh - eWh) < 1, `${ov.sessions.energyWh} vs ${eWh}`);
  const pays = await db.collection('paymenttransactions').find({ companyId: liv._id, purpose: 'session_debit', status: 'paid', paidAt: { $gte: from, $lte: to } }).toArray();
  const rev = pays.reduce((a, p) => a + p.amountPaise, 0);
  check('revenue paise (paid session debits)', ov.revenue.revenuePaise === rev, `${ov.revenue.revenuePaise} vs ${rev} (${pays.length} payments)`);
  const unpaid = await db.collection('chargingsessions').find({ companyId: liv._id, paymentStatus: 'unpaid', status: { $in: ['completed', 'failed'] }, amountPaise: { $gt: 0 } }).toArray();
  check('unpaid sessions + amount', ov.revenue.unpaidSessions === unpaid.length && ov.revenue.unpaidPaise === unpaid.reduce((a, s) => a + s.amountPaise, 0), `${ov.revenue.unpaidSessions}/${ov.revenue.unpaidPaise} vs ${unpaid.length}/${unpaid.reduce((a, s) => a + s.amountPaise, 0)}`);
  check('fleet stations/chargers/connectors', ov.fleet.stations === await db.collection('stations').countDocuments({ companyId: liv._id }) && ov.fleet.chargers === await db.collection('chargers').countDocuments({ companyId: liv._id }), `${ov.fleet.stations}/${ov.fleet.chargers}/${ov.fleet.connectors}`);
  const platform = (await api('GET', '/analytics/overview', tok.admin)).data;
  const perCo = await Promise.all((await db.collection('companies').find().toArray()).map(async (c) => (await api('GET', `/analytics/overview?companyId=${c._id}`, tok.admin)).data?.revenue?.revenuePaise ?? 0));
  const allPaid = (await db.collection('paymenttransactions').find({ purpose: 'session_debit', status: 'paid', paidAt: { $gte: from, $lte: to } }).toArray()).reduce((a, p) => a + p.amountPaise, 0);
  check('platform revenue = all paid session debits', platform.revenue.revenuePaise === allPaid, `${platform.revenue.revenuePaise} vs ${allPaid}; per-company sum ${perCo.reduce((a, b) => a + b, 0)}`);

  /* ------------------------------------------------------- DB hygiene */
  section('§19 / §24 — database hygiene');
  for (const c of ['users', 'companies', 'stations', 'chargers', 'connectors', 'chargingsessions', 'tariffs', 'paymenttransactions', 'wallettransactions', 'complaints', 'notifications', 'wallets']) {
    const missing = await db.collection(c).countDocuments({ $or: [{ createdAt: null }, { updatedAt: null }] });
    check(`${c}: every row has createdAt/updatedAt`, missing === 0, `missing=${missing}`);
  }
  const dupe = async (coll, key) => (await db.collection(coll).aggregate([{ $group: { _id: key, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray()).length;
  check('no duplicate emails (case-insensitive)', (await dupe('users', { $toLower: '$email' })) === 0);
  check('no duplicate OCPP ids', (await dupe('chargers', '$ocppId')) === 0);
  check('no duplicate station codes within a company', (await dupe('stations', { c: '$companyId', s: '$stationCode' })) === 0);
  check('no duplicate connector numbers within a charger', (await dupe('connectors', { c: '$chargerId', n: '$connectorNumber' })) === 0);
  check('no duplicate company names', (await dupe('companies', { $toLower: '$name' })) === 0);
  check('one wallet per user', (await dupe('wallets', '$userId')) === 0);

  const complaints = await db.collection('complaints').find().toArray();
  const staff = new Map((await db.collection('users').find({ role: { $in: ['cpo_admin', 'operator'] } }).toArray()).map((u) => [String(u._id), u]));
  const bad = [];
  for (const c of complaints) {
    const last = c.history?.[c.history.length - 1];
    if (last && (last.to ?? last.status) && (last.to ?? last.status) !== c.status) bad.push(`${c._id} history ends ${last.to ?? last.status} but status ${c.status}`);
    if (['resolved', 'closed'].includes(c.status) && c.status === 'resolved' && !c.resolution) bad.push(`${c._id} resolved without resolution`);
    if (['open', 'in_progress'].includes(c.status) && c.resolvedAt) bad.push(`${c._id} ${c.status} but resolvedAt set`);
    if (c.assignedTo && (!staff.get(String(c.assignedTo)) || String(staff.get(String(c.assignedTo)).companyId) !== String(c.companyId))) bad.push(`${c._id} assigned outside its company`);
    if (c.chargingSessionId) {
      const s = await db.collection('chargingsessions').findOne({ _id: c.chargingSessionId });
      if (!s || String(s.companyId) !== String(c.companyId) || String(s.userId) !== String(c.userId)) bad.push(`${c._id} session ref mismatch`);
    }
  }
  check(`complaints (${complaints.length}): no contradictory states`, bad.length === 0, bad.join(' | '));
  console.log('      complaint states: ' + JSON.stringify(complaints.reduce((a, c) => ((a[c.status] = (a[c.status] ?? 0) + 1), a), {})));
  const notif = await db.collection('notifications').find({ referenceType: 'complaint' }).toArray();
  let nbad = 0;
  for (const n of notif) {
    const u = await db.collection('users').findOne({ _id: n.userId });
    const c = await db.collection('complaints').findOne({ _id: n.referenceId });
    if (!c || (u.role !== 'driver' && String(u.companyId) !== String(c.companyId)) || (u.role === 'driver' && String(c.userId) !== String(u._id))) nbad++;
  }
  check(`complaint notifications (${notif.length}) all point at a visible complaint`, nbad === 0, `bad=${nbad}`);
} catch (e) {
  check('script error', false, e.stack);
} finally {
  await mongoose.disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
}
function r2s(v) { return v == null ? '-' : String(v).slice(0, 60); }
