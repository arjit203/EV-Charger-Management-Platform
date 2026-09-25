/* The REAL Razorpay test-mode Checkout, driven in the browser: wallet page -> Checkout overlay ->
 * Netbanking -> the test bank's "Success" -> our verify endpoint -> balance credited once.
 * Needs RAZORPAY_KEY_ID/SECRET (rzp_test_…) in backend/.env and internet access. Screenshots go
 * to $SHOTS (default: this folder). Razorpay owns the overlay's markup, so selectors are loose. */
import { chromium } from 'playwright';

const APP = process.env.APP_URL || 'http://localhost:3000';
const API = process.env.API_URL || 'http://localhost:5000/api/v1';
const SHOTS = process.env.SHOTS || new URL('.', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d !== '' ? '  — ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, p, t, b) => (await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined })).json();

const token = (await api('POST', '/auth/login', null, { email: 'priya@driver.local', password: 'Driver@12345' })).data.token;
const before = (await api('GET', '/wallet', token)).data.wallet.balancePaise;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const shot = (name) => page.screenshot({ path: `${SHOTS}/rzp-${name}.png` }).catch(() => {});
try {
  await page.goto(APP + '/login');
  await page.fill('input[name="email"]', 'priya@driver.local'); await page.fill('input[name="password"]', 'Driver@12345');
  await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await page.goto(APP + '/wallet', { waitUntil: 'load' });
  await page.locator('input[type="number"]').fill('100');
  const add = page.getByRole('button', { name: 'Add money' });
  await add.waitFor({ state: 'visible' });
  for (let i = 0; i < 20 && (await add.isDisabled()); i++) await sleep(500);
  ok('Checkout script loaded (Add money enabled)', !(await add.isDisabled()));
  await add.click();

  let frame = null;
  for (let i = 0; i < 40 && !frame; i++) {
    frame = page.frames().find((f) => f !== page.mainFrame() && /razorpay\.com/.test(f.url()) && !/checkout\.js/.test(f.url())) ?? null;
    if (!frame) await sleep(500);
  }
  ok('Razorpay Checkout overlay opens', !!frame, frame?.url().slice(0, 60));
  await sleep(4000); await shot('1-open');

  // Newer Checkout may ask for a phone number first.
  // The overlay nests frames; use whichever one actually holds the Checkout form.
  for (let i = 0; i < 20; i++) {
    const hit = [];
    for (const f of page.frames()) if (await f.getByText(/netbanking/i).count().catch(() => 0)) hit.push(f);
    if (hit.length) { frame = hit[hit.length - 1]; break; }
    await sleep(500);
  }
  // The contact step is its own modal, in whichever frame shows "Contact details".
  let contactFrame = null;
  for (const f of page.frames()) if (await f.getByPlaceholder('Mobile number', { exact: true }).count().catch(() => 0)) contactFrame = f;
  console.log('      contact step present:', !!contactFrame);
  if (contactFrame) {
    const mobile = contactFrame.getByPlaceholder('Mobile number', { exact: true });
    await mobile.click();
    await mobile.pressSequentially('9123456780', { delay: 60 });
    await contactFrame.getByRole('button', { name: /^continue$/i }).first().click();
    await sleep(3000);
  }
  await shot('2-methods');

  // Work in whichever frame now holds the method list (it can move after the contact step).
  const frameWith = async (re) => { for (const f of page.frames()) if (await f.getByText(re).count().catch(() => 0)) return f; return frame; };
  frame = await frameWith(/^Netbanking$/);
  await frame.getByText(/^Netbanking$/).first().click({ timeout: 15000 });
  await sleep(2500); await shot('3-banks');
  // Any healthy bank works in test mode; skip ones Razorpay flags as "facing issues".
  frame = await frameWith(/Canara Bank/);
  const bank = frame.getByText(/^(Canara Bank|IDBI|Punjab National Bank)/).first();
  const popupPromise = ctx.waitForEvent('page', { timeout: 30000 }).catch(() => null);
  await bank.click({ timeout: 15000 });
  await sleep(1500);
  const pay = frame.getByRole('button', { name: /^pay/i }).first();
  if (await pay.count()) await pay.click().catch(() => {});
  const popup = await popupPromise;
  ok('test bank page opens', !!popup, popup?.url().slice(0, 80));
  if (popup) {
    await popup.waitForLoadState('load'); await sleep(1500);
    await popup.screenshot({ path: `${SHOTS}/rzp-4-bank.png` }).catch(() => {});
    await popup.getByRole('button', { name: /success/i }).first().click({ timeout: 15000 });
  }

  let after = before;
  for (let i = 0; i < 40 && after === before; i++) { await sleep(1000); after = (await api('GET', '/wallet', token)).data.wallet.balancePaise; }
  await shot('5-after');
  ok('wallet credited ₹100 exactly once via real Checkout -> verify', after - before === 10000, `${before} -> ${after}`);
  await sleep(3000);
  const again = (await api('GET', '/wallet', token)).data.wallet.balancePaise;
  ok('no second credit (handler + webhook/sweeper do not double up)', again === after, `${after} -> ${again}`);
  const tx = (await api('GET', '/wallet/transactions?limit=3', token)).data.items[0];
  // (The link to the provider payment is server-side; the public ledger row does not expose it.)
  ok('newest ledger row is the ₹100 recharge', tx?.type === 'recharge' && tx?.amountPaise === 10000, `${tx?.type} ${tx?.amountPaise}p`);
  ok('wallet page shows the new balance', (await page.textContent('body')).includes(`₹${(after / 100).toFixed(2)}`));
} catch (e) { ok('script error', false, e.message.split('\n')[0]); await shot('error'); }
finally {
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
}
