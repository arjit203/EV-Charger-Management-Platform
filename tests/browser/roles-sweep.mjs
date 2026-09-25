/* Audit sweep: every role logs in through the real form, visits every page on its menu (plus one
 * detail page per list), and we record console errors, page exceptions and failed API calls. */
import { chromium } from 'playwright';

const APP = process.env.APP_URL || 'http://localhost:3000';
const ROLES = {
  super_admin: ['admin@evcms.local', 'Admin@12345', ['/dashboard', '/monitor', '/sessions', '/stations', '/chargers', '/map', '/companies', '/users', '/tariffs', '/complaints', '/payments', '/analytics', '/notifications', '/profile']],
  cpo_admin: ['cpo@livanto.local', 'Cpo@12345', ['/dashboard', '/monitor', '/sessions', '/stations', '/chargers', '/map', '/my-company', '/users', '/tariffs', '/complaints', '/payments', '/analytics', '/notifications', '/profile']],
  operator: ['ops@livanto.local', 'Ops@12345', ['/dashboard', '/monitor', '/sessions', '/stations', '/chargers', '/map', '/my-company', '/complaints', '/analytics', '/notifications', '/profile']],
  driver: ['ananya@driver.local', 'Driver@12345', ['/dashboard', '/charge', '/map', '/sessions', '/wallet', '/my-vehicles', '/complaints', '/complaints/new', '/notifications', '/profile']],
};
const DETAIL_FROM = { '/sessions': '/sessions/', '/stations': '/stations/', '/chargers': '/chargers/', '/complaints': '/complaints/', '/tariffs': '/tariffs/', '/users': '/users/', '/companies': '/companies/' };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

const browser = await chromium.launch();
try {
  // Protected route without a session -> login.
  {
    const ctx = await browser.newContext(); const p = await ctx.newPage();
    await p.goto(APP + '/payments'); await p.waitForURL(/\/login/, { timeout: 15000 }).catch(() => {});
    ok('unauthenticated /payments redirects to /login', /\/login/.test(p.url()), p.url());
    await p.fill('input[name="email"]', 'ananya@driver.local'); await p.fill('input[name="password"]', 'wrong-password');
    await p.click('button[type="submit"]'); await p.waitForTimeout(2000);
    ok('bad credentials stay on /login with a message', /\/login/.test(p.url()) && /invalid|incorrect|wrong/i.test(await p.textContent('body')));
    await ctx.close();
  }

  for (const [role, [email, password, pages]] of Object.entries(ROLES)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    const problems = [];
    let current = '';
    p.on('console', (m) => { if (m.type() === 'error') problems.push(`${current} console: ${m.text().slice(0, 160)}`); });
    p.on('pageerror', (e) => problems.push(`${current} exception: ${e.message.slice(0, 160)}`));
    p.on('response', (r) => { if (r.url().includes('/api/v1/') && r.status() >= 400) problems.push(`${current} ${r.request().method()} ${r.url().replace(/.*\/api\/v1/, '')} -> ${r.status()}`); });

    await p.goto(APP + '/login');
    await p.fill('input[name="email"]', email); await p.fill('input[name="password"]', password);
    await p.click('button[type="submit"]');
    await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 }).catch(() => {});
    ok(`${role}: login through the form`, !p.url().includes('/login'), p.url());

    for (const path of pages) {
      current = path;
      const before = problems.length;
      await p.goto(APP + path, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => problems.push(`${path} nav: ${e.message.slice(0, 80)}`));
      await p.waitForTimeout(600);
      const body = await p.textContent('body');
      const stuck = /Loading…|Loading\.\.\./.test(body) && body.length < 400;
      ok(`${role}: ${path}`, problems.length === before && !stuck, problems.slice(before).join(' | ') + (stuck ? ' stuck loading' : ''));

      if (DETAIL_FROM[path]) {
        const href = await p.$$eval(`a[href^="${DETAIL_FROM[path]}"]`, (as) => as.map((a) => a.getAttribute('href')).find((h) => h && !h.endsWith('/new')));
        if (href) {
          current = href; const b2 = problems.length;
          await p.goto(APP + href, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
          await p.waitForTimeout(600);
          const unavailable = /isn't available|Couldn't load/.test(await p.textContent('body'));
          ok(`${role}:   ${href.replace(/[0-9a-f]{24}/, ':id')}`, problems.length === b2 && !unavailable, problems.slice(b2).join(' | ') + (unavailable ? ' shows LoadError' : ''));
        }
      }
    }
    // Forbidden page for this role: API must refuse, page must not crash.
    if (role === 'driver' || role === 'operator') {
      current = '/payments(forbidden)'; const b3 = problems.length;
      await p.goto(APP + '/payments', { waitUntil: 'networkidle' }).catch(() => {});
      await p.waitForTimeout(800);
      const exc = problems.slice(b3).filter((x) => x.includes('exception'));
      ok(`${role}: forbidden /payments does not crash`, exc.length === 0, `url=${p.url()} ${problems.slice(b3).join(' | ')}`);
    }
    // Logout
    const signOut = p.getByRole('button', { name: /sign out/i }).first();
    if (await signOut.count()) {
      await signOut.click(); await p.waitForTimeout(1500);
      await p.goto(APP + '/dashboard'); await p.waitForTimeout(2000);
      ok(`${role}: sign out -> protected page bounces to login`, /\/login/.test(p.url()), p.url());
    } else ok(`${role}: sign out button present`, false);
    await ctx.close();
  }
} finally {
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
}
