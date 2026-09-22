/* MODULE 14 - the manual walkthrough, driven by a real browser.
 *
 * Everything here is a thing no API test can check: whether a marker actually renders,
 * whether clicking one selects the right row, whether the layout survives a phone viewport.
 * Playwright lives in the scratchpad only - it is NOT a project dependency.
 *
 * Screenshots are written beside this file so the rendering can be eyeballed afterwards.
 */

import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const APP = 'http://localhost:3000';

let passed = 0, failed = 0;
const fails = [];
function chk(label, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (ok) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`); }
}
const section = (t) => console.log(`\n--- ${t} ---`);

const browser = await chromium.launch();

async function signIn(email, password, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });

  /* WAIT FOR HYDRATION BEFORE TOUCHING THE FORM. Without this the click lands on
   * server-rendered HTML whose React onSubmit is not attached yet, so the browser does a
   * plain GET and the credentials end up in the query string instead of being posted. */
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1200);

  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await Promise.all([
    page.waitForURL('**/dashboard', { timeout: 45000 }),
    page.click('button[type="submit"]'),
  ]);
  return { context, page, errors };
}

/* Markers are divIcons: Leaflet wraps each in .leaflet-marker-icon. */
const markerCount = (page) => page.locator('.leaflet-marker-icon').count();
const rowTexts = async (page) => (await page.locator('ul li button').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());

console.log('\n================ MODULE 14 - BROWSER WALKTHROUGH ================');

/* ========================================================================
 * STAFF
 * ======================================================================== */

section('STAFF (cpo@livanto.local) - the administrative map');

const staff = await signIn('cpo@livanto.local', 'Cpo@12345');
{
  const { page, errors } = staff;

  await page.goto(`${APP}/map`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.leaflet-container', { timeout: 25000 });
  await page.waitForTimeout(2500); // let tiles and markers settle

  chk('the map container rendered', true, await page.locator('.leaflet-container').isVisible());
  chk('no uncaught page errors while the map mounted', [], errors);

  const rows = await rowTexts(page);

  /* Livanto already had seeded stations before Module 14, so the totals are asserted
   * RELATIVE to what is listed rather than against a hardcoded number: every station is
   * listed, and exactly one of them - the site whose coordinates were removed directly in
   * the database - is missing from the map. */
  chk('all four Module 14 demo stations are listed', true,
    ['Noida Sector 62 Hub', 'Ghaziabad Vaishali Point', 'Gurgaon Cyber Hub Depot', 'Faridabad Unmapped Site']
      .every((n) => rows.some((r) => r.includes(n))));
  chk('exactly one listed station is missing from the map', rows.length - 1, await markerCount(page));
  chk('the unmapped station is STILL in the list', true,
    rows.some((r) => r.includes('Faridabad Unmapped Site')));
  chk('and it carries the warning badge', true,
    rows.some((r) => r.includes('Faridabad Unmapped Site') && r.includes('Location not set')));
  chk('the count line states what is not mapped', true,
    (await page.locator('main').innerText()).includes('1 without coordinates'));

  chk('availability is shown on the Noida row', true,
    rows.some((r) => r.includes('Noida Sector 62 Hub') && r.includes('3/5 available')));

  await page.screenshot({ path: path.join(DIR, 'staff-map.png'), fullPage: false });

  /* ---- map -> list ----
   * Done BEFORE any selection, while `fitBounds` still has every marker on screen. Running
   * it after a `flyTo` was the original failure: the map had panned and Playwright reported
   * "element is outside of the viewport". Clicking by `data-station-id` also removes the
   * guesswork of iterating marker indexes. */
  section('MARKER -> LIST + POPUP');

  const noidaRow = page.locator('ul li button', { hasText: 'Noida Sector 62 Hub' });
  /* The marker span carries its own aria-label, so it can be addressed by name. */
  const marker = page.locator('[aria-label="Noida Sector 62 Hub"]').first();
  chk('a marker exists for the Noida station', 1, await marker.count());

  await marker.click({ force: true });
  await page.waitForTimeout(1200);

  const popup = await page.locator('.leaflet-popup-content').innerText().catch(() => '');
  chk('clicking a marker opens a popup naming the station', true, popup.includes('Noida Sector 62 Hub'));
  chk('the popup shows the address', true, popup.includes('C-56 Sector 62'));
  chk('the popup shows status', true, popup.toLowerCase().includes('active'));
  chk('the popup shows availability as 3 of 5', true, popup.includes('3') && popup.includes('5'));
  chk('the popup shows the station code for staff', true, popup.includes('MAP-NOI-01'));
  chk('and the matching list row became selected', 'true', await noidaRow.getAttribute('aria-current'));

  await page.screenshot({ path: path.join(DIR, 'staff-popup.png') });

  /* ---- list -> map ---- */
  section('LIST ITEM -> MAP');
  await page.locator('ul li button', { hasText: 'Gurgaon Cyber Hub Depot' }).click();
  await page.waitForTimeout(1400);

  chk('the clicked row becomes the selected one', 'true',
    await page.locator('ul li button', { hasText: 'Gurgaon Cyber Hub Depot' }).getAttribute('aria-current'));
  chk('the previously selected row is no longer selected', 'false',
    await noidaRow.getAttribute('aria-current'));
  chk('the detail panel shows that station', true,
    (await page.locator('main').innerText()).includes('DLF Cyber City Phase 2'));
  chk('the detail panel shows its coordinates', true,
    (await page.locator('main').innerText()).includes('28.4950'));
  chk('staff get an "Open station" link through to the admin record', 1,
    await page.locator('a', { hasText: 'Open station' }).count());

  await page.screenshot({ path: path.join(DIR, 'staff-selected.png') });

  /* ---- search ---- */
  section('SEARCH');
  await page.fill('input[placeholder="Name, code or address"]', 'Ghaziabad');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2000);

  const filtered = await rowTexts(page);
  chk('search narrows the list to one station', 1, filtered.length);
  chk('and it is the right one', true, filtered[0].includes('Ghaziabad Vaishali Point'));
  chk('and the map is narrowed to one marker too', 1, await markerCount(page));

  await page.fill('input[placeholder="Name, code or address"]', 'zzzz-nothing');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2000);
  chk('a search with no matches shows a message, not a broken pane', true,
    (await page.locator('main').innerText()).includes('No stations match those filters'));
  chk('and zero markers', 0, await markerCount(page));

  await staff.context.close();
}

/* ========================================================================
 * DRIVER
 * ======================================================================== */

section('DRIVER - cross-company discovery, and what must not be on screen');

const driver = await signIn('mapdriver@test.local', 'MapDriver12345');
{
  const { page, errors } = driver;

  await page.goto(`${APP}/map`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.leaflet-container', { timeout: 25000 });
  await page.waitForTimeout(2500);

  chk('the driver map renders', true, await page.locator('.leaflet-container').isVisible());
  chk('no uncaught page errors', [], errors);

  const body = (await page.locator('main').innerText());
  const rows = await rowTexts(page);

  chk('the driver sees the Livanto stations', true, rows.some((r) => r.includes('Noida Sector 62 Hub')));
  chk('AND the rival company station - this is the cross-company read', true,
    rows.some((r) => r.includes('Sharma Dwarka Charge Park')));

  chk('no company name appears anywhere on the page', false,
    body.includes('Livanto') || body.includes('Sharma Energy'));
  chk('no station code appears anywhere on the page', false, body.includes('MAP-NOI-01'));
  chk('no "Open station" admin link for a driver', 0, await page.locator('a', { hasText: 'Open station' }).count());
  chk('no status filter is offered to a driver', 0, await page.locator('select').count());

  /* The Faridabad site is ACTIVE - only its coordinates were removed - so a driver does see
   * it, listed with the same "location not set" badge staff get, and absent from the map.
   * The rule is applied uniformly rather than hiding a record from drivers because of a
   * data-quality problem. (An INACTIVE station is a separate case, covered by the API suite.) */
  chk('the unmappable-but-active site is listed for a driver too', true,
    rows.some((r) => r.includes('Faridabad Unmapped Site')));
  chk('with the same location badge', true,
    rows.some((r) => r.includes('Faridabad Unmapped Site') && r.includes('Location not set')));
  chk('and it is excluded from the driver map as well', rows.length - 1, await markerCount(page));

  chk('the driver still gets availability', true,
    rows.some((r) => r.includes('Noida Sector 62 Hub') && r.includes('3/5 available')));

  await page.screenshot({ path: path.join(DIR, 'driver-map.png') });

  /* Popup must not leak the code either. */
  await page.locator('[aria-label="Noida Sector 62 Hub"]').first().click({ force: true });
  await page.waitForTimeout(1200);
  const popup = await page.locator('.leaflet-popup-content').innerText().catch(() => '');
  chk('a driver popup names the station', true, popup.length > 0);
  chk('and contains no station code', false, /MAP-[A-Z]{3}-\d{2}/.test(popup));

  await driver.context.close();
}

/* ========================================================================
 * RESPONSIVE
 * ======================================================================== */

section('RESPONSIVE - phone viewport, map first');

const mobile = await signIn('cpo@livanto.local', 'Cpo@12345', { width: 390, height: 844 });
{
  const { page } = mobile;

  await page.goto(`${APP}/map`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.leaflet-container', { timeout: 25000 });
  await page.waitForTimeout(2500);

  const mapBox = await page.locator('.leaflet-container').boundingBox();
  const listBox = await page.locator('ul li button').first().boundingBox();

  chk('the map is visible on a phone', true, Boolean(mapBox) && mapBox.height > 100);
  chk('the map sits ABOVE the list on a phone', true, Boolean(listBox) && mapBox.y < listBox.y);
  chk('the map does not overflow the viewport width', true, mapBox.width <= 390);

  const doc = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  chk('the page does not scroll horizontally', true, doc.scrollWidth <= doc.clientWidth + 1);

  await page.screenshot({ path: path.join(DIR, 'mobile-map.png'), fullPage: true });

  /* The list is collapsible on small screens. */
  /* VISIBILITY, not count. Tailwind's `hidden` is `display:none`, and the rows stay in the
   * DOM - so `count()` returns 6 either way and would have passed a broken toggle. */
  const toggle = page.locator('button', { hasText: 'Stations' }).first();
  const firstRow = page.locator('ul li button').first();

  chk('the list starts expanded on a phone', true, await firstRow.isVisible());
  await toggle.click();
  await page.waitForTimeout(600);
  chk('the list collapses on a phone', false, await firstRow.isVisible());
  await toggle.click();
  await page.waitForTimeout(600);
  chk('and expands again', true, await firstRow.isVisible());

  await mobile.context.close();
}

await browser.close();

console.log(`\n================ WALKTHROUGH: ${passed} passed, ${failed} failed ================`);
console.log(`screenshots in ${DIR}`);
if (fails.length) { console.log('\nFailures:'); for (const f of fails) console.log(`  - ${f}`); }
process.exit(failed === 0 ? 0 : 1);
