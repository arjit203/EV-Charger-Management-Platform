# Module 8 — Real-Time Charger & Session Monitoring

**Status:** Complete · 49 Module 8 checks passing, 669 across Modules 1–8
**Depends on:** Module 6 (OCPP gateway) and Module 7 (sessions)
**Feeds:** Module 13 (analytics dashboards), Module 15 (admin dashboard)

---

## 1. Purpose

Module 7 recorded what chargers did. Module 8 tells the browser about it **as it happens**.

Before this module every screen fetched once and sat still; a driver watching their charge saw
a number that was up to three seconds stale, and an operator had to press refresh to notice a
charger had dropped offline. Now the backend pushes, and the page never reloads itself.

---

## 2. Two real-time systems, one HTTP server

```
http.createServer(app)          <- why server.ts has never used app.listen()
   ├── Express            REST API
   ├── OCPP WebSocket     /ocpp/<ocppId>   raw ws, OCPP-J frames, CHARGERS   (Module 6)
   └── Socket.IO          /socket.io       app events, BROWSERS              (Module 8)
```

No conflict to resolve: Module 6's upgrade handler returns early for any path outside `/ocpp/`,
a line written then specifically to leave `/socket.io` free.

The separation is not cosmetic. OCPP is a published protocol spoken by hardware we do not
control, authenticated with a per-charger token. Socket.IO carries events we define, to our own
app, authenticated with a user's JWT. Neither could use the other's transport — no charger
implements Socket.IO, and a browser has no business speaking OCPP.

---

## 3. Four events, not seven

Each maps to exactly one field that already exists:

| Event | Owning field | Audience |
| ----- | ------------ | -------- |
| `connector:statusChanged` | `Connector.status` | company + platform |
| `charger:connectivityChanged` | `Charger.isOnline` | company + platform |
| `session:statusChanged` | `ChargingSession.status` | company + platform + **the driver** |
| `session:meterUpdate` | a stored `MeterReading` | company + platform + **the driver** |

**`charger:statusChanged` does not exist, deliberately.** Module 6's D2 put operational state on
the CONNECTOR and left the charger holding only connectivity. An event by that name would either
duplicate connector status or invent a field the model does not have — and the design doc would
then drift from the code.

**`session:started`, `session:completed` and `charger:faulted` were dropped** for one reason: they
are *values* of a status the payload already carries, not distinct occurrences. A client adds a
row on `initiating` and moves it to history on `completed` from the same event. If Module 11 or
12 later needs a fault hook with its own semantics, that is the moment to add one.

**Connectivity fires on transitions only.** Heartbeats arrive every 30 seconds per charger and
change nothing a dashboard renders; emitting on each would flood every open dashboard with
"still online" and bury the genuine connect/disconnect events.

---

## 4. Authentication — the same rule as REST

A socket has no resendable header: there is one request (the upgrade) and everything after it is
frames. So the JWT travels in `socket.handshake.auth.token`, and a connection middleware does
what `auth.middleware.ts` does:

1. verify the signature
2. **reload the user from MongoDB** — the token's `role` and `companyId` are informational only
3. reject if the account is missing or not `active`
4. for `cpo_admin` / `operator`, reject if their company is not `active` (mirrors `requireActiveCompany`)

Trusting the token here would have been a real inconsistency: Module 1 explicitly refused to
trust it for REST, and a socket is *longer*-lived than a request, so a stale claim would persist
for longer rather than less. The cost is the same indexed lookups — but **once per connection**
rather than once per request, which makes this the cheapest place in the project to apply the rule.

Rejection happens at the handshake, so an unauthenticated socket is never established at all.
The client-facing error is deliberately vague; the reason goes to the server log.

---

## 5. Rooms are server-assigned. There is no join path.

```
cpo_admin / operator  ->  company:{companyId}
driver                ->  user:{userId}
super_admin           ->  platform     (static)
```

Joined in the connection handler from the verified identity. **The server registers no listener
for a client-sent `join`** — not a validated one, none. If it honoured `socket.emit('join',
'company:B')` that would be the socket equivalent of trusting `req.body.companyId`, the exact
vulnerability class every module since Module 2 has closed. The safest validation is a code path
that does not exist.

Three rooms is the minimum that satisfies every scope. No station, charger or session rooms:
company staff already receive everything for their company, and a detail page filters on
`chargerId` / `sessionId` it already holds — a display concern, not a boundary.

The `platform` room is static so a super_admin needs no per-company subscriptions; every emit
goes to `company:{id}` **and** `platform`.

The driver's personal room is what makes cross-company charging work. A driver charging at
company B's station is never in `company:B` — often could not be — so without `user:{id}` they
would never learn their own charge had started.

---

## 6. Suspension must reach open sockets

Module 2 built live suspension so a token issued beforehand stops working on the **next REST
call**. A socket never makes another call: it is already open and would keep receiving broadcasts
indefinitely. Suspended staff would lose REST access while keeping a live feed of their own
chargers through a side door.

Two flagged cross-module edits:

| File | Module | Change |
| ---- | ------ | ------ |
| `services/company.service.ts` | 2 | `setCompanyStatus` → `disconnectCompany()` when not active |
| `services/user.service.ts` | 3 | `setUserStatus` → `disconnectUserSockets()` when not active |

The user case was not in the original brief. It was added because `User.status` has existed since
Module 1, REST already honours it, and the hole is identical one level down — fixing only the
company half would have been worse than fixing neither.

Verified live: suspending a driver drops their socket with `io server disconnect`, and they
cannot reconnect.

---

## 7. State consistency

```
OCPP message  ->  business logic  ->  DATABASE WRITE  ->  Socket.IO emit  ->  browser
```

Never the other way round. The database is the source of truth; Socket.IO is delivery. Emitting
first would let a client receive an event, refetch, and see **older** data than the event it was
just handed — and a failed write would leave the UI showing something that never happened.

Two consequences enforced in code:

- **Every emit is wrapped.** A dead socket or a serialisation failure must never propagate into a
  charging session. A browser problem is not a charging problem.
- **A rejected meter reading emits nothing.** If the monotonicity check drops a duplicate, no
  event is sent — otherwise the UI would display a number the database does not hold.

`realtime/publisher.ts` is the only place the app emits. Services import the publisher; the
publisher imports nothing from services, so the graph stays acyclic. It also tolerates not being
attached at all, so scripts and future worker processes behave exactly as before.

---

## 8. Frontend

| Piece | Job |
| ----- | --- |
| `context/SocketContext.tsx` | The app's ONE connection, tied to the logged-in user |
| `hooks/useSocketEvent.ts` | The ONLY way a listener is registered |
| `app/monitor/page.tsx` | Live operations dashboard (staff) |
| `app/sessions/[sessionId]` | Live session — the 3-second poll is gone |

**One socket, not one per component.** Per-component `io()` calls would open a connection each,
multiply every event by the number of listeners, and leak on navigation.

**`useSocketEvent` is how duplicate listeners are prevented.** "Be careful" is not a fix. The hook
registers in an effect and removes in its cleanup, so the count can never exceed one per mounted
component. The handler lives in a ref so an inline arrow function does not cause resubscribe
churn on every render. Nothing else in the app calls `socket.on`.

**Recovery, not replay.** Events sent while the browser was offline are gone. `reconnectCount`
increments on every successful connect, screens depend on it and refetch REST state — one request
restores the truth whether the gap was two seconds or ten minutes. The first connect is included,
so the normal path and the recovery path are the same code rather than two branches that drift.

**No Redux or Zustand.** There is no shared client state worth centralising: events arrive,
screens fold them into the state they already hold, nothing else reads it. A store would be a
layer whose only job is forwarding.

One React-Compiler-driven refinement worth recording: the socket is published to consumers from
the `connect` **callback**, not the effect body. That satisfies the `set-state-in-effect` rule and
is better semantics anyway — a socket that has not connected has nothing to deliver.

---

## 9. Verification — 49 checks

Real Socket.IO clients and a real OCPP WebSocket, no mocks.

| Area | Checks |
| ---- | ------ |
| Handshake auth (valid, missing, garbage, forged) | 9 |
| Client-sent `join` is inert | 1 |
| `charger:connectivityChanged` | 7 |
| `connector:statusChanged` | 5 |
| Session lifecycle events | 7 |
| `session:meterUpdate` incl. rejected readings | 6 |
| Completion | 3 |
| **Isolation, asserted as silence** | 4 |
| Forced disconnects | 7 |

**The isolation checks assert a negative**, which needs care: "received nothing" is only
meaningful if enough time passed for something to have arrived. The window is **8 seconds** —
longer than one full 5-second meter tick plus the OCPP round trips — and the suite proves the
window carried real traffic before concluding the rival saw none of it. It also asserts the rival
is still *connected*, so silence is not just a dropped socket.

### End-to-end, four processes

```
[8:23:29] ADMIN   session -> initiating      [8:23:29] DRIVER  session -> initiating
[8:23:29] ADMIN   connector 1 -> preparing
[8:23:29] ADMIN   session -> active          [8:23:29] DRIVER  session -> active
[8:23:30] ADMIN   connector 1 -> charging
[8:23:35] ADMIN   energy 0.083 kWh           [8:23:35] DRIVER  energy 0.083 kWh
[8:23:40] ADMIN   energy 0.167 kWh           [8:23:40] DRIVER  energy 0.167 kWh
[8:23:45] ADMIN   energy 0.250 kWh           [8:23:45] DRIVER  energy 0.250 kWh
[8:23:49] ADMIN   session -> stopping        [8:23:49] DRIVER  session -> stopping
[8:23:50] ADMIN   session -> completed       [8:23:50] DRIVER  session -> completed
                  (0.25 kWh, 20s)
RIVAL events: 0
```

Not one refetch in that sequence. Then, observed live: suspending the driver dropped their socket;
suspending the company dropped the admin's; the rival was unaffected.

---

## 10. Files

**New (backend)**: `realtime/{index,auth,rooms,publisher}.ts`
**Changed (backend)**: `server.ts`, `ocpp/handlers.ts`, `ocpp/gateway.ts`, `config/env.ts`
(none), `services/sessionEvents.service.ts`, `services/chargingSession.service.ts`,
`services/company.service.ts` *(Module 2, flagged)*, `services/user.service.ts` *(Module 3, flagged)*

**New (frontend)**: `context/SocketContext.tsx`, `hooks/useSocketEvent.ts`, `app/monitor/page.tsx`
**Changed (frontend)**: `app/layout.tsx`, `app/dashboard/page.tsx`, `app/sessions/[sessionId]/page.tsx`, `lib/config.ts`

`socketUrl` is derived from `NEXT_PUBLIC_API_BASE_URL` rather than configured separately — both
are served by the same HTTP server, and a second env var could drift out of step.

---

## 11. Known limits — say these before an interviewer finds them

- **Single instance only.** Socket.IO rooms live in one process's memory, exactly like Module 6's
  charger registry. Two backends behind a load balancer would each broadcast only to their own
  clients. The fix is the Socket.IO Redis adapter — deliberately deferred, same call as the OCPP
  registry.
- **No replay.** A client that was offline refetches REST rather than receiving missed events.
  Correct for an MVP; a durable log would be a different project.
- **No per-socket rate limiting.** A client cannot request rooms, so the exposure is small, but it
  is not nothing.
- **Reconnect refetches whole collections.** Fine at this scale; a delta endpoint would be the
  optimisation if a dashboard ever watched thousands of chargers.
- **Events carry no sequence number**, so a client cannot detect a gap on its own — it relies on
  the reconnect refetch.

---

## 12. What Module 9 adds

Tariffs: the first thing that turns `energyConsumedKwh` into money. The events defined here do
not change — a price is a property of a completed session, not a new real-time channel.
