/**
 * The test runner.
 *
 * Runs every API suite in order, collects each one's pass/fail count, and prints a single
 * report at the end — including a comparison against the EXPECTED TOTAL, so a suite that
 * silently stops running is visible as a shrink rather than as a still-green run.
 *
 *   node tests/run.mjs                    every API suite
 *   node tests/run.mjs auth wallet        just those
 *   node tests/run.mjs --list             what exists
 *
 * WHAT IT NEEDS RUNNING:
 *   - the backend on $BASE (default http://localhost:5000/api/v1)
 *   - that backend started with OCPP_OFFLINE_AFTER_SECONDS=5. The ocpp suite holds
 *     heartbeats for 9s to prove a silent charger is marked offline; the 90s production
 *     default cannot be observed in that window, and the suite reports two failures that
 *     look like broken disconnect handling rather than a missing environment variable.
 *   - `npm run build` in backend/  (money, settlement-race and arrears import compiled output)
 *   - MongoDB reachable via backend/.env
 *
 * WHAT IT DOES NOT COVER: the browser suites in tests/browser, which need a frontend and a
 * headless Chromium. Those are run separately and are listed at the end of the report so
 * their absence from a run is never mistaken for them passing.
 */

import { spawn } from 'child_process';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.join(HERE, 'api');

/*
 * THE SIGNING SECRET HAS TO MATCH THE SERVER'S, or every payment suite dies.
 *
 * The suites mint real Razorpay signatures — `HMAC(order|payment, secret)` — precisely so the
 * server's real verification path is exercised instead of a test-only bypass. That only works
 * if both sides hold the same secret. The server reads `RAZORPAY_KEY_SECRET` from
 * `backend/.env` and falls back to a stub; the suites read `RZP_SECRET` and fall back to the
 * same stub. Set one and not the other and the two fall back differently: every signature is
 * valid, and every one is rejected.
 *
 * That failure is deeply misleading — `POST /wallet/recharge/verify -> 400` looks like broken
 * payment code, not a mismatched key, and it takes out wallet, analytics and failure together.
 * So rather than document a step everyone forgets, adopt the server's own secret here.
 */
if (!process.env.RZP_SECRET) {
  const envPath = path.join(HERE, '..', 'backend', '.env');

  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const match = /^\s*RAZORPAY_KEY_SECRET\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;

      // Strip surrounding quotes if the value has them; leave the value itself alone.
      const value = match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
      if (value) process.env.RZP_SECRET = value;
      break;
    }
  }
}

/**
 * Suite order, and the count each one is expected to produce.
 *
 * THE EXPECTED COUNTS ARE THE POINT. Every module in this project was signed off against a
 * specific number, and the running total is how a dropped or silently-skipped suite gets
 * caught. A run that reports "all green" with fewer checks than last time is not green.
 */
const SUITES = [
  ['foundation', 39, 'Module 0 — health, error envelope, headers, CORS'],
  ['money', 25, 'Module 9 — money arithmetic (in-process, needs backend build)'],
  ['auth', 36, 'Module 1 — authentication & RBAC'],
  ['company', 82, 'Module 2 — companies & isolation'],
  ['user', 102, 'Module 3 — users & vehicles'],
  ['station', 87, 'Module 4 — stations'],
  ['charger', 100, 'Module 5 — chargers & connectors'],
  ['multiconnector', 21, 'Module 5 — multi-connector chargers'],
  ['ocpp', 83, 'Module 6 — OCPP gateway (+2: Module 16 connector-release contract)'],
  ['fault', 48, 'Module 6 — charge-point vs connector faults (OCPP connectorId 0)'],
  ['session', 118, 'Module 7 — charging sessions'],
  ['realtime', 49, 'Module 8 — Socket.IO monitoring'],
  ['tariff', 73, 'Module 9 — tariffs & pricing'],
  ['arrears', 20, 'Module 10 — arrears: charging on credit is refused'],
  ['wallet', 83, 'Module 10 — wallet & payments'],
  ['settlement-race', 20, 'Module 10 — settlement concurrency (in-process)'],
  ['complaint', 112, 'Module 11 — complaints'],
  ['notification', 69, 'Module 12 — notifications'],
  ['analytics', 117, 'Module 13 — analytics'],
  ['map', 74, 'Module 14 — station map'],
  ['dashboard', 24, 'Module 15 — dashboard data contract'],
  /* Module 16 — cross-cutting matrices. These deliberately sit LAST: they exercise every
     module at once, so a failure here after everything above is green points at an
     interaction rather than at any single module. */
  ['security-matrix', 55, 'Module 16 — tampering across every resource and channel'],
  ['integrity', 37, 'Module 16 — reference chains and live-data consistency'],
  ['failure', 34, 'Module 16 — malformed input, lost chargers, failed payments'],
];

const EXPECTED_TOTAL = SUITES.reduce((sum, [, n]) => sum + n, 0);

const BROWSER_SUITES = [
  ['browser/walkthrough.mjs', 46, 'Module 14 — map UI'],
  ['browser/dashboard.mjs', 58, 'Module 15 — dashboard UI + live OCPP'],
];

/* -------------------------------------------------------------------------- */

const args = process.argv.slice(2);

if (args.includes('--list')) {
  console.log('\nAPI suites:');
  for (const [name, count, desc] of SUITES) {
    console.log(`  ${name.padEnd(18)} ${String(count).padStart(4)}  ${desc}`);
  }
  console.log(`\n  expected total: ${EXPECTED_TOTAL}`);
  console.log('\nBrowser suites (run separately — need the frontend running):');
  for (const [file, count, desc] of BROWSER_SUITES) {
    console.log(`  ${file.padEnd(28)} ${String(count).padStart(4)}  ${desc}`);
  }
  console.log();
  process.exit(0);
}

const only = args.filter((a) => !a.startsWith('--'));
const selected = only.length > 0 ? SUITES.filter(([n]) => only.includes(n)) : SUITES;

if (selected.length === 0) {
  console.error(`No suite matched: ${only.join(', ')}. Try --list.`);
  process.exit(1);
}

const present = new Set(readdirSync(API_DIR).map((f) => f.replace('.test.mjs', '')));
const missing = selected.filter(([n]) => !present.has(n)).map(([n]) => n);
if (missing.length > 0) {
  console.error(`Missing suite files: ${missing.join(', ')}`);
  process.exit(1);
}

/** Run one suite and pull its own summary line out of the output. */
function runSuite(name) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(API_DIR, `${name}.test.mjs`)], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (d) => { output += d.toString(); });
    child.stderr.on('data', (d) => { output += d.toString(); });

    child.on('close', (code) => {
      /* Each suite prints its own "N passed, M failed" — parsing it rather than re-counting
         keeps the runner from becoming a second source of truth about what passed. */
      const match = [...output.matchAll(/(\d+)\s+passed,\s*(\d+)\s+failed/gi)].pop();
      resolve({
        name,
        code,
        passed: match ? Number(match[1]) : 0,
        failed: match ? Number(match[2]) : 0,
        parsed: Boolean(match),
        output,
      });
    });
  });
}

console.log(`\n${'='.repeat(74)}`);
console.log(`  EV-CMS — ${selected.length} API suite${selected.length === 1 ? '' : 's'}`);
console.log(`  ${process.env.BASE || 'http://localhost:5000/api/v1'}`);
console.log('='.repeat(74));

const results = [];
const started = Date.now();

for (const [name, expected, desc] of selected) {
  process.stdout.write(`  ${name.padEnd(18)} `);
  const r = await runSuite(name);
  results.push({ ...r, expected, desc });

  if (!r.parsed) {
    console.log(`ERROR   suite produced no summary (exit ${r.code})`);
  } else if (r.failed > 0) {
    console.log(`FAIL    ${r.passed} passed, ${r.failed} FAILED`);
  } else if (r.passed !== expected) {
    console.log(`DRIFT   ${r.passed} passed (expected ${expected})`);
  } else {
    console.log(`ok      ${r.passed}`);
  }
}

const totalPassed = results.reduce((s, r) => s + r.passed, 0);
const totalFailed = results.reduce((s, r) => s + r.failed, 0);
const expectedForSelection = selected.reduce((s, [, n]) => s + n, 0);
const broken = results.filter((r) => !r.parsed);
const drifted = results.filter((r) => r.parsed && r.failed === 0 && r.passed !== r.expected);

console.log('='.repeat(74));
console.log(`  passed   ${totalPassed}`);
console.log(`  failed   ${totalFailed}`);
console.log(`  expected ${expectedForSelection}${only.length === 0 ? `  (full estate: ${EXPECTED_TOTAL})` : ''}`);
console.log(`  elapsed  ${((Date.now() - started) / 1000).toFixed(1)}s`);

if (broken.length > 0) {
  console.log(`\n  SUITES THAT DID NOT REPORT: ${broken.map((r) => r.name).join(', ')}`);
  for (const r of broken) {
    console.log(`\n  --- ${r.name} (exit ${r.code}) ---`);
    console.log(r.output.split('\n').slice(-15).map((l) => `    ${l}`).join('\n'));
  }
}

if (drifted.length > 0) {
  console.log('\n  COUNT DRIFT (green, but not the expected number — a check was added or lost):');
  for (const r of drifted) console.log(`    ${r.name}: ${r.passed} vs ${r.expected} expected`);
}

if (totalFailed > 0) {
  console.log('\n  FAILURES:');
  for (const r of results.filter((x) => x.failed > 0)) {
    console.log(`\n  --- ${r.name} ---`);
    console.log(
      r.output.split('\n').filter((l) => /FAIL/i.test(l)).slice(0, 12).map((l) => `  ${l}`).join('\n'),
    );
  }
}

console.log('\n  Browser suites are NOT part of this run:');
for (const [file, count, desc] of BROWSER_SUITES) {
  console.log(`    ${file.padEnd(28)} ${String(count).padStart(4)}  ${desc}`);
}
console.log('    run them with: node tests/browser/<suite>.mjs  (frontend must be running)\n');

process.exit(totalFailed === 0 && broken.length === 0 ? 0 : 1);
