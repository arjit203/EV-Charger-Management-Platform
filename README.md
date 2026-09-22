# EV-CMS — EV Charging Management Platform

A Charge Point Management System (CPMS): the software a charging network operator runs to manage stations and chargers, talk to those chargers over **OCPP**, price and meter charging sessions, take payment, handle support, and see what is happening across the network in real time.

Every subsystem was designed and written up before it was built, and nothing was considered done
until it was covered by the check suite. [`docs/design/`](./docs/design) holds those notes —
what each part does, and which decisions were load-bearing.

---

## What it does

- **Multi-tenant by design.** Several (CPO's)charge point operators share one platform and can never see each other's data.
- **Real charger communication.** An OCPP-inspired WebSocket gateway with a simulated charge point that behaves like hardware — boot, heartbeat, status, remote start/stop, meter values.
- **Metered, priced charging.** Energy comes from the charger's own meter; the rate is snapshotted when the session starts, so a later price change cannot reprice a car alreadycharging.
- **Wallet and payments.** Razorpay with server-side signature verification, atomic wallet debits, and a settlement sweeper for drivers who charge before they can pay.
- **Live operations.** Socket.IO pushes charger and session changes to the browser as they happen — nothing polls.
- **Analytics, a station map, support tickets, notifications**, and a CMS-style admin console
  that ties them together.

---

## Tech stack

| Layer | Choice |
|---|---|
| Backend | Node.js · Express · TypeScript |
| Database | MongoDB · Mongoose |
| Auth | JWT · bcrypt · role-based access control |
| Charger link | `ws` — raw WebSocket, OCPP 1.6J-inspired |
| Browser real-time | Socket.IO |
| Payments | Razorpay (test mode) |
| Frontend | Next.js (App Router) · React · TypeScript · Tailwind |
| Map | Leaflet · React Leaflet · OpenStreetMap tiles |
| Simulator | TypeScript CLI speaking OCPP over `ws` |

**Deliberately not used:** Redis, Kafka, Kubernetes, multi-region. See
[Known limitations](#known-limitations).

---

## Repository layout

```
backend/     API, OCPP gateway, Socket.IO server, business logic
frontend/    Next.js application
simulator/   a simulated charge point, run one per charger
tests/       1,480 API checks + 104 browser checks
docs/design/ design notes per subsystem, plus the API reference
```

---

## Prerequisites

- **Node.js 20+**
- **MongoDB** — local or Atlas. A **replica set is required**: payments use transactions.
  Atlas provides this by default.

---

## Setup

```bash
git clone <repo> && cd EV-CMS

cd backend    && npm install
cd ../frontend && npm install
cd ../simulator && npm install
```

Create `backend/.env` from the template:

```bash
cd backend && cp .env.example .env
```

| Variable | Required | Purpose |
|---|---|---|
| `MONGODB_URI` | ✅ | Connection string, ending in a database name |
| `JWT_SECRET` | ✅ | Token signing key. Rotating it invalidates every session |
| `PORT` | | Default `5000` |
| `CORS_ORIGIN` | | Default `http://localhost:3000` |
| `JWT_EXPIRES_IN` | | Default `7d` |
| `BCRYPT_SALT_ROUNDS` | | Default `10` |
| `OCPP_OFFLINE_AFTER_SECONDS` | | Default `90`. Use `5` when running the tests |
| `SESSION_START_TIMEOUT_SECONDS` | | Default `20` |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | | **Leave empty** to run the deterministic stub |
| `RAZORPAY_WEBHOOK_SECRET` | | Only if you configure a webhook |

Then `frontend/.env.local`:

```
NEXT_PUBLIC_API_BASE_URL=http://localhost:5000/api/v1
```

> **`.env` is git-ignored and must stay that way.** `.env.example` holds placeholders only.
> Never put live-mode Razorpay credentials in either.

### Payments without a Razorpay account

Leave the Razorpay variables empty and the backend runs a **stub provider**: order creation is faked, but **signature and webhook verification are real HMAC** — the security-critical half is never stubbed. Stub orders are recognisable by an `order_stub…` prefix.

---

## Running it

Three terminals.

```bash
# 1 — backend
cd backend && npm run dev

# 2 — frontend
cd frontend && npm run dev        # http://localhost:3000

# 3 — a simulated charger (one per charger; the flags need `=`)
cd simulator && npm run dev -- --charger=LIV-DEL-CP-01-A --token=<authToken>
```

Get a charger token with `POST /chargers/:id/token` as `super_admin` — the plaintext is
returned **once** and never again.

### Seeding

```bash
cd backend
npm run seed:admin       # the platform administrator
npm run seed:demo        # companies, tariffs, stations, chargers, connectors, staff
npm run seed:activity    # drivers, vehicles, sessions, meter readings, payments, complaints
```

`seed:activity` backdates sessions across three weeks so the dashboard and analytics have real
shape. Everything is priced by the real tariff arithmetic and settled through the real ledger —
no numbers are written directly into any reporting table.

It does not, however, guarantee a driver can afford what it charged them, so a freshly seeded
database contains drivers in debt. That matters because an unpaid balance blocks new charges:

```bash
cd backend
npm run fix:arrears              # report who owes what
npm run fix:arrears -- --apply   # top up those wallets and collect through the real ledger
```

Dry-run by default. The repair never marks anything paid by hand — it credits the wallet and
then calls the same settlement a real top-up calls, so every cleared session goes through the
real debit, the atomic balance guard and a genuine ledger entry.

`npm run fix:settlement-backoff` is a one-time migration for payment records written before
retry backoff existed. It is also dry-run unless given `--apply`.

**Demo logins** (weak passwords on purpose — never use this data in production):

| Role | Email | Password |
|---|---|---|
| super_admin | `admin@evcms.local` | `Admin@12345` |
| cpo_admin | `cpo@livanto.local` | `Cpo@12345` |
| operator | `ops@livanto.local` | `Ops@12345` |
| cpo_admin (2nd CPO) | `cpo@sharma.local` | `Cpo@12345` |
| driver | `ananya@driver.local` | `Driver@12345` |

---

## Testing

```bash
cd backend
npm run build      # required: three suites import compiled output
npm test           # 1,480 API checks across 24 suites
npm run test:list  # the suites and their expected counts
npm run test:clean # remove test data and sweep orphans
```

See [`tests/README.md`](tests/README.md) for the browser suites, the Razorpay caveat, and what
each suite covers.

```bash
# in backend/, frontend/ and simulator/
npm run typecheck && npm run lint
```

---

## The demo, end to end

1. **Sign in** as `cpo@livanto.local` → the operations dashboard: live fleet status, active
   sessions, revenue, open complaints.
2. **Start a simulated charger.** It appears **online within a second**, no refresh.
3. **Sign in as a driver** in another window → **Wallet** → top up ₹500.
4. **Start charging.** Watch the admin dashboard populate live: the connector flips to
   *charging*, the session row appears, energy climbs.
5. **Stop.** 2.5 kWh × ₹12.00/kWh = **₹30.00**, computed server-side from the snapshotted rate.
6. **Try it with an empty wallet.** The electricity is delivered anyway — `completed` +
   `unpaid`, because energy cannot be un-delivered — and a later top-up collects the debt on
   its own. Keep going and the platform stops extending credit: once a driver's *aged* unpaid
   balance passes ₹200 or three sessions, the next start is refused with the amount owed and
   how to clear it.
7. **File a complaint**, resolve it as staff, watch the notification arrive.
8. **Analytics** and the **station map**, then back to the dashboard to see the activity
   reflected.

**The line worth saying:** *a wallet top-up is not revenue. It is money the customer deposited
and the platform still owes them as electricity — it becomes revenue when it is spent.*

---

## Documentation

| | |
|---|---|
| [`docs/design/API.md`](docs/design/API.md) | Every endpoint, who may call it, what it is for |
| [`tests/README.md`](tests/README.md) | How to run the suites and what they cover |

Design notes, one per subsystem — the decisions and why:

| | | |
|---|---|---|
| [Foundation](docs/design/foundation.md) | [Auth & RBAC](docs/design/auth-and-rbac.md) | [Companies & tenancy](docs/design/companies-and-tenancy.md) |
| [Users & vehicles](docs/design/users-and-vehicles.md) | [Stations](docs/design/stations.md) | [Chargers & connectors](docs/design/chargers-and-connectors.md) |
| [OCPP gateway](docs/design/ocpp-gateway.md) | [Charging sessions](docs/design/charging-sessions.md) | [Real-time monitoring](docs/design/realtime-monitoring.md) |
| [Tariffs & pricing](docs/design/tariffs-and-pricing.md) | [Wallet & payments](docs/design/wallet-and-payments.md) | [Support & complaints](docs/design/support-and-complaints.md) |
| [Notifications](docs/design/notifications.md) | [Analytics](docs/design/analytics.md) | [Station map](docs/design/station-map.md) |
| [Admin console](docs/design/admin-console.md) | | |

---

## Known limitations

Stated plainly, because each was a deliberate decision rather than an oversight.

**Scale and infrastructure**
- **Single instance only.** The OCPP registry and Socket.IO rooms are both in-memory, so
  neither survives a second backend process. Redis is the fix, deliberately deferred.
- **No rate limiting** on the API.
- **No JWT revocation list.** The per-request database reload covers suspension; a stolen token
  stays valid until it expires.
- **`MeterReading` grows without bound** — no TTL or rollup.

**Protocol and hardware**
- **OCPP is modelled, not certified.** Message shapes are simplified against the full 1.6J
  specification — "OCPP-inspired" on purpose.
- **OCPI is conceptual only** — no roaming between operators.

**Money**
- **Razorpay test mode only**, and the platform collects but never pays out to operators.
- **Revenue is collections, not accruals**, and refunds are absent from the figure rather than
  separated out.
- **No write-off policy.** A debt is never abandoned — the electricity was delivered, so it
  stays collectable indefinitely. Unpaid balances block new charges, but there is no dunning
  schedule, no escalation beyond the block, and no way for staff to forgive a balance.
- **Arrears thresholds are global.** ₹200 and three sessions apply to every driver on every
  operator. A real CPO would set its own, and would want a per-driver override for a fleet
  account on invoice terms.

**Features deliberately not built**
- No charger **utilization** metric — every session here is started by hand, so it would measure
  the operator rather than the charger.
- No **period-over-period** comparison, and no CSV or PDF export.
- No **map clustering**, no live map markers, and **no proximity search** — the GeoJSON /
  `2dsphere` migration stays deferred because nothing queries by distance yet.
- No **charger fault / offline notifications** — the live dashboard already shows those.
- **Notifications are in-app only** — no email, SMS or push, no preferences, no retention.
- **Complaints have no assignment, SLA or attachments.**
- The **driver's home page** is still the original simple one; the visual polish pass was
  scoped to the staff console on purpose.

**Testing**
- These are **executable check scripts, not a unit-test framework.** They are real and they run
  against a live server with real WebSockets and real HMAC signatures — but they are not unit
  tests, and coverage is not measured.
- **UI verification is browser-driven but selective** — layout and visual polish are reviewed by
  eye, not asserted.
