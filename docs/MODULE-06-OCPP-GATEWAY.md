# Module 6 — OCPP Gateway + Simulated Charger

**Status:** ✅ Complete
**Depends on:** Module 0 (the explicit `http.Server`), Module 1 (auth), Module 2 (company scoping), Module 5 (Charger/Connector records)

> **Honesty clause, stated once and repeated in the code:** this is an **OCPP-inspired
> simulation**, not a spec-compliant OCPP stack. The wire envelope matches OCPP-J and the
> action names are real, but payload schemas are simplified and only the subset this project
> needs is implemented. It should never be described as "OCPP compliant".

---

## 1. Purpose

Until now the project stored records *about* hardware. This module makes hardware **talk to
the backend** — without owning any.

```
┌──────────────┐  ws + OCPP frames   ┌────────────────────────┐
│  simulator/  │ ──────────────────▶ │  OCPP Gateway          │
│  a Node proc │ ◀────────────────── │  (inside the backend)  │
│  pretending  │                      │         │              │
│  to be EVSE  │                      │         ▼              │
└──────────────┘                      │  Charger / Connector   │
                                      │       records          │
                                      └────────────────────────┘
```

**Why WebSocket and not REST.** A charger sits behind a mobile SIM with no public IP and no
inbound port — you cannot make an HTTP request *to* it. The charger opens one long-lived
connection outward, and the server pushes commands down it. It's also far cheaper for frequent
small messages than polling.

## 2. The two real-time systems stay separate

| | Transport | Between | Module |
|---|---|---|---|
| **OCPP** | raw `ws`, OCPP-J frames | charger ↔ backend | **6 (this)** |
| **Socket.IO** | Socket.IO, app events | backend ↔ browser | 8 |

Both attach to the **same** `http.Server` created in `server.ts` — which is exactly why
Module 0 used `http.createServer(app)` instead of `app.listen()`. The gateway's upgrade
handler claims only paths under `/ocpp/` and leaves everything else alone, so Module 8 can
attach Socket.IO on `/socket.io` with no renegotiation.

## 3. Message envelope — real OCPP-J

```jsonc
[2, "uid-1", "BootNotification", { ... }]   // CALL
[3, "uid-1", { ... }]                        // CALLRESULT
[4, "uid-1", "NotSupported", "desc", {}]     // CALLERROR
```

`uniqueId` correlates a reply to its request, which is necessary because **both sides** can
have messages in flight: a charger streams MeterValues while the backend sends a
RemoteStopTransaction.

Supported actions: `BootNotification`, `Heartbeat`, `StatusNotification`, `Authorize`,
`StartTransaction`, `MeterValues`, `StopTransaction` (inbound) and
`RemoteStartTransaction`, `RemoteStopTransaction` (outbound). Anything else gets a
`CALLERROR "NotSupported"` — the correct OCPP answer, and far better than closing a socket
over an action we simply chose not to implement.

## 4. Charger authentication — the new security boundary

`ocppId` is a **claim, not a credential**. Without a secret, anything that can open a
WebSocket could connect as any registered charger, report false status, and receive commands
meant for real hardware.

**Mechanism, mirroring real OCPP 1.6J:**

```
ws://host/ocpp/LIV-DEL-CP-01-A
Authorization: Basic base64("LIV-DEL-CP-01-A:<token>")
```

Three checks, in order, **all before a socket is accepted**:

1. A `Charger` with that `ocppId` exists → else 401. **The gateway never creates one** —
   auto-registering from an inbound connection would let anyone add hardware and bypass
   company ownership entirely.
2. The Basic username equals the path identity → else 401. Stops presenting charger B's
   credentials on charger A's path.
3. The token matches the stored bcrypt hash → else 401.

**The token is stored hashed and shown once**, exactly like an API key, so a database dump
yields no working charger credentials. `POST /chargers/:id/token` regenerates it.

**What we did NOT build:** OCPP 2.0.1's mutual-TLS client certificates. Out of scope, and
stated as such.

## 5. Three orthogonal states — do not conflate them

This is the conceptual trap of the module.

| Field | Meaning | Written by |
|---|---|---|
| `Charger.status` | **Administrative** — a human put this machine in maintenance | Module 5 admin CRUD |
| `Charger.isOnline` | **Connectivity** — is the WebSocket up | Gateway only |
| `Connector.status` | **Operational** — is *this plug* free/charging/faulted | Gateway, from StatusNotification |

**`StatusNotification` writes to Connector, never Charger.** Real OCPP reports status *per
connector*, because that is what a car occupies.

**When a charger goes offline we set `isOnline: false` and leave connector statuses alone.**
The hardware never said the plugs changed — we simply cannot reach it. Forcing them to
"unavailable" would be inventing state, and is the same cascade logic Module 5's D7 rejected.
**Verified by test.**

## 6. Changes to Module 5 — both anticipated

| File | Change | Anticipated by |
|---|---|---|
| `constants/connector.ts` | added `preparing`, `charging`, `finishing` | Module 5 **D8** |
| `models/charger.model.ts` | added `isOnline`, `lastHeartbeatAt`, `authTokenHash` (`select:false`) | Module 5 **D9** |

Both additive. `toPublicCharger` exposes the first two; the hash is never returned by any
endpoint (**tested**). Module 5's admin CRUD cannot write any of the three.

One Module 5 **test** also had to change: it asserted `status: 'charging'` was invalid on a
connector. It is now valid. The assertion was updated to a genuinely invalid value, and a new
check records that `charging` is accepted — so the behaviour change is pinned rather than
silently absorbed.

## 7. Status mapping — protocol vocabulary stops at the gateway

| OCPP (PascalCase) | Our domain (lowercase) |
|---|---|
| `Available` | `available` |
| `Preparing` | `preparing` |
| `Charging` | `charging` |
| `Finishing` | `finishing` |
| `Faulted` | `faulted` |
| `Unavailable` | `unavailable` |
| `SuspendedEV`, `SuspendedEVSE`, `Reserved` | `occupied` |

The three "suspended/reserved" values collapse because what our model cares about is *a car
is present and the plug is not free*; preserving the distinction would create domain values
with no consumer. Unknown values produce a `CALLERROR`.

## 8. Connection lifecycle

```
1  upgrade on /ocpp/<ocppId> → authenticate (§4) → 401 destroys the socket on any failure
2  accepted → registry.register(ocppId, socket)     [replaces any existing — see below]
3  ← BootNotification  → {status:'Accepted', currentTime, interval:30, powerKw}
                       → isOnline = true, lastHeartbeatAt = now
4  ← StatusNotification(1, Available) → Connector(1).status = 'available'
5  ← Heartbeat every 30s → lastHeartbeatAt = now
6  sweep every ≤15s: silence > 90s → isOnline = false (connectors untouched)
7  close/error → registry.remove(guarded) → isOnline = false
```

**Duplicate connections replace, they do not reject.** A charger reconnecting after a network
blip is indistinguishable from a duplicate; rejecting would leave real hardware locked out
behind a stale socket the backend believes is alive. The old socket is closed with code
**4000 "superseded"**.

**`registry.remove` is guarded by socket identity** — when a reconnect replaces a socket, the
*old* socket's `close` fires afterwards and must not evict the *new* connection. Subtle, and
covered by the duplicate-connection test.

**Heartbeat timeout: 90s = 3 × 30s interval**, so one lost packet is not a false alarm.
Detected by **one `setInterval` sweep for all chargers**, not a timer per charger — simpler,
and it cannot leak a timer when a socket dies. Configurable via `OCPP_OFFLINE_AFTER_SECONDS`
so tests need not wait 90 real seconds.

## 9. The charging flow

```
POST /chargers/:id/commands/remote-start {connectorNumber, idTag}
  → role + company check → online? connector free? → RemoteStartTransaction ──▶ charger
                                                     ◀── {status:'Accepted'}
charger: StatusNotification(Preparing) → Authorize → StartTransaction {meterStart}
                                                     ◀── {transactionId}
         StatusNotification(Charging) → MeterValues every 5s
POST /chargers/:id/commands/remote-stop
  → RemoteStopTransaction {transactionId} ──▶ charger
charger: StatusNotification(Finishing) → StopTransaction {meterStop} → Available
```

**Meter values are deterministic, derived from the charger's real rating:**

```
energyWh += powerKw × 1000 × (tickSeconds / 3600)
```

At 60 kW on a 5-second tick that is exactly **83.33 Wh** per reading — so a test asserts a
strictly increasing series rather than hoping a random walk behaves. The rating comes from the
BootNotification response, so the simulator holds no duplicate config.

**Transaction ids and meter values live in memory only.** `ChargingSession` and
`MeterReading` persistence is Module 7's; creating either here would mean writing a model
Module 7 redesigns.

## 10. Authorize — deliberately thin

`Authorize { idTag }` → `Accepted` for a 4–40 character `[A-Za-z0-9-]` tag, else `Invalid`.

**Authorization here is not user login.** It is the hardware asking, on behalf of whoever
tapped an RFID card on the reader, whether that *physical credential* may draw power. No
session, no password, and the driver types nothing. Module 7 replaces the stub with a real
lookup against the driver who initiated the session. Building RFID infrastructure now would be
inventing a subsystem with no consumer.

## 11. Command endpoints — and the operator's first write

| Method | Path | Roles |
|---|---|---|
| `POST` | `/chargers/:id/commands/remote-start` | super_admin, cpo_admin, **operator** |
| `POST` | `/chargers/:id/commands/remote-stop` | super_admin, cpo_admin, **operator** |
| `GET` | `/chargers/:id/connection` | super_admin, cpo_admin, operator |
| `POST` | `/chargers/:id/token` | super_admin, cpo_admin |

**Modules 3, 4 and 5 all deferred operator write access "until a concrete operational trigger
exists". This is that trigger** — operating a charger is literally the role's job. Note the
split that remains: an operator may **command** a charger but still may not **reconfigure**
one. Configuration is administration; commanding is operation.

Company scoping is unchanged — the service resolves the charger through Module 5's
`assertChargerInScope`, so an operator cannot command another company's hardware (**tested**).

These endpoints are the **Module 6 test surface**. Module 7 replaces them with the real
driver-facing start/stop that also creates a session, applies a tariff and debits a wallet.

## 12. Error handling — one bad charger must not break anything

| Situation | Response | Socket |
|---|---|---|
| Unparseable frame | `CALLERROR FormationViolation` | **stays open** |
| Non-array frame | `CALLERROR FormationViolation` | **stays open** |
| Unsupported action | `CALLERROR NotSupported` | **stays open** |
| Missing/invalid payload field | `CALLERROR PropertyConstraintViolation` | stays open |
| Handler throws unexpectedly | `CALLERROR InternalError`, logged with stack | stays open |
| Unknown charger / bad token / identity mismatch | **401**, socket destroyed | never accepted |
| Command to a disconnected charger | **409** | — |
| Command to another company's charger | **403** | — |
| Remote start while already charging | **409** | — |
| Remote stop with no transaction | **409** | — |
| Charger does not answer a command | 10s timeout → error | stays open |

**Verified: after a malformed frame, a bad-shape frame and an unsupported action, the socket
is still open and the REST API still answers.**

## 13. Verification — 77 checks, all passing

**Auth:** valid token connects · wrong token 401 · unknown charger 401 · charger B's token on
charger A's path 401 · Basic username ≠ path identity 401 · empty token 401 ·
`authTokenHash` absent from every response.

**Boot:** CALLRESULT with `Accepted`, `interval`, `currentTime`, `powerKw` · correct charger
marked online · **the other charger untouched**.

**Heartbeat:** answered with `currentTime` · `lastHeartbeatAt` advances · **silence marks the
charger offline while connector status is left unchanged**.

**Status:** all seven OCPP values map correctly · `errorCode` persisted · **`Charger.status`
not touched** · unknown status → CALLERROR.

**Authorize:** valid accepted · short and illegal-character tags rejected · missing tag →
CALLERROR.

**Commands:** RemoteStart reaches the charger with the right `idTag` · operator (own company)
allowed · cross-company 403 · driver 403 · anonymous 401 · disconnected 409 · unknown
connector 404 · already-charging 409 · RemoteStop addressed by the right `transactionId` ·
no-transaction 409.

**Meter:** accepted · strictly increasing · transaction cleared after stop.

**Errors:** malformed, bad-shape and unsupported all produce CALLERRORs with the **socket
still open** and REST still serving.

**Duplicate/reconnect:** second connection accepted, **old socket closed with 4000**, new one
works, charger still online; disconnect marks offline; reconnect works.

**Regression:** Modules 1–5 all green — **484 checks across six suites**.

## 14. The demo

```
Terminal 1  backend/    npm run dev
Terminal 2  simulator/  npm run dev -- --charger=LIV-DEL-CP-01-A --token=<token>
```

Real output from this implementation:

```
connected
BootNotification accepted (heartbeat 30s, 60 kW)
StatusNotification: Available
RemoteStartTransaction received
StatusNotification: Preparing
Authorize accepted
StartTransaction accepted (transaction 1001)
StatusNotification: Charging
MeterValues 0.083 kWh
Heartbeat
MeterValues 0.167 kWh
MeterValues 0.250 kWh
RemoteStopTransaction received
StatusNotification: Finishing
StopTransaction sent (0.250 kWh total)
StatusNotification: Available
```

## 15. Files

**New backend:** `ocpp/messages.ts`, `ocpp/registry.ts`, `ocpp/handlers.ts`, `ocpp/commands.ts`,
`ocpp/gateway.ts`, `services/chargerCommand.service.ts`,
`controllers/chargerCommand.controller.ts`, `utils/chargerToken.ts`

**Modified backend:** `server.ts` (attach + shutdown), `config/env.ts`
(`OCPP_OFFLINE_AFTER_SECONDS`), `constants/connector.ts`, `models/charger.model.ts`,
`services/charger.service.ts`, `controllers/charger.controller.ts`, `routes/charger.routes.ts`,
`validators/charger.validator.ts`, `scripts/seedDemoCompanies.ts`

**New package `simulator/`:** `config.ts`, `messages.ts`, `charger.ts`, `index.ts`

**Frontend:** charger list shows online/offline; detail gains an OCPP section with live
connectivity, remote start/stop, and one-time token display.

### A packaging bug fixed along the way

`backend/package.json` as committed was still the **Module 0 version** — it never received
Module 1's `bcryptjs`, `jsonwebtoken` and `zod`, or the `seed:admin` script, because it was one
of the files lost in an earlier history rewrite. Everything worked locally only because
`node_modules` still held them; `npm install ws` pruned the undeclared packages and exposed it.
**A fresh clone would have failed to build.** All four are now declared.

## 16. Known limits — say these before an interviewer finds them

- **The registry is in-memory.** With two backend instances, a charger connected to A is
  invisible to B, so a command issued on B cannot reach it. The fix is Redis pub/sub or sticky
  routing by charger id — a Module 17 scale conversation, and the first thing to say when asked
  how this scales.
- Not spec-compliant OCPP: simplified payloads, no `DataTransfer`, no smart charging, no
  firmware management, no reservations.
- No TLS locally (`ws://`, not `wss://`). Production would terminate TLS at the proxy.
- `Authorize` is a stub (§10).
- One transaction per charger, not per connector — enough for this simulation; multi-connector
  concurrency belongs with Module 7's session model.

## 17. What Module 7 will add

`ChargingSession` and `MeterReading` persistence: `StartTransaction` will create a session
bound to a driver and a vehicle, `MeterValues` will persist readings, `StopTransaction` will
finalise energy and duration. The driver-facing start/stop replaces §11's test endpoints, and
`Authorize` gains a real identity lookup.
