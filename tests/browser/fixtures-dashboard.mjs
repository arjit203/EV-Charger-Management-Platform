import { fileURLToPath } from 'url';
/* Module 15 demo data, on the SEEDED Livanto company so the dashboard has real numbers:
 * a completed+paid session (revenue), an unpaid one (awaiting payment), and an open
 * complaint. Everything goes through the real APIs and the real OCPP path. */

import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(new URL('../../backend/', import.meta.url));
const WebSocket = require('ws');
require('dotenv').config({ path: fileURLToPath(new URL('../../backend/.env', import.meta.url)) });

const BASE = process.env.BASE || 'http://localhost:5000/api/v1';
const WS_BASE = process.env.WS_BASE || 'ws://localhost:5000/ocpp';
const SECRET = process.env.RZP_SECRET || 'stub_secret_not_for_production';
const S = String(Date.now()).slice(-6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const uid = `s15-${Math.random().toString(36).slice(2)}`;
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
  startHeartbeat() { this.beat = setInterval(() => { this.send('Heartbeat', {}).catch(() => {}); }, 2000); }
  close() { if (this.beat) clearInterval(this.beat); try { this.socket.close(); } catch {} }
}

const su = (await must('POST', '/auth/login', { body: { email: 'admin@evcms.local', password: 'Admin@12345' } })).token;
const cpo = (await must('POST', '/auth/login', { body: { email: 'cpo@livanto.local', password: 'Cpo@12345' } })).token;

const stations = (await must('GET', '/stations?limit=50', { token: cpo })).items;
if (stations.length === 0) throw new Error('No Livanto stations - run npm run seed:demo');

/* Search for a charger that actually HAS a connector. The seeded demo data does not guarantee
 * one on the first station, and picking blindly is how this script failed the first time. */
let station = null;
let charger = null;
let connector = null;

for (const candidateStation of stations) {
  const chargers = (await must('GET', `/chargers?stationId=${candidateStation.id}`, { token: cpo })).items;
  for (const candidateCharger of chargers) {
    /* Connectors are NESTED under their charger (Module 5's decision), and
     * `GET /chargers/:id` returns only `{ charger }` — the connectors live on their own
     * sub-route. Reading the wrong shape is what made the first attempt find none. */
    const { connectors } = await must('GET', `/chargers/${candidateCharger.id}/connectors`, { token: cpo });
    if (connectors?.length > 0) {
      station = candidateStation;
      charger = candidateCharger;
      [connector] = connectors;
      break;
    }
  }
  if (connector) break;
}

if (!connector) throw new Error('No Livanto charger has a connector - run npm run seed:demo');

console.log(`station : ${station.name}`);
console.log(`charger : ${charger.name} (${charger.ocppId})`);

/* A funded driver and an unfunded one. */
async function driver(tag, fund) {
  const email = `m15.${tag}.${S}@test.local`;
  await must('POST', '/auth/register', { body: { name: `M15 ${tag}`, email, password: 'M15Demo12345' } });
  const token = (await must('POST', '/auth/login', { body: { email, password: 'M15Demo12345' } })).token;

  if (fund) {
    const order = (await must('POST', '/wallet/recharge/order', { token, body: { amount: 500 } })).order;
    const payId = `pay_m15${tag}${S}`;
    await must('POST', '/wallet/recharge/verify', { token, body: {
      razorpay_order_id: order.providerOrderId, razorpay_payment_id: payId,
      razorpay_signature: sign(`${order.providerOrderId}|${payId}`) } });
  }
  return token;
}

const funded = await driver('funded', true);
const broke = await driver('broke', false);

const sim = new Sim(charger.ocppId, process.env.M15_TOKEN || '');
/* The auth token is only returned at creation, so re-issue one through the admin API. */
const reissued = await must('POST', `/chargers/${charger.id}/token`, { token: su }).catch(() => null);
if (reissued?.authToken) sim.token = reissued.authToken;

const ok = await sim.connect();
if (!ok) {
  console.log('\nCould not connect the simulator (token). Sessions skipped; the dashboard will');
  console.log('still render with stations/chargers/complaints.');
} else {
  sim.startHeartbeat();
  await sim.send('BootNotification', { chargePointVendor: 'Test', chargePointModel: 'M15' });
  await sim.send('StatusNotification', { connectorId: connector.connectorNumber, status: 'Available', errorCode: 'NoError' });
  await sleep(400);

  async function charge(token, wh) {
    const req = call('POST', '/charging/sessions', { token, body: { connectorId: connector.id } });
    const cmd = await sim.waitForCall('RemoteStartTransaction');
    sim.reply(cmd.uid, { status: 'Accepted' });
    const sessionId = (await req).body?.data?.session?.id;
    await sim.send('Authorize', { idTag: cmd.payload.idTag });
    const st = await sim.send('StartTransaction', { connectorId: connector.connectorNumber, idTag: cmd.payload.idTag, meterStart: 0, timestamp: new Date().toISOString() });
    await sim.send('StatusNotification', { connectorId: connector.connectorNumber, status: 'Charging', errorCode: 'NoError' });
    await sim.send('MeterValues', { connectorId: connector.connectorNumber, transactionId: st[2].transactionId, energyWh: Math.round(wh / 2), timestamp: new Date().toISOString() });
    await sleep(300);
    await sim.send('StopTransaction', { transactionId: st[2].transactionId, meterStop: wh, reason: 'Remote', timestamp: new Date().toISOString() });
    await sim.send('StatusNotification', { connectorId: connector.connectorNumber, status: 'Available', errorCode: 'NoError' });
    await sleep(1600);
    return sessionId;
  }

  const paid = await charge(funded, 7500);
  console.log('created  a completed + PAID session (7.5 kWh)');

  await charge(broke, 4000);
  console.log('created  a completed + UNPAID session (4 kWh) -> awaiting payment');

  await must('POST', '/complaints', { token: funded, body: {
    category: 'session_issue',
    subject: 'Charge stopped earlier than expected',
    description: 'The session ended before my vehicle was full and I had to restart it.',
    chargingSessionId: paid } });
  console.log('created  an open complaint');

  sim.close();
}

await sleep(300);
console.log('\nStaff : cpo@livanto.local / Cpo@12345');
console.log('Ops   : ops@livanto.local / Ops@12345');
console.log(`Driver: m15.funded.${S}@test.local / M15Demo12345`);
