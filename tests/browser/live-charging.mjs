/* Live UI audit: REAL simulator on the dev backend, driver watches the session page tick and
 * stops it from the UI; the CPO watches Live operations. No reloads anywhere. */
import { chromium } from 'playwright';
import { spawn } from 'child_process';

const APP = process.env.APP_URL || 'http://localhost:3000';
const API = process.env.API_URL || 'http://localhost:5000/api/v1';
import { fileURLToPath } from 'url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(m, p, tok, body) {
  const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: (await r.json().catch(() => null))?.data };
}
const login = async (e, pw) => (await api('POST', '/auth/login', null, { email: e, password: pw })).data.token;
async function uiLogin(ctx, email, pw) {
  const p = await ctx.newPage();
  await p.goto(APP + '/login'); await p.fill('input[name="email"]', email); await p.fill('input[name="password"]', pw);
  await p.click('button[type="submit"]'); await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
  return p;
}

const admin = await login('admin@evcms.local', 'Admin@12345');
const driver = await login('rohit@driver.local', 'Driver@12345');
const chargers = (await api('GET', '/chargers?limit=50', admin)).data;
const charger = (chargers.items ?? chargers).find((c) => c.ocppId === 'VPC-BLR-KR-01-A');
const tok = (await api('POST', `/chargers/${charger.id}/token`, admin)).data.authToken;
const startSim = () => spawn(process.execPath, [ROOT + '/simulator/node_modules/tsx/dist/cli.mjs', 'src/index.ts', `--charger=${charger.ocppId}`, `--token=${tok}`, '--meterInterval=2', `--url=${API.replace(/^http/, 'ws').replace(/\/api\/v\d+$/, '/ocpp')}`], { cwd: ROOT + '/simulator', stdio: 'ignore' });

let sim = null;
const browser = await chromium.launch();
try {
  const cpoCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const cpo = await uiLogin(cpoCtx, 'cpo@voltpath.local', 'Cpo@12345');
  await cpo.goto(APP + '/monitor', { waitUntil: 'networkidle' });
  // Record every connector status label that EVER renders — Preparing and Finishing last well
  // under a second, so polling would miss them. Installed on every load (the dev server can
  // reload a page when it compiles a route) and reported straight back to this script.
  const seenLabels = new Set();
  await cpo.exposeFunction('__reportLabel', (label) => seenLabels.add(label.toLowerCase()));
  const observe = () => {
    const scan = () => { for (const m of document.body.innerText.matchAll(/(preparing|charging|finishing|available)/gi)) window.__reportLabel(m[1]); };
    new MutationObserver(scan).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    scan();
  };
  await cpo.addInitScript(`(${observe.toString()})()`.replace('document.body.innerText', '(document.body ? document.body.innerText : "")'));
  await cpo.evaluate(observe);

  // CPO dashboard: the numbers it shows are the API's numbers, and its tiles move live.
  const cpoTok = (await api('POST', '/auth/login', null, { email: 'cpo@voltpath.local', password: 'Cpo@12345' })).data.token;
  const ov = (await api('GET', '/analytics/overview', cpoTok)).data;
  const dash = await cpoCtx.newPage();
  await dash.goto(APP + '/dashboard', { waitUntil: 'networkidle' });
  const dText = await dash.textContent('body');
  const rupees = (p) => `₹${(p / 100).toFixed(2)}`;
  ok('CPO dashboard shows the API revenue figure', dText.includes(rupees(ov.revenue.revenuePaise)) || dText.includes(String(ov.revenue.revenueRupees)), `${rupees(ov.revenue.revenuePaise)}`);
  ok('CPO dashboard shows the API session count', dText.includes(String(ov.sessions.total)), String(ov.sessions.total));
  const tile = async (label) => Number((await dash.locator(`xpath=//p[normalize-space()="${label}"]/preceding-sibling::p[1]`).first().textContent().catch(() => '-1')).replace(/\D+/g, '') || 0);
  const online0 = await tile('Online');

  // Driver home, open before the charge starts.
  const dhCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const dh = await uiLogin(dhCtx, 'rohit@driver.local', 'Driver@12345');
  await dh.goto(APP + '/dashboard', { waitUntil: 'networkidle' });
  ok('driver home shows no charge in progress yet', !/Charging now/.test(await dh.textContent('body')));

  sim = startSim();
  const chip = async (label) => Number(((await cpo.getByRole('button', { name: new RegExp(`^${label}`) }).first().textContent()) ?? '').replace(/\D+/g, '') || 0);
  const onlineAt = Date.now();
  let online = 0;
  while (Date.now() - onlineAt < 15000 && online < 1) { online = await chip('Online'); await sleep(500); }
  ok('CPO Live ops: charger flips Online without reload', online >= 1, `Online=${online}`);
  let online1 = online0;
  for (let i = 0; i < 20 && online1 <= online0; i++) { online1 = await tile('Online'); await sleep(500); }
  ok('CPO dashboard Online tile rises live', online1 === online0 + 1, `${online0} -> ${online1}`);

  const connectors = (await api('GET', `/chargers/${charger.id}/connectors`, admin)).data;
  const connector = (connectors.items ?? connectors.connectors ?? connectors)[0];
  const start = await api('POST', '/charging/sessions', driver, { connectorId: connector.id });
  const sid = start.data.session.id;
  ok('driver start accepted', start.status === 202, String(start.status));

  const dCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const d = await uiLogin(dCtx, 'rohit@driver.local', 'Driver@12345');
  await d.goto(APP + `/sessions/${sid}`, { waitUntil: 'networkidle' });
  let charging = 0;
  for (let i = 0; i < 30 && charging < 1; i++) { charging = await chip('Charging'); await sleep(500); }
  ok('CPO Live ops: Charging count rises without reload', charging >= 1, `Charging=${charging}`);
  let homeLive = false;
  for (let i = 0; i < 20 && !homeLive; i++) { homeLive = /Charging now/.test(await dh.textContent('body')); await sleep(500); }
  ok('driver home switches to "Charging now" without reload', homeLive);
  let inActive = false;
  for (let i = 0; i < 20 && !inActive; i++) { inActive = (await dash.textContent('body')).includes('Koramangala'); await sleep(500); }
  ok('CPO dashboard active-sessions panel shows it live', inActive);
  const e1 = await d.locator('h1').first().textContent();
  await sleep(8000);
  const e2 = await d.locator('h1').first().textContent();
  ok('driver session page energy ticks live', e1 !== e2, `${e1} -> ${e2}`);

  // Stop from the UI.
  const stopBtn = d.getByRole('button', { name: /stop charging/i }).first();
  ok('driver sees a Stop charging button', (await stopBtn.count()) > 0);
  if (await stopBtn.count()) {
    await stopBtn.click();
    const confirm = d.getByRole('button', { name: /^(stop|confirm|yes)/i });
    if (await confirm.count() > 1) await confirm.last().click().catch(() => {});
  }
  let done = false;
  for (let i = 0; i < 40 && !done; i++) { done = /Completed/i.test(await d.textContent('body')) && /Paid|₹/.test(await d.textContent('body')); await sleep(500); }
  ok('session page shows Completed + amount without reload', done);
  const s = (await api('GET', `/charging/sessions/${sid}`, driver)).data.session;
  ok('API: completed & paid', s.status === 'completed' && s.paymentStatus === 'paid', `${s.status}/${s.paymentStatus} ${s.amountPaise}p`);
  let back = 99;
  for (let i = 0; i < 20 && back > 0; i++) { back = await chip('Charging'); await sleep(500); }
  ok('CPO Live ops: Charging back to 0', back === 0, `Charging=${back}`);
  const seen = [...seenLabels];
  ok('Live ops rendered Preparing and Finishing along the way', seen.includes('preparing') && seen.includes('finishing'), seen.join(', '));
  await d.goto(APP + '/wallet', { waitUntil: 'load' });
  await d.waitForTimeout(2000);
  ok('wallet page lists the session debit', /Charging at|session/i.test(await d.textContent('body')));
} catch (e) { ok('script error', false, e.stack); }
finally {
  sim?.kill(); await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
}
