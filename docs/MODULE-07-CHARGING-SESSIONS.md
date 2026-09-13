# Module 7 — Charging Sessions & Meter Readings

**Status:** Complete · 112 Module 7 checks passing, 598 across Modules 1–7
**Depends on:** Module 5 (chargers, connectors) and Module 6 (the OCPP gateway)
**Feeds:** Module 8 (live monitoring), Module 9 (tariffs), Module 10 (wallet), Module 13 (analytics)

---

## 1. Purpose

Module 6 proved a charger could talk to the backend. Module 7 makes those conversations **mean
something**: who charged, where, for how long, and how much energy flowed.

That is the difference between a protocol demo and a charging platform. Everything after this
module reads the records written here — a tariff has nothing to price without a session, a
wallet has nothing to debit, analytics has nothing to aggregate.

Two new records:

| Record | What it is | Grows |
| ------ | ---------- | ----- |
| `ChargingSession` | One car's visit to one plug | One per charge |
| `MeterReading` | One energy sample during that visit | Every few seconds while charging |

A charger is a permanent asset; a session is a temporary event. One charger accumulates
thousands of sessions over its life.

---

## 2. The decision that changed Module 6

Module 6 exposed `POST /chargers/:id/commands/remote-start` and `.../remote-stop` as a test
surface, with a note saying Module 7 would "replace" them. Replace turned out to mean **delete**,
and the reason is a real defect rather than tidiness.

If both paths stayed live, an admin could hit the raw remote-start and the charger would begin
delivering power **with no `ChargingSession` describing it** — energy the platform cannot bill,
cannot show a driver, and cannot explain afterwards. A phantom charge.

So:

| Module 6 endpoint | Fate in Module 7 |
| ----------------- | ---------------- |
| `POST /chargers/:id/commands/remote-start` | **Deleted** |
| `POST /chargers/:id/commands/remote-stop` | **Deleted**, replaced by `POST /charging/sessions/:id/stop` |
| `GET /chargers/:id/connection` | **Kept** — read-only, changes nothing |

`ocpp/commands.ts` still holds `sendRemoteStart` / `sendRemoteStop` as the low-level primitive.
What changed is that it now has **exactly one caller**: `chargingSession.service.ts`.

The resulting invariant — **no energy without a session** — is enforced at both ends:

- nothing but the session service may send a RemoteStart, and it writes the row first
- a `StartTransaction` the gateway cannot match to a session is refused (`idTagInfo: Invalid`)

---

## 3. The state machine (the fourth one)

The project now has four status concepts, and conflating any two corrupts the model.

| Field | Concern | Written by |
| ----- | ------- | ---------- |
| `Charger.status` | administrative — a human put it in maintenance | staff, via the API |
| `Charger.isOnline` | connectivity — is the socket up | the gateway |
| `Connector.status` | operational — is this plug free/charging/faulted | the gateway, from `StatusNotification` |
| `ChargingSession.status` | transactional — the life of one charge | **this module** |

```
initiating ──StartTransaction──▶ active ──stop requested──▶ stopping ──StopTransaction──▶ completed
     │                             │                            │
     └──── timeout / rejected ─────┴──── charger disconnect ─────┴──▶ failed
```

`cancelled` was considered and dropped: no actor in this system cancels a charge. A start the
charger rejects is `failed`. A state with no producer is a branch nobody walks.

**Module 7 never writes `Connector.status`.** The gateway owns it, because only the hardware
knows what the plug is actually doing.

---

## 4. Concurrency — the database refuses, not an `if`

The race: two drivers press start on the same connector at the same instant. Both pass an
application-level "is there an active session?" check, both insert. Classic check-then-act.

```js
chargingSessionSchema.index(
  { connectorId: 1 },
  { unique: true,
    partialFilterExpression: { status: { $in: ['initiating', 'active', 'stopping'] } } },
);
```

The second insert fails with `E11000`, which Module 1's error middleware already maps to **409**.
Same philosophy as `ocppId`, `stationCode` and `connectorNumber`: **if a rule must hold under
concurrency, the database enforces it.**

This also settles a question that would otherwise be arbitrary — **the session row is written
before the OCPP command is sent**. Writing first is what makes the reservation atomic. Sending
first would mean two requests could both command a charger before either had written anything,
with real power as the side effect.

*Verified, not assumed:* four simultaneous start requests on one connector → exactly one 202,
three 409s.

### A bug this found: `sparse` is not `partial`

The first version indexed `{ transactionId: 1 }` as `unique + sparse`. A sparse index skips
documents where the field is **absent** — but every session stores `transactionId: null` until
the charger confirms, and `null` is *present*. The second unconfirmed session in the database
collided with the first on a null-vs-null duplicate, and starting a charge failed for no visible
reason. Fixed with `partialFilterExpression: { transactionId: { $type: 'number' } }`.

---

## 5. Correlation — the idTag became real

OCPP's `idTag` is the credential the hardware quotes. Module 6's `Authorize` handler accepted
any well-formed tag, because there was nothing to check against.

Module 7 mints a **random 20-character tag per session** (20 because OCPP 1.6 caps `idTag`
there — which is also why a 24-hex-character ObjectId cannot be used). The tag travels
untouched:

```
RemoteStartTransaction(idTag) ──▶ charger ──▶ Authorize(idTag) ──▶ StartTransaction(idTag)
```

That gives two things at once:

- **Authorize is now a real gate.** A tag is valid only while the session holding it is open, so
  a charger cannot authorise a charge nobody requested, and a tag sniffed from the wire is
  worthless once its session ends.
- **StartTransaction correlates precisely**, instead of guessing "whatever is open on plug 2".

A walk-up RFID start with a tag we never issued gets `idTagInfo: { status: 'Invalid' }`, which
per OCPP 1.6 tells the charge point to stop. A transactionId is still returned because the
protocol requires the field.

---

## 6. Meter readings — idempotency in one comparison

Chargers resend. A flaky link makes one repeat a `MeterValues` it already sent; a charger that
buffered readings while offline replays the whole backlog on reconnect.

**The rule: a reading must carry strictly more energy than the last stored one.** That single
comparison rejects duplicates, out-of-order arrival and garbage together. A unique index on
`{ sessionId, meterTimestamp }` is the backstop for two identical readings arriving close enough
together that both pass the check before either writes.

A rejected reading is **not an error** — it gets an empty CALLRESULT, not a CALLERROR. Answering
with an error for expected traffic would make a healthy charger look broken.

*Known consequence, accepted:* a car that has finished charging keeps reporting the same counter,
and those samples are dropped. The session looks quiet rather than dead — which is fine, because
liveness is the heartbeat's job, not the meter's.

Energy is always `endMeter − startMeter`, clamped at zero. A cumulative counter that appears to
run backwards is bad data, never negative energy.

---

## 7. Sessions never get stuck — three recovery paths

A session that stays `active` forever is worse than a failed one: the partial unique index keeps
the connector reserved and **no driver can ever start there again**.

| Failure | Detected by | Result |
| ------- | ----------- | ------ |
| Charger accepted the start, never confirmed | sweeper, after `SESSION_START_TIMEOUT_SECONDS` (default 20) | `failed` · `StartTimeout` |
| Charger disconnected cleanly mid-charge | gateway `close` handler | `failed` · `ChargerDisconnected` |
| Charger went silent mid-charge | Module 6's heartbeat sweep | `failed` · `ChargerDisconnected` |

Both disconnect paths are needed: a mobile link dropping mid-frame produces silence with no
`close` event, and a tidy shutdown produces a `close` with no silence.

**Energy is never discarded.** `energyConsumedWh` already holds everything up to the last reading
that arrived, so a driver is billed for power they actually received.

**Sessions are failed, never deleted.** A driver who pressed start and got nothing deserves a
record saying so; a row that quietly disappears is indistinguishable from a bug.

### Transaction ids now survive a restart

Module 6 started its in-memory counter at 1000 every boot, which was harmless while nothing was
persisted. Now a restart would reissue 1001 and either collide with the unique index or —
far worse — attach a live charger's `MeterValues` to someone else's completed charge. The gateway
seeds the counter from `max(transactionId)` at start.

---

## 8. Permissions — the first module where both scopes apply

A session genuinely has **two** owners, so the role picks the scope rather than combining them:

- the **driver** who charged → `applyOwnerScope`
- the **company** whose plug it was → `applyCompanyScope`

A driver sees their charge at someone else's station. A CPO sees every charge at their own
stations, including drivers they have no other relationship with.

| Action | super_admin | cpo_admin | operator | driver |
| ------ | ----------- | --------- | -------- | ------ |
| Start a charge | ✗ | ✗ | ✗ | ✓ (own) |
| Stop a charge | ✓ any | ✓ own company | ✓ own company | ✓ own session |
| View sessions | ✓ all | ✓ own company | ✓ own company | ✓ own only |
| View meter readings | ✓ | ✓ own company | ✓ own company | ✓ own only |

**Staff cannot start on a driver's behalf.** A session carries a `userId` that Module 10 will
bill, so an admin-initiated charge would mean one person spending another person's money. Staff
testing hardware use a driver account, which produces an honest record.

**The operator's force-stop** is what replaced Module 6's raw remote-stop, and it is strictly
better: session-aware, so stopping updates the record instead of silently ending a charge the
database still believes is running. It is the operator's one write in the whole project, and it
follows Module 6's reasoning — dealing with a stuck charge at a station is literally the job.

**Company-scoped callers get 403, not 404**, even for ids that do not exist, so the endpoint
cannot be used to probe which session ids are real. Drivers get 404, matching Module 3's vehicles.

`requireActiveCompany` is deliberately **absent** from the driver routes. A driver belongs to no
company; public charging is public. Applying it would reject every driver before the handler ran.

---

## 9. API

| Method | Path | Who | Notes |
| ------ | ---- | --- | ----- |
| `GET` | `/charging/connectors/:connectorId` | all | What the plug's QR code resolves to |
| `POST` | `/charging/sessions` | driver | **202 Accepted** |
| `POST` | `/charging/sessions/:id/stop` | all | **202** — driver stop *and* staff force-stop |
| `GET` | `/charging/sessions` | all | Paginated, scoped by role |
| `GET` | `/charging/sessions/active` | driver | The one open session, or `null` |
| `GET` | `/charging/sessions/:id` | all | |
| `GET` | `/charging/sessions/:id/readings` | all | The energy curve |

There is **no DELETE**, and here it is not even a judgement call: a session is a financial record
Modules 9, 10 and 13 will read.

### Why 202 and not 201

201 Created would claim the session exists *and is running*. It is not: the charger has answered
"Accepted, I will try", and nothing is charging until `StartTransaction` arrives moments later.
202 is the honest code for a real physical side effect — **the request succeeded, the world has
not caught up yet.**

### Why the start payload is one field

`{ connectorId, vehicleId? }`. Station, charger, company and connector number are all derived
server-side by walking the relationships. Accepting them from the client would mean trusting the
client's idea of which charger a connector belongs to. `userId` is never accepted — `.strict()`
turns an attempt to send it into a visible 422 rather than a silent strip.

`vehicleId` is optional (the platform bills for energy, not for cars) and must be the caller's
own. A car whose plug type does not match the connector is **422** — the request is well-formed
and the connector is free, but a CHAdeMO car at a CCS2 plug is a semantic impossibility. This is
the first use of the shared `CONNECTOR_TYPES` enum Module 5 created for exactly this comparison.

---

## 10. Frontend

| Route | Who | What |
| ----- | --- | ---- |
| `/charge` | driver | Look up a connector, pick a car, start |
| `/sessions` | all | History (driver) or monitor (staff) — one page, one endpoint, two scopes |
| `/sessions/[id]` | all | Live detail, energy curve, stop / force-stop |

`/charge?connectorId=…` is exactly the URL a QR code on the plug would encode; typing it is the
same flow without a camera.

The detail screen **polls every 3 seconds** while a session is open. That is the honest interim
solution — the browser has no way to learn that a charger sent a `MeterValues`, because the OCPP
socket ends at the backend. Module 8 replaces the polling with Socket.IO. The two real-time
systems stay separate even then: the browser never speaks OCPP, the charger never speaks
Socket.IO, and the backend is the only thing that sees both.

The screen does not decide whether charging is possible — it asks the server, which returns
`canStart` plus a reason, because that verdict needs all three state machines at once.

---

## 11. Verification — 112 checks

Run against a live backend and **real WebSocket connections**, not mocks. There is still no unit
test framework in this project; these are executable HTTP/WS check scripts, and saying so plainly
is better than implying coverage that does not exist.

| Area | Checks |
| ---- | ------ |
| Module 6 endpoint retirement | 3 |
| Start guards (roles, ids, `.strict()`) | 8 |
| Connector lookup | 3 |
| Vehicle matching | 2 |
| Full OCPP round trip | 19 |
| Concurrency (including a 4-way race) | 5 |
| Meter values and idempotency | 11 |
| Read scoping | 15 |
| Stop flow | 16 |
| Closed-session traffic | 4 |
| Walk-up start refused | 3 |
| Mid-session disconnect | 6 |
| Unconfirmed-start sweeper | 8 |
| Operator force-stop | 4 |
| Cross-company charging | 4 |

Regression across Modules 1–7: **598 checks, 0 failing.**

### End-to-end, three processes

Backend + real simulator + API client:

```
1. start           -> HTTP 202, status initiating
2. charger confirms-> status active, transactionId 1014
3. 16s of charging -> 0.25 kWh, 3 readings: 83.33 -> 166.67 -> 250 Wh
4. stop            -> HTTP 202, status stopping
5. final record    -> completed, 0.25 kWh, 17s, meter 0 -> 250 Wh, stopReason Remote
```

83.33 Wh per 5-second tick at 60 kW is exactly `powerKw × 1000 × (5/3600)` — the simulator's
formula, arriving intact through the whole stack.

---

## 12. Files

**New (backend)**

```
constants/session.ts                     statuses, stop reasons, timeouts
models/chargingSession.model.ts          the session + its four indexes
models/meterReading.model.ts             one energy sample
services/chargingSession.service.ts      actor-driven: start, stop, reads (RBAC lives here)
services/sessionEvents.service.ts        charger-driven: OCPP events, sweeper (no actor)
validators/session.validator.ts
controllers/chargingSession.controller.ts
routes/session.routes.ts
```

The two services are split on purpose. One has an `AuthUser`, RBAC and company scoping; the other
has none, because its caller is a machine that already proved its identity at the WebSocket
upgrade. Mixing them would mean either inventing a fake actor for the gateway or leaving an
unauthenticated path inside a file meant to enforce permissions.

**Changed (backend)**

```
ocpp/handlers.ts            Authorize/Start/Meter/Stop now persist instead of logging
ocpp/gateway.ts             fails open sessions on disconnect; seeds ids; runs the sweeper
ocpp/registry.ts            seedTransactionId()
routes/charger.routes.ts    raw command routes removed
services/chargerCommand.service.ts   reduced to read-only diagnostics
controllers/chargerCommand.controller.ts
validators/charger.validator.ts      remoteStartSchema removed
config/env.ts, .env.example          SESSION_START_TIMEOUT_SECONDS
routes/index.ts             mounts /charging
```

**New (frontend)**

```
services/session.service.ts
components/SessionSummary.tsx
app/charge/page.tsx
app/sessions/page.tsx
app/sessions/[sessionId]/page.tsx
```

---

## 13. Known limits — say these before an interviewer finds them

- **Polling, not push.** Module 8's job.
- **One transaction per charger** in the gateway's in-memory bookkeeping. The database models
  multiple sessions per charger correctly (one per connector); the registry simplification is the
  limit, and it matters for a charger with several plugs charging at once.
- **The registry is in-memory**, so with two backend instances a charger connected to A is
  invisible to B. Unchanged from Module 6, and still the first thing to say about scaling.
- **No billing yet.** Energy is measured, not priced — Modules 9 and 10.
- **No unit test framework.** Executable check scripts only.
- **`MeterReading` grows without bound.** A real deployment would need a TTL or rollup once
  Module 13 aggregates the numbers it needs.

---

## 14. What Module 8 adds

Socket.IO alongside the OCPP gateway on the same HTTP server — which is why `server.ts` has used
`http.createServer(app)` since Module 0, and why the gateway's upgrade handler only claims paths
under `/ocpp/`. Session transitions and meter readings become pushed events, and the 3-second
poll in `/sessions/[id]` goes away.
