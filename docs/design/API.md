# API Reference

Every endpoint, who may call it, and what it is for. **A reference table, deliberately not a
schema specification** — request and response shapes live with the code and its validators,
which cannot drift out of date the way a hand-maintained spec does.

**Base URL:** `http://localhost:5000/api/v1`

---

## Conventions

**Every response uses one envelope.** Success:

```json
{ "success": true, "message": "...", "data": { } }
```

Failure:

```json
{ "success": false, "message": "...", "errorCode": "...", "details": null }
```

> **The envelope is the source of truth, not the HTTP status.** The frontend has one response
> handler, written in Module 0 and unchanged since.

**Status codes used, and what each means here:**

| Code | Meaning in this project |
|---|---|
| `400` | The request is malformed — a bad path parameter, a broken query string, invalid JSON |
| `401` | No token, or a token that does not verify |
| `403` | Authenticated, but not permitted. Also returned to a company-scoped caller for ids that do not exist, so ids cannot be probed |
| `404` | The resource does not exist, for a caller entitled to know that |
| `409` | A conflict — a duplicate, or an illegal state transition |
| `413` | Body too large |
| `422` | Well-formed but not processable — a failed body validation, or a field the caller may not set |

**Authentication:** `Authorization: Bearer <jwt>` on everything except `/health`.
The user is **re-loaded from the database on every request** — a suspended account or company
loses access immediately rather than when its token expires.

**Company scoping:** every list and detail query is filtered by the caller's company,
server-side. A `companyId` in a query string is honoured **only for `super_admin`**; anyone
else naming one gets a visible refusal rather than a silent rescope.

---

## Health

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | none | Liveness, database state, uptime. Safe for a load balancer |

## Authentication

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/auth/register` | none | Self-registration. **Always creates a `driver`** — role is never client-supplied |
| `POST` | `/auth/login` | none | Exchange credentials for a JWT |
| `GET` | `/auth/me` | any | The caller resolved from their token, not from client storage |

## Companies

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/companies/me` | staff | The caller's own company |
| `GET` | `/companies` | super_admin | List every company |
| `POST` | `/companies` | super_admin | Create a company |
| `GET` | `/companies/:id` | super_admin | One company |
| `PATCH` | `/companies/:id` | super_admin | Update details |
| `PATCH` | `/companies/:id/status` | super_admin | Activate / suspend. **Suspension takes effect on the next request** |

## Users & Vehicles

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `PATCH` | `/users/me` | any | Update own profile. Role, status and company are **not** writable |
| `GET` | `/users/me/vehicles` | driver | Own vehicles |
| `POST` | `/users/me/vehicles` | driver | Add a vehicle |
| `GET` | `/users/me/vehicles/:id` | driver | One own vehicle |
| `PATCH` | `/users/me/vehicles/:id` | driver | Update own vehicle |
| `DELETE` | `/users/me/vehicles/:id` | driver | Retire own vehicle |
| `GET` | `/users` | super_admin, cpo_admin | List users in scope |
| `POST` | `/users` | super_admin, cpo_admin | Create staff or a driver |
| `GET` | `/users/:id` | super_admin, cpo_admin | One user in scope |
| `PATCH` | `/users/:id` | super_admin, cpo_admin | Update a user in scope |
| `PATCH` | `/users/:id/status` | super_admin, cpo_admin | Activate / suspend |

> There is **no** `/vehicles/:id`. A vehicle is only addressable under `/users/me/`, so another
> user's vehicle has no URL at all — the attack is unrepresentable rather than merely refused.

## Stations & Map

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/stations/map` | staff | Lightweight markers, company-scoped, with availability counts |
| `GET` | `/stations/public` | **any role** | **Active stations of active companies, across every company.** Carries the operator's brand as `operatorName`; company id and records stripped |
| `GET` | `/stations/public/cities` | any role | Cities that have a publicly listed station — the driver's City dropdown |
| `GET` | `/stations/cities` | staff | Cities among the caller's stations (company-scoped) — the staff City dropdown |
| `GET` | `/stations` | staff | Paginated admin list. `?search=` (name, code, address, **city, state, PIN**), `?city=` (exact), `?status=` |
| `POST` | `/stations` | super_admin, cpo_admin | Create a station |
| `GET` | `/stations/:id` | staff | One station |
| `PATCH` | `/stations/:id` | super_admin, cpo_admin | Update details |
| `PATCH` | `/stations/:id/status` | super_admin, cpo_admin | Activate / deactivate |

> `/stations/public` is the project's **one deliberately cross-company read**. "Public" describes
> the *content*, not the access — it still requires a token.
> **Route order matters:** `/map`, `/public`, `/public/cities` and `/cities` are declared before
> `/:stationId`.
>
> `?city=` is an **exact** (case-insensitive) match on purpose — it is a filter, not a search. That
> is why the UI offers it as a dropdown fed by `/cities`: a free-text box made "Delhi" silently miss
> stations stored as "New Delhi". A partial location goes in `?search=`.

## Chargers & Connectors

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/chargers` | staff | List, `?stationId=` |
| `POST` | `/chargers` | super_admin, cpo_admin | Create. **Returns the OCPP token once** |
| `GET` | `/chargers/:id` | staff | One charger |
| `PATCH` | `/chargers/:id` | super_admin, cpo_admin | Update details |
| `PATCH` | `/chargers/:id/status` | super_admin, cpo_admin | Administrative status |
| `POST` | `/chargers/:id/token` | super_admin, cpo_admin | Re-issue the OCPP token. **Shown once** |
| `GET` | `/chargers/:id/connection` | staff | Live connectivity |
| `GET` | `/chargers/:id/connectors` | staff | Connectors on this charger |
| `POST` | `/chargers/:id/connectors` | super_admin, cpo_admin | Add a connector |
| `GET` | `/chargers/:id/connectors/:cid` | staff | One connector |
| `PATCH` | `/chargers/:id/connectors/:cid` | super_admin, cpo_admin | Update a connector |
| `PATCH` | `/chargers/:id/connectors/:cid/status` | staff | Operational status |

> Connectors are **nested under their charger** — the parent is a path segment, never a body
> field, so a connector cannot claim a different parent.

## Charging Sessions

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/charging/connectors/:id` | any | What a driver sees before plugging in: plug type, power, **rate** |
| `POST` | `/charging/sessions` | driver | Start a charge. **Takes one id — the connector** |
| `GET` | `/charging/sessions/active` | staff | Sessions in progress |
| `GET` | `/charging/sessions` | any | Own sessions (driver) or company's (staff). `?active=true` |
| `GET` | `/charging/sessions/:id` | owner, staff | One session |
| `GET` | `/charging/sessions/:id/readings` | owner, staff | Meter time-series for one session |
| `POST` | `/charging/sessions/:id/stop` | owner, operator+ | Stop a charge. Staff **must** send `{ "reason": "…" }` (422 otherwise) — the driver is notified with it, and it is stored as `stoppedByRole` / `stopNote` |

Session responses carry display labels resolved at read time — `companyName` (the operator),
`stationName`, `stationAddress`, `stationCity`, `chargerName`, `powerKw`, and for staff
`driverName` / `driverEmail`. Real-time `session:statusChanged` pushes carry the same labels for
sessions started since the server booted; clients merge a push onto the row they already have.

> Everything else — charger, station, company, tariff — is **derived** from the connector. A
> mismatched set of ids cannot be submitted because only one id is accepted.

`POST /charging/sessions` refuses with **409** for five distinct reasons, each with a message
written to be shown to a driver as-is:

| Cause | Message names |
|---|---|
| **Driver already has a charge in progress** (one account, one car) — checked first | where it is running; `details.activeSessionId` lets the app link to it |
| Connector faulted, occupied or charger offline | which of those it is |
| Charger not connected to the OCPP gateway | the charger's `ocppId` |
| Operator has published no active tariff | that the station has no price |
| Driver has an unpaid balance | the amount owed, and that a top-up clears it |

The last carries `details: { outstandingPaise, unpaidSessions }` so a client can render the
figure without parsing the sentence. Only debt older than 15 minutes counts — settlement is
asynchronous, and a session that just ended is legitimately unpaid for as long as the debit
takes to clear.

## Tariffs

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/tariffs` | staff | List, `?status=` |
| `POST` | `/tariffs` | super_admin, cpo_admin | Create. Price in **rupees**, stored as paise |
| `GET` | `/tariffs/:id` | staff | One tariff |
| `PATCH` | `/tariffs/:id` | super_admin, cpo_admin | Update name or price |
| `PATCH` | `/tariffs/:id/status` | super_admin, cpo_admin | Activate. **Deactivates the incumbent** |

> A company with **no active tariff cannot sell electricity** — charging is refused before any
> session or payment logic runs.

## Wallet & Payments

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/wallet` | driver | Balance and what is still owed |
| `GET` | `/wallet/transactions` | driver | Own ledger |
| `POST` | `/wallet/recharge/order` | driver | Create a Razorpay order. ₹10–₹10,000 |
| `POST` | `/wallet/recharge/verify` | driver | **Server verifies the HMAC**, then credits |
| `GET` | `/payments` | driver, cpo_admin, super_admin | Payments in scope — own (driver) or company's (admin). Not operators: they see no revenue |
| `GET` | `/payments/:id` | owner, cpo_admin, super_admin | One payment |
| `POST` | `/payments/:id/refund` | super_admin, cpo_admin | Reverse a recharge |
| `POST` | `/payments/webhook/razorpay` | signature | Provider callback. Verified over the **raw body** |

> There is **no endpoint that sets a wallet balance**. Money moves only through verified
> recharges and session settlement.

## Complaints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/complaints` | driver | File a ticket. One anchor id; the rest is derived |
| `GET` | `/complaints` | any | Own (driver) or company's (staff) |
| `GET` | `/complaints/:id` | owner, staff | One complaint, with the disputed session if any |
| `PATCH` | `/complaints/:id` | staff | `priority`, `note` (appends an **internal** work note), `resolution` (draft reply to the driver). Subject/description/category are immutable |
| `PATCH` | `/complaints/:id/status` | staff | Move through the workflow. **`closed` is terminal**. Operators may resolve hardware/site/session tickets; payment/account resolution, closing, and overturning a resolution are admin-only |
| `POST` | `/complaints/:id/assign` | staff | `{ "assigneeId": id \| null }`. Operators take or release their own; admins assign any staff who can see the ticket |
| `POST` | `/complaints/:id/confirm` | driver | Resolved → closed ("yes, it is fixed") |
| `POST` | `/complaints/:id/reopen` | driver | Resolved → open, reason required |

`GET /complaints` also takes `?assigned=me|unassigned` (staff). Every complaint carries a
`ticketRef` (`CMP-XXXXXX`) and read-time context: `companyName`, `station`, `charger`,
`connectorNumber`, and for staff `reporter` (name, email, phone), `assigneeName` and `notes`.
Drivers never receive `notes` or an assignee.

## Notifications

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/notifications` | any | Own notifications, `?unread=true` |
| `GET` | `/notifications/unread-count` | any | Badge count, computed server-side |
| `PATCH` | `/notifications/:id/read` | owner | Mark read. **Idempotent** |
| `PATCH` | `/notifications/read-all` | any | Mark all read |

> **No POST** — notifications come from business events, never from a client. **No role check
> anywhere** — ownership is the only boundary, identical for a driver and a super_admin.

## Analytics

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/analytics/overview` | staff | Summary cards. **Omits `revenue` for an operator** |
| `GET` | `/analytics/sessions` | staff | Sessions and energy per day |
| `GET` | `/analytics/revenue` | super_admin, cpo_admin | Revenue per day. **403 for an operator** |
| `GET` | `/analytics/stations` | staff | Per-station breakdown |

All take `?from=&to=` as `YYYY-MM-DD`. **UTC, both ends inclusive.** Default: last 30 days.

> Revenue means **paid `session_debit` payments only** — a wallet top-up is a customer deposit,
> not income.

## OCPP (WebSocket, not REST)

```
ws://localhost:5000/ocpp/<ocppId>
Authorization: Basic base64(<ocppId>:<authToken>)
```

Charger → server: `BootNotification`, `Heartbeat`, `StatusNotification`, `Authorize`,
`StartTransaction`, `MeterValues`, `StopTransaction`
Server → charger: `RemoteStartTransaction`, `RemoteStopTransaction`

## Socket.IO (browser real-time)

```
ws://localhost:5000/socket.io   auth: { token: <jwt> }
```

| Event | Audience |
|---|---|
| `charger:connectivityChanged` | company + platform |
| `charger:hardwareStatusChanged` | company + platform |
| `connector:statusChanged` | company + platform |
| `session:statusChanged` | company + the session's driver |
| `session:meterUpdate` | company + the session's driver |
| `notification:new` | that user only |

> **Rooms are server-assigned.** There is no join handler — a client cannot subscribe to
> anything, because there is no code path to ask.

---

## Roles

| | super_admin | cpo_admin | operator | driver |
|---|---|---|---|---|
| Companies | all | own | own (read) | ✗ |
| Users | all | own company | ✗ | own profile |
| Stations / Chargers | all | own | own (read) | ✗ |
| Charging sessions | all | own company | own company | own |
| Tariffs | all | own | read | ✗ |
| **Revenue / Payments** | ✓ | ✓ | **✗** | own |
| Complaints | all | own company | own company | own |
| Station discovery | ✓ | ✓ | ✓ | ✓ |
