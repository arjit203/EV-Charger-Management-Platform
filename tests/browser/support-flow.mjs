/* UI audit (dev servers :3000/:5000, seeded demo data): support workflow end to end in the
 * browser, notification read state, session persistence, driver home content, currency display,
 * and what the UI does when its Socket.IO link drops and comes back. */
import { chromium } from 'playwright';

const APP = process.env.APP_URL || 'http://localhost:3000';
const API = process.env.API_URL || 'http://localhost:5000/api/v1';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d !== '' ? '  — ' + d : ''}`); };
const section = (t) => console.log(`\n=== ${t} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(m, p, tok, body) {
  const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: (await r.json().catch(() => null))?.data };
}
const login = async (e, pw) => (await api('POST', '/auth/login', null, { email: e, password: pw })).data.token;
/* Every Socket.IO connection of a context goes through this proxy, so a test can cut it. */
async function withSocketSwitch(ctx) {
  const sw = { blocked: false, open: [] };
  await ctx.routeWebSocket(/socket\.io/, (ws) => {
    if (sw.blocked) { ws.close(); return; }
    ws.connectToServer();
    sw.open.push(ws);
  });
  sw.drop = () => { sw.blocked = true; for (const w of sw.open.splice(0)) w.close().catch(() => {}); };
  sw.restore = () => { sw.blocked = false; };
  return sw;
}
async function uiLogin(browser, email, pw) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  ctx.socketSwitch = await withSocketSwitch(ctx);
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  await p.goto(APP + '/login'); await p.fill('input[name="email"]', email); await p.fill('input[name="password"]', pw);
  await p.click('button[type="submit"]'); await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
  return p;
}
const bellCount = async (p) => Number(((await p.locator('button[aria-label^="Notifications"]').first().getAttribute('aria-label')) ?? '').match(/\((\d+) unread\)/)?.[1] ?? 0);
async function waitFor(fn, ms, step = 400) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); } return null; }
// The app's own rule (frontend/src/lib/money.ts formatPaise): "₹" + rupees to exactly 2 places.
const inr = (paise) => `₹${(paise / 100).toFixed(2)}`;

const driverTok = await login('ananya@driver.local', 'Driver@12345');
const opsTok = await login('ops@livanto.local', 'Ops@12345');
const sessions = (await api('GET', '/charging/sessions?limit=50', driverTok)).data.items;
const anchor = sessions.find((s) => s.status === 'completed' && s.companyName === 'Livanto Green');
const stamp = Date.now().toString(36);
const NOTE = `INTERNAL-NOTE-${stamp} power-cycled the unit`;
const REPLY = `Driver reply ${stamp}: the connector latch was reset.`;

const browser = await chromium.launch();
try {
  const ops = await uiLogin(browser, 'ops@livanto.local', 'Ops@12345');
  await ops.goto(APP + '/dashboard', { waitUntil: 'networkidle' });
  const n0 = await bellCount(ops);
  const drv = await uiLogin(browser, 'ananya@driver.local', 'Driver@12345');

  section('§14 — driver files a complaint in the UI');
  ok('an anchor session exists (completed at Livanto)', !!anchor, anchor?.id);
  await drv.goto(APP + `/complaints/new?sessionId=${anchor.id}`, { waitUntil: 'networkidle' });
  await drv.fill('input[name="subject"]', `Audit ${stamp}: charge stopped early`);
  await drv.fill('textarea', 'The session ended by itself after a few minutes while the car still needed charge.');
  await drv.click('button[type="submit"]');
  await drv.waitForURL(/\/complaints\/[0-9a-f]{24}/, { timeout: 15000 }).catch(() => {});
  const complaintId = drv.url().match(/complaints\/([0-9a-f]{24})/)?.[1];
  ok('submit lands on the new ticket', !!complaintId, drv.url());

  section('§8/§15 — staff bell updates live');
  const n1 = await waitFor(async () => { const n = await bellCount(ops); return n > n0 ? n : null; }, 12000);
  ok('operator bell count rises without reload', !!n1, `${n0} -> ${n1}`);

  section('§13 — operator works the ticket in the UI');
  await ops.goto(APP + `/complaints/${complaintId}`, { waitUntil: 'networkidle' });
  await ops.getByRole('button', { name: 'Assign to me' }).click();
  await sleep(1200);
  let c = (await api('GET', `/complaints/${complaintId}`, opsTok)).data.complaint;
  ok('Assign to me -> assigned to the operator', !!c.assignedTo, String(c.assignedTo));
  await ops.getByRole('button', { name: 'Start working on it' }).click();
  await sleep(1200);
  c = (await api('GET', `/complaints/${complaintId}`, opsTok)).data.complaint;
  ok('Start working on it -> in_progress', c.status === 'in_progress', c.status);
  await ops.getByPlaceholder(/What you checked or did/).fill(NOTE);
  await ops.getByRole('button', { name: 'Add note' }).click();
  await sleep(1200);
  ok('work note shows on the staff page', (await ops.textContent('body')).includes(NOTE));
  await ops.getByPlaceholder(/What was wrong and what was done/).fill(REPLY);
  await ops.getByRole('button', { name: 'Mark resolved' }).click();
  await sleep(1500);
  c = (await api('GET', `/complaints/${complaintId}`, opsTok)).data.complaint;
  ok('Mark resolved -> resolved with the reply as resolution', c.status === 'resolved' && c.resolution === REPLY, `${c.status} "${c.resolution}"`);

  section('§13 — note vs reply, from the DRIVER side');
  await drv.goto(APP + `/complaints/${complaintId}`, { waitUntil: 'networkidle' });
  const dBody = await drv.textContent('body');
  ok('driver sees the reply', dBody.includes(REPLY));
  ok('driver NEVER sees the internal note (page)', !dBody.includes(NOTE) && !dBody.includes('INTERNAL-NOTE'));
  const dApi = JSON.stringify((await api('GET', `/complaints/${complaintId}`, driverTok)).data);
  ok('driver NEVER sees the internal note (API payload)', !dApi.includes(NOTE));
  const dNotes = JSON.stringify((await api('GET', '/notifications?limit=50', driverTok)).data);
  ok('driver NEVER sees the internal note (notifications)', !dNotes.includes(NOTE));

  section('§13 — driver reopens');
  await drv.getByRole('button', { name: /still a problem/ }).click();
  await drv.getByPlaceholder(/still stops after/).fill('It happened again this morning at the same charger.');
  await drv.getByRole('button', { name: 'Reopen complaint' }).click();
  await sleep(1500);
  c = (await api('GET', `/complaints/${complaintId}`, opsTok)).data.complaint;
  ok('reopen -> open again, reopenCount 1, history kept', c.status === 'open' && c.reopenCount === 1 && c.history.length >= 3, `${c.status} reopen=${c.reopenCount} history=${c.history.length}`);
  ok('staff page shows the reopen live or after navigation', await waitFor(async () => { await ops.reload({ waitUntil: 'networkidle' }); return /Reopened/i.test(await ops.textContent('body')); }, 8000));
  const illegal = await api('PATCH', `/complaints/${complaintId}/status`, opsTok, { status: 'closed' });
  ok('invalid transition for an operator (close) refused', illegal.status === 403, String(illegal.status));

  section('§15 — notification read state in the UI');
  await ops.goto(APP + '/notifications', { waitUntil: 'networkidle' });
  const before = await bellCount(ops);
  const firstUnread = ops.locator('.list-row[data-highlight="true"]').first();
  if (await firstUnread.count()) {
    await firstUnread.click();
    await sleep(1500);
    await ops.goto(APP + '/notifications', { waitUntil: 'networkidle' });
    const after1 = await bellCount(ops);
    ok('opening one unread notification marks it read', after1 === before - 1, `${before} -> ${after1}`);
  } else ok('there is an unread notification to open', false, `bell=${before}`);
  await ops.getByRole('button', { name: /mark all/i }).first().click();
  await sleep(1500);
  const unreadApi = (await api('GET', '/notifications/unread-count', opsTok)).data.unreadCount;
  ok('Mark all read -> bell 0 and API 0', (await bellCount(ops)) === 0 && unreadApi === 0, `bell=${await bellCount(ops)} api=${unreadApi}`);

  section('§5A — session persistence');
  await drv.goto(APP + '/wallet', { waitUntil: 'networkidle' });
  await drv.reload({ waitUntil: 'networkidle' });
  ok('reload keeps the driver signed in', drv.url().endsWith('/wallet'), drv.url());
  const tab2 = await drv.context().newPage();
  await tab2.goto(APP + '/sessions', { waitUntil: 'networkidle' });
  ok('a new tab is signed in too', tab2.url().endsWith('/sessions'), tab2.url());

  section('§5B / §11 — driver home content and currency display');
  await drv.goto(APP + '/dashboard', { waitUntil: 'networkidle' });
  const home = await drv.textContent('body');
  ok('home greets the driver by name', home.includes('Ananya Rao'));
  ok('home shows role and account status', /Driver/.test(home) && /Account: active/i.test(home));
  for (const [label, href] of [['charge', '/charge'], ['map', '/map'], ['wallet', '/wallet'], ['sessions', '/sessions']]) ok(`home quick action → ${href}`, (await drv.locator(`a[href="${href}"]`).count()) > 0, label);
  const wallet = (await api('GET', '/wallet', driverTok)).data.wallet;
  await drv.goto(APP + '/wallet', { waitUntil: 'networkidle' });
  const wBody = await drv.textContent('body');
  ok('wallet balance shown in ₹ with 2 decimals, equal to the API', wBody.includes(inr(wallet.balancePaise)), `expected ${inr(wallet.balancePaise)}`);
  const paidSession = sessions.find((s) => s.paymentStatus === 'paid' && s.amountPaise > 0);
  await drv.goto(APP + `/sessions/${paidSession.id}`, { waitUntil: 'networkidle' });
  ok('session page shows the exact amount in ₹', (await drv.textContent('body')).includes(inr(paidSession.amountPaise)), `expected ${inr(paidSession.amountPaise)}`);
  const tariff = paidSession.appliedPricePerKwhPaise;
  ok('session page shows the applied rate ₹/kWh', (await drv.textContent('body')).includes(inr(tariff).replace('₹', '')), inr(tariff));

  section('§18 — browser Socket.IO drops and comes back');
  await ops.goto(APP + '/dashboard', { waitUntil: 'networkidle' });
  const sw = ops.context().socketSwitch;
  sw.drop();
  const wentOffline = await waitFor(async () => /Offline/.test(await ops.locator('header').first().textContent()), 30000, 1000);
  ok('topbar shows Offline when the socket drops', !!wentOffline);
  const bellWhileOffline = await bellCount(ops);
  // An event happens while this browser is disconnected: the driver files another complaint.
  await api('POST', '/complaints', driverTok, { category: 'session_issue', subject: `Audit ${stamp}: while you were offline`, description: 'Filed while the operator browser was disconnected.', chargingSessionId: anchor.id });
  await sleep(2000);
  sw.restore();
  const backLive = await waitFor(async () => /Live/.test(await ops.locator('header').first().textContent()), 30000, 1000);
  ok('topbar returns to Live on reconnect', !!backLive);
  const caughtUp = await waitFor(async () => (await bellCount(ops)) > bellWhileOffline, 10000);
  ok('bell catches up on what happened while offline (no reload)', !!caughtUp, `before=${bellWhileOffline} now=${await bellCount(ops)} api=${(await api('GET', '/notifications/unread-count', opsTok)).data.unreadCount}`);

  ok('no uncaught exceptions in either browser', ops.errors.length === 0 && drv.errors.length === 0, [...ops.errors, ...drv.errors].join(' | '));
} catch (e) { ok('script error', false, e.stack); }
finally {
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
}
