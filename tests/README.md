# Tests

**1,480 automated API checks across 24 suites, plus 104 browser checks across 2.**

These are executable HTTP, WebSocket and browser check scripts, not a unit-test framework —
stated plainly because it matters when reading the numbers. They drive a **real running
server**, a **real MongoDB**, real OCPP WebSocket frames and real HMAC signatures. Nothing is
mocked.

---

## Running them

```bash
# 1. build the backend — two suites import compiled output
cd backend && npm run build

# 2. start it
npm run dev

# 3. in another terminal
cd backend
npm test                  # every API suite
npm test auth wallet      # just those
npm run test:list         # what exists, and the expected count of each
npm run test:clean        # remove test data and sweep orphans
```

### If real Razorpay keys are configured

The payment suites sign with the stub secret by default. With real keys in `backend/.env`:

```bash
RZP_SECRET=<your RAZORPAY_KEY_SECRET> npm test
```

Without it, every signature is rejected — which is the system working correctly, and is itself
worth seeing once.

### Browser suites

They need the **frontend running too**, and a headless Chromium. Playwright is deliberately not
a project dependency; install it wherever you run these:

```bash
npm i playwright && npx playwright install chromium
node tests/browser/dashboard.mjs      # dashboard UI + a live OCPP session
node tests/browser/walkthrough.mjs    # map UI
```

---

## What the runner reports

```
  auth               ok      36
  realtime           DRIFT   48 passed (expected 49)
  wallet             FAIL    82 passed, 1 FAILED
==========================================================================
  passed   1460
  failed   0
  expected 1460
```

**`DRIFT` is the interesting one.** Every suite has a recorded expected count, so a suite that
silently stops contributing checks shows up even while green. A run that reports "all passed"
with fewer checks than last time is not a passing run — and that is exactly how the one real
regression in Module 16 was found.

---

## Layout

```
tests/
  run.mjs          the runner, and the expected-count table
  cleanup.mjs      removes test data, then sweeps orphaned rows
  api/             24 suites, one per subsystem plus six cross-cutting
  browser/         Playwright suites (not run by `npm test`)
```

Every suite is **self-contained**: it creates its own companies, users and hardware, asserts,
and leaves the seeded demo data alone. Paths are resolved relative to the file, so the estate
works from any checkout.

---

## The suites

| Suite | Checks | What it covers |
|---|---|---|
| `foundation` | 39 | Health, the error envelope, malformed input, security headers, CORS |
| `money` | 25 | Paise arithmetic, in-process |
| `auth` | 36 | Registration, login, JWT, role gates |
| `company` | 82 | Company CRUD and tenant isolation |
| `user` | 102 | Users, vehicles, ownership, protected fields |
| `station` | 87 | Stations and company scope |
| `charger` | 100 | Chargers, connectors, the ownership chain |
| `multiconnector` | 21 | Two plugs on one charger, independently |
| `ocpp` | 82 | The full OCPP frame set over real WebSockets |
| `session` | 112 | Start, meter, stop, energy, concurrency |
| `realtime` | 49 | Socket.IO rooms, scoping, silence assertions |
| `tariff` | 73 | Pricing, activation, rate snapshots |
| `wallet` | 83 | Recharge, verification, settlement |
| `settlement-race` | 20 | Concurrent settlement, in-process |
| `complaint` | 93 | Support workflow and transitions |
| `notification` | 69 | Triggers, dedupe, delivery |
| `analytics` | 117 | Aggregation correctness and date anchoring |
| `map` | 72 | Marker data, driver discovery, suspension |
| `dashboard` | 24 | The dashboard's data contract |
| **`security-matrix`** | **55** | **Tampering across every resource and channel** |
| **`integrity`** | **33** | **Reference chains, and the live data checked for orphans** |
| **`failure`** | **34** | **Malformed frames, lost chargers, failed payments** |

The last three were added in Module 16 and deliberately run **last**: they exercise every module
at once, so a failure there after everything else is green points at an *interaction* rather
than at any single module.

---

## Demo data

```bash
cd backend
npm run seed:admin       # the platform administrator
npm run seed:demo        # companies, tariffs, stations, chargers, connectors, staff
npm run seed:activity    # drivers, vehicles, sessions, meter readings, money, complaints
```

`seed:activity` writes **history** — sessions backdated across three weeks so the charts have a
shape, priced by the real tariff arithmetic and settled through the real ledger. Nothing is
written straight into an analytics table, because there is no analytics table: Module 13 reads
exactly these rows.

---

## Things that will trip you up

| Symptom | Cause |
|---|---|
| `money` / `settlement-race` fail to import | `npm run build` in `backend/` first |
| Every payment signature rejected | Real Razorpay keys present — pass `RZP_SECRET` |
| `ocpp` heartbeat check is slow or flaky | Run the server with `OCPP_OFFLINE_AFTER_SECONDS=5` |
| A suite hangs on a WebSocket | A stale simulator holds the ocppId. Restart the backend — the OCPP registry is in-memory |
| Counts drift upward over runs | Test data accumulating. `npm run test:clean` |
