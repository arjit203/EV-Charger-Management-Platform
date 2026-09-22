/* MODULE 15 - the operations dashboard, verified in a real browser.
 *
 * This module has essentially no new backend surface, so nearly all of "does it work" is
 * here rather than in an API suite. Two things matter most:
 *
 *   1. THE NUMBERS ARE NOT DECORATION. Every card is asserted against a value computed
 *      INDEPENDENTLY from the same APIs in this script - not hardcoded, and not merely
 *      "the page rendered".
 *   2. THE LIVE UPDATE IS REAL. A genuine OCPP session is driven while the dashboard sits
 *      open, and the page must change WITHOUT a reload.
 *
 * Playwright lives in the scratchpad only. It is not a project dependency.
 */

import { chromium } from 'playwright';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(new URL('../../backend/', import.meta.url));
const WebSocket = require('ws');

const DIR = path.dirname(fileURLToPath(import.meta.url));
const APP = 'http://localhost:3000';
const API = 'http://localhost:5000/api/v1';
const WS_BASE = 'ws://localhost:5000/ocpp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const fails = [];
function chk(label, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (ok) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`); }
}
const section = (t) => console.log(`\n--- ${t} ---`);

/* ---------------------------------------------------- independent API side */

const api = async (m, p, token, body) => {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(API + p, { method: m, headers: h, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const apiMust = async (m, p, token, body) => {
  const r = await api(m, p, token, body);
  if (r.status >= 400) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
};
const tokenFor = async (email, password) =>
  (await apiMust('POST', '/auth/login', null, { email, password })).token;

const browser = await chromium.launch();

async function signIn(email, password, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1200);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await Promise.all([
    page.waitForURL('**/dashboard', { timeout: 45000 }),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForTimeout(2500);
  return { context, page, errors };
}

const navLabels = (page) => page.locator('nav[aria-label="Main"] a').allTextContents();
const bodyText = (page) => page.locator('body').innerText();

/*
 * Wait for text to APPEAR, rather than sleeping a guessed number of milliseconds and reading
 * once. An earlier version captured `innerText` a single time right after login and then
 * asserted against that snapshot — so cards that rendered a moment later looked missing even
 * though they were on screen. Polling removes the race entirely.
 */
async function waitForText(page, needle, timeout = 15000) {
  /* CASE-INSENSITIVE on purpose: card labels and sidebar group headers carry Tailwind's
   * `uppercase`, and innerText returns the RENDERED text - so "Charging now" comes back as
   * "CHARGING NOW". Two separate assertions failed on exactly this before it was noticed. */
  const wanted = needle.toLowerCase();
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if ((await bodyText(page)).toLowerCase().includes(wanted)) return true;
    await sleep(250);
  }
  return false;
}

/** The inverse: wait until something is GONE (a row leaving a table, a skeleton clearing). */
async function waitForTextGone(page, needle, timeout = 15000) {
  const wanted = needle.toLowerCase();
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (!(await bodyText(page)).toLowerCase().includes(wanted)) return true;
    await sleep(250);
  }
  return false;
}

console.log('\n================ MODULE 15 - OPERATIONS DASHBOARD ================');

/* =========================================================================
 * 1. CPO ADMIN - numbers checked against the API, independently
 * ========================================================================= */

section('1. CPO ADMIN - every card checked against an independent API call');

const cpoToken = await tokenFor('cpo@livanto.local', 'Cpo@12345');
const overview = await apiMust('GET', '/analytics/overview', cpoToken);
const series = await apiMust('GET', '/analytics/sessions', cpoToken);
const revSeries = await apiMust('GET', '/analytics/revenue', cpoToken);
const activePage = await apiMust('GET', '/charging/sessions?active=true&limit=10', cpoToken);

const todayPoint = series.points[series.points.length - 1];
const todayRev = revSeries.points[revSeries.points.length - 1];

const cpo = await signIn('cpo@livanto.local', 'Cpo@12345');
{
  const { page, errors } = cpo;

  // Block until the dashboard has actually painted its data, not its skeletons.
  await waitForText(page, 'Charging now');
  const text = (await bodyText(page)).toLowerCase();

  chk('no uncaught page errors', [], errors);
  chk('the sidebar rendered', true, (await navLabels(page)).length > 0);

  /*
   * Read a card's VALUE by walking the DOM from its label, rather than by CSS position.
   * An earlier version used `locator('..')` and got empty strings back — reading the value
   * out of the label element's next sibling via evaluate is unambiguous.
   */
  const card = (label) =>
    page.evaluate((wanted) => {
      const labelEl = [...document.querySelectorAll('p')]
        .find((el) => el.textContent.trim() === wanted);
      if (!labelEl) return null;
      const value = labelEl.nextElementSibling;
      return value ? value.textContent.trim() : null;
    }, label);

  chk('STATIONS card matches the API', String(overview.fleet.stations), await card('Stations'));
  chk('CHARGERS card matches the API', String(overview.fleet.chargers), await card('Chargers'));
  chk('CHARGING NOW card matches the API', String(overview.fleet.activeSessions), await card('Charging now'));
  chk('SESSIONS TODAY card matches the daily series', String(todayPoint.sessions), await card('Sessions today'));
  chk('ENERGY TODAY card matches the daily series', `${todayPoint.energyKwh} kWh`, await card('Energy today'));
  chk('OPEN COMPLAINTS card matches the API', String(overview.complaints.openNow), await card('Open complaints'));

  const rupees = (paise) => `₹${(paise / 100).toFixed(2)}`;
  chk('REVENUE TODAY card matches the revenue series', rupees(todayRev.revenuePaise), await card('Revenue today'));

  /* The seed created a genuinely uncollected session, so this must be present AND right. */
  chk('AWAITING PAYMENT card is shown', true, text.includes('awaiting payment'));
  chk('and matches the API', rupees(overview.revenue.unpaidPaise), await card('Awaiting payment'));

  /* Sanity: these are not zeros dressed up as data. */
  chk('the revenue figure is genuinely non-zero', true, overview.revenue.revenuePaise > 0);
  chk('the dashboard prints that same non-zero figure', true, text.includes(rupees(overview.revenue.revenuePaise).toLowerCase()));

  chk('active sessions panel agrees with the API', true,
    text.includes(activePage.items.length === 0 ? 'no sessions in progress' : 'active sessions'));

  chk('recent activity has content from the seeded run', true,
    text.includes('recent activity') && !text.includes('nothing has happened yet'));

  chk('the map is a navigation card, not an embedded map', 0,
    await page.locator('.leaflet-container').count());
  chk('and it offers the way through to the real map', 1,
    await page.locator('a:has-text("Open map")').count());

  await page.screenshot({ path: path.join(DIR, 'm15-cpo-dashboard.png'), fullPage: true });
}

section('2. NAVIGATION - every sidebar link resolves');

{
  const { page } = cpo;
  const links = await page.locator('nav[aria-label="Main"] a').evaluateAll((els) =>
    els.map((el) => ({ href: el.getAttribute('href'), label: el.textContent.trim() })),
  );

  /* Group headers carry `uppercase`, and innerText returns the RENDERED text - so a
   * case-sensitive check fails on "OPERATIONS". Compare case-insensitively. */
  const navText = (await page.locator('nav[aria-label="Main"]').innerText()).toLowerCase();
  chk('the sidebar has the expected groups', true,
    ['operations', 'management', 'billing', 'insights'].every((g) => navText.includes(g)));

  let broken = [];
  for (const link of links) {
    const res = await page.request.get(`${APP}${link.href}`);
    if (res.status() >= 400) broken.push(`${link.label} (${link.href}) -> ${res.status()}`);
  }
  chk('every sidebar link resolves to a real page', [], broken);

  /* Click-through to the pages the brief names explicitly. */
  for (const [label, expectPath] of [
    ['Stations', '/stations'],
    ['Chargers', '/chargers'],
    ['Charging sessions', '/sessions'],
    ['Analytics', '/analytics'],
    ['Station map', '/map'],
    ['Support', '/complaints'],
  ]) {
    /* Role-based, exact. The Module 15 polish pass wrapped nav labels in a <span> beside an
     * icon, so `a:text-is(...)` no longer matches the anchor's OWN text. The accessible name
     * is still exactly the label (the icon is aria-hidden), and asking for that is both more
     * robust to markup and closer to what a user actually perceives. */
    await page.getByRole('link', { name: label, exact: true }).first().click();
    await page.waitForTimeout(1400);
    chk(`dashboard -> ${label}`, true, page.url().includes(expectPath));
    chk(`  and the shell persists on ${label}`, true,
      (await page.locator('nav[aria-label="Main"]').count()) === 1);
  }

  await page.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
}

/* =========================================================================
 * 3. OPERATOR - the Module 13 boundary, reused
 * ========================================================================= */

section('3. OPERATOR - no revenue anywhere, no Billing group');

const operator = await signIn('ops@livanto.local', 'Ops@12345');
{
  const { page, errors } = operator;
  await waitForText(page, 'Charging now');
  const text = (await bodyText(page)).toLowerCase();
  const labels = await navLabels(page);

  chk('no uncaught page errors', [], errors);
  chk('operator sees the operations dashboard', true, text.includes('charging now'));
  chk('operator sees stations and chargers', true, text.includes('stations') && text.includes('chargers'));

  chk('NO revenue-today card', false, text.includes('revenue today'));
  chk('NO awaiting-payment card', false, text.includes('awaiting payment'));
  const opNav = (await page.locator('nav[aria-label="Main"]').innerText()).toLowerCase();
  chk('NO Billing group in the sidebar', false, opNav.includes('billing'));
  chk('NO Payments link', false, labels.includes('Payments'));
  chk('NO Users link either', false, labels.includes('Users'));

  chk('but they DO get the operational links', true,
    labels.includes('Stations') && labels.includes('Chargers') && labels.includes('Live operations'));
  chk('and analytics, which omits revenue server-side', true, labels.includes('Analytics'));

  /* The boundary is the SERVER's, not the menu's. */
  const direct = await api('GET', '/analytics/revenue', await tokenFor('ops@livanto.local', 'Ops@12345'));
  chk('and the API refuses revenue directly - hiding is not the control', 403, direct.status);

  await page.screenshot({ path: path.join(DIR, 'm15-operator-dashboard.png'), fullPage: true });
  await operator.context.close();
}

/* =========================================================================
 * 4. DRIVER - unchanged, and no admin shell
 * ========================================================================= */

section('4. DRIVER - lands on their own page, with no admin chrome');

const driverEmail = process.env.M15_DRIVER || '';
if (driverEmail) {
  const driver = await signIn(driverEmail, 'M15Demo12345');
  const { page, errors } = driver;
  await waitForText(page, 'Welcome,');
  const text = (await bodyText(page)).toLowerCase();

  chk('no uncaught page errors', [], errors);
  chk('NO admin sidebar for a driver', 0, await page.locator('nav[aria-label="Main"]').count());
  chk('driver still gets their own welcome page', true, text.includes('welcome,'));
  chk('and their own links', true, text.includes('start charging') && text.includes('my vehicles'));
  chk('and NOT the operations cards', false, text.includes('charging now') && text.includes('open complaints'));

  const driverToken = await tokenFor(driverEmail, 'M15Demo12345');
  chk('the API refuses a driver the analytics the dashboard runs on', 403,
    (await api('GET', '/analytics/overview', driverToken)).status);

  await page.screenshot({ path: path.join(DIR, 'm15-driver-home.png'), fullPage: true });
  await driver.context.close();
} else {
  console.log('  SKIP  no M15_DRIVER env var supplied');
}

/* =========================================================================
 * 5. LIVE - a real OCPP session, with the dashboard already open
 * ========================================================================= */

section('5. LIVE UPDATE - a real charging session, no reload');

{
  const { page } = cpo;
  await page.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const before = await bodyText(page);
  chk('the dashboard starts with no session in progress', true, before.includes('No sessions in progress'));

  /* Drive a genuine charge over the OCPP WebSocket while the page sits untouched. */
  const su = await tokenFor('admin@evcms.local', 'Admin@12345');
  const stations = (await apiMust('GET', '/stations?limit=50', cpoToken)).items;

  let target = null;
  for (const station of stations) {
    const chargers = (await apiMust('GET', `/chargers?stationId=${station.id}`, cpoToken)).items;
    for (const charger of chargers) {
      const { connectors } = await apiMust('GET', `/chargers/${charger.id}/connectors`, cpoToken);
      if (connectors?.length) { target = { charger, connector: connectors[0] }; break; }
    }
    if (target) break;
  }

  const { authToken } = await apiMust('POST', `/chargers/${target.charger.id}/token`, su);
  const creds = Buffer.from(`${target.charger.ocppId}:${authToken}`).toString('base64');

  const pending = new Map();
  const inbound = [];
  const ws = new WebSocket(`${WS_BASE}/${encodeURIComponent(target.charger.ocppId)}`, {
    headers: { Authorization: `Basic ${creds}` },
  });
  await new Promise((res) => { ws.on('open', res); ws.on('error', res); });
  ws.on('message', (d) => {
    const f = JSON.parse(d.toString());
    if (f[0] === 3 || f[0] === 4) { const p = pending.get(f[1]); if (p) { pending.delete(f[1]); p(f); } }
    else if (f[0] === 2) inbound.push({ uid: f[1], action: f[2], payload: f[3] });
  });
  const send = (action, payload = {}) => {
    const uid = `live-${Math.random().toString(36).slice(2)}`;
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout ${action}`)), 8000);
      pending.set(uid, (f) => { clearTimeout(t); res(f); });
      ws.send(JSON.stringify([2, uid, action, payload]));
    });
  };
  const waitFor = async (action, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const f = inbound.find((m) => m.action === action);
      if (f) { inbound.splice(inbound.indexOf(f), 1); return f; }
      await sleep(40);
    }
    return null;
  };

  await send('BootNotification', { chargePointVendor: 'Test', chargePointModel: 'LIVE' });
  await send('StatusNotification', { connectorId: target.connector.connectorNumber, status: 'Available', errorCode: 'NoError' });
  await sleep(1500);

  /*
   * NOT asserting "went online" here. Module 8's D7 emits connectivity ON TRANSITION ONLY, so
   * if the charger was already marked online this reconnect correctly emits nothing. Asserting
   * it would be testing a premise this script does not control. The connector-status and
   * session assertions below prove the same live pipeline, on events that always fire.
   */

  /* Start a charge as a funded driver. */
  const driverToken = await tokenFor(driverEmail, 'M15Demo12345');
  const startReq = api('POST', '/charging/sessions', driverToken, { connectorId: target.connector.id });
  const cmd = await waitFor('RemoteStartTransaction');
  ws.send(JSON.stringify([3, cmd.uid, { status: 'Accepted' }]));
  await startReq;

  await send('Authorize', { idTag: cmd.payload.idTag });
  const st = await send('StartTransaction', {
    connectorId: target.connector.connectorNumber, idTag: cmd.payload.idTag,
    meterStart: 0, timestamp: new Date().toISOString(),
  });
  await send('StatusNotification', { connectorId: target.connector.connectorNumber, status: 'Charging', errorCode: 'NoError' });
  chk('the ACTIVE SESSIONS table populated with NO reload', true,
    await waitForTextGone(page, 'No sessions in progress'));
  chk('and the connector status change was announced live', true,
    await waitForText(page, 'just became'));

  await page.screenshot({ path: path.join(DIR, 'm15-live-session.png'), fullPage: true });

  /* Energy ticks up over the same open page. */
  await send('MeterValues', {
    connectorId: target.connector.connectorNumber, transactionId: st[2].transactionId,
    energyWh: 2500, timestamp: new Date().toISOString(),
  });
  chk('the meter update reached the open table, still with no reload', true,
    await waitForText(page, '2.500 kWh'));

  /* Finish it, and the row must leave the "active" table on its own. */
  /* The CALLRESULT for StopTransaction can lag behind the state change it causes, so the
   * reply is not awaited — the assertion below is about the BROWSER, not the acknowledgement. */
  send('StopTransaction', {
    transactionId: st[2].transactionId, meterStop: 3000,
    reason: 'Remote', timestamp: new Date().toISOString(),
  }).catch(() => {});
  send('StatusNotification', {
    connectorId: target.connector.connectorNumber, status: 'Available', errorCode: 'NoError',
  }).catch(() => {});

  chk('a COMPLETED session leaves the active table, still without reload', true,
    await waitForText(page, 'No sessions in progress', 20000));

  try { ws.close(); } catch {}
  await cpo.context.close();
}

/* =========================================================================
 * 6. RESPONSIVE
 * ========================================================================= */

section('6. RESPONSIVE - drawer on a phone');

{
  const mobile = await signIn('cpo@livanto.local', 'Cpo@12345', { width: 390, height: 844 });
  const { page } = mobile;

  chk('the desktop rail is hidden on a phone', 0,
    await page.locator('nav[aria-label="Main"]:visible').count());

  const doc = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  chk('no horizontal scroll on a phone', true, doc.sw <= doc.cw + 1);

  await page.locator('button[aria-label="Open navigation"]').click();
  await page.waitForTimeout(600);
  chk('the drawer opens', 1, await page.locator('nav[aria-label="Main"]:visible').count());

  /* On a phone the hidden desktop rail AND the open drawer are both in the DOM, so the
   * locator must be scoped to the VISIBLE one or Playwright refuses on strict mode. */
  await page.locator('nav[aria-label="Main"]:visible').getByRole('link', { name: 'Stations', exact: true }).click();
  await page.waitForTimeout(1600);
  chk('tapping a link navigates', true, page.url().includes('/stations'));
  chk('and the drawer closed itself on navigation', 0,
    await page.locator('nav[aria-label="Main"]:visible').count());

  await page.screenshot({ path: path.join(DIR, 'm15-mobile.png'), fullPage: true });
  await mobile.context.close();
}

await browser.close();

console.log(`\n================ MODULE 15 BROWSER: ${passed} passed, ${failed} failed ================`);
console.log(`screenshots in ${DIR}`);
if (fails.length) { console.log('\nFailures:'); for (const f of fails) console.log(`  - ${f}`); }
process.exit(failed === 0 ? 0 : 1);
