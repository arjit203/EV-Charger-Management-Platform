# Module 5 — Charger & Connector Management

**Status:** ✅ Complete
**Depends on:** Module 1 (auth, RBAC), Module 2 (company scoping), Module 4 (stations)

---

## 1. Purpose

Module 4 created the **site**. Module 5 creates the **hardware installed at it**.

```
Company ──▶ Station ──▶ Charger ──▶ Connector ──▶ ChargingSession
  (M2)        (M4)       (M5)        (M5)           (M7)
```

- **Charger (EVSE)** — the physical machine. *Electric Vehicle Supply Equipment.*
- **Connector** — an individual plug on that machine. One car occupies one connector.

**Why they are separate entities:** a two-plug charger can have one connector occupied and one
free — two independent states on one machine, which a flat field cannot represent. And Module 7's
session must reference *which* plug is in use, so a connector needs a stable `_id`.

**Why now:** Module 6's OCPP gateway resolves an incoming charger connection to a row in the
`chargers` collection. Without these records there is nothing to match against.

## 2. Entities

### Charger

| Field | Type | Req | Why |
|---|---|---|---|
| `stationId` | → Station | ✅ | Parent site. **Immutable** |
| `companyId` | → Company | ✅ | **Denormalised** from the station — see §3 |
| `name` | String | ✅ | Human label |
| `chargerCode` | String | ✅ | Site-facing label, **unique per station** |
| `ocppId` | String | ✅ | **Globally unique** — see §4 |
| `manufacturer`, `model` | String | ✅ | Asset management |
| `chargerType` | enum | ✅ | `AC` \| `DC` |
| `powerKw` | Number | ✅ | 1–1000. Maximum output |
| `firmwareVersion` | String | ❌ | Recorded only — no firmware management |
| `status` | enum | ✅ | `available` \| `unavailable` \| `faulted` \| `maintenance` |
| `createdBy` | → User | ✅ | Audit |

### Connector

| Field | Type | Req | Why |
|---|---|---|---|
| `chargerId` | → Charger | ✅ | Parent machine. **Immutable** |
| `connectorNumber` | Number | ✅ | 1–8, **unique per charger**. OCPP addresses connectors by number |
| `connectorType` | enum | ✅ | `CCS2` \| `CHAdeMO` \| `Type2` \| `GBT` — **shared with Vehicle** |
| `powerKw` | Number | ✅ | This plug's rating, may be below the charger's maximum |
| `status` | enum | ✅ | `available` \| `occupied` \| `faulted` \| `unavailable` |
| `errorCode` | String | ❌ | Nullable. Module 6 populates from OCPP fault reports |

**Connector types are shared with Module 3's `Vehicle` on purpose.** The constant moved to
`constants/connector.ts` and `constants/vehicle.ts` re-exports it, so Module 7 can answer "does
this car fit this plug" — which only works if both sides use one enum.

## 3. `companyId` is denormalised onto Charger — and why that is safe

Chargers could resolve their company through their station. They don't; the company is stored
directly.

**Why it cannot go stale:** a station can **never change company**. Module 4's update schema has
no `companyId` field and rejects one with 422, and the station form disables the company selector
when editing. The mirror has nothing to drift from.

**What it buys:**
- `applyCompanyScope` works directly on Charger — the same one-line pattern as Station, with no
  `$lookup` or two-step query.
- Module 6's gateway looks a charger up by `ocppId` on **every connection** and immediately needs
  its company. A join on that path would be paid constantly.

**How it stays correct:** set **once at creation, server-side, copied from the verified station**.
Never accepted from a request body, never updatable. `stationId` is likewise immutable —
relocating hardware between sites is a deliberate later feature, not an accident.

**Connector carries no `companyId`.** Connectors are always reached through their charger, so the
company is verified once at the charger hop. Adding one would be denormalisation with no query to
serve. If Module 8 later needs a flat "all my connectors" view, adding it is additive.

## 4. `ocppId` is GLOBALLY unique — deliberately the opposite rule to every other identifier

| Identifier | Uniqueness scope |
|---|---|
| `stationCode` (M4) | per **company** |
| `chargerCode` (M5) | per **station** |
| **`ocppId` (M5)** | **globally, platform-wide** |

**Why.** When a charger connects in Module 6 it sends a `BootNotification` carrying only this
identity. The gateway has **no company context at that moment** — it must answer *"which charger
record is this?"* across the entire platform. If two companies could share an identity, the
gateway could not tell which hardware connected, and could route a remote start command to the
wrong company's charger.

**Accepted trade-off:** a 409 here reveals that *some* other company already uses that identity —
a minor information leak. It is the correct trade: in practice these are vendor serial numbers,
so collisions are unlikely, and an unroutable charger connection would be far worse.

This is flagged in the model's code comment so nobody "corrects" it for consistency later.

## 5. The ownership chain — the core security work

Security must hold at **every hop**, not just the last. The technique is unchanged from
Modules 2–4: fetch the parent **through the caller's company scope**, so a parent belonging to
another company is simply not found.

```ts
// Creating a charger — HOP 1
const station = await Station.findOne(applyCompanyScope(actor, { _id: input.stationId }));
if (!station) throw <403 scoped | 404 super_admin>;

// companyId comes from the VERIFIED station, never from the request body
await Charger.create({ ...input, stationId: station._id, companyId: station.companyId });

// Any connector operation — HOP 2, then the connector is filtered by chargerId alone
const charger = await assertChargerInScope(actor, chargerId);
await Connector.findOne({ _id: connectorId, chargerId: charger._id });
```

**Connectors are nested under their charger in the URL (`/chargers/:chargerId/connectors`) for
exactly this reason** — the shape forces the parent to be resolved through company scope on
*every* connector call, including list.

**Error codes:** a company-scoped caller gets **403** for a charger or station outside their
company **and** for an id that doesn't exist, so the endpoints cannot be used to probe which
resources are real. `super_admin` gets **404** for a genuinely missing id. Within a charger's own
namespace a missing connector is a plain **404** — the company check already happened.

## 6. Permissions

| Action | super_admin | cpo_admin | operator | driver |
|---|:-:|:-:|:-:|:-:|
| Create charger / connector | ✅ any company | ✅ own company | ❌ 403 | ❌ 403 |
| Read charger / connector | all | own company | own company | ❌ 403 |
| Update charger / connector | ✅ | ✅ own | ❌ 403 | ❌ 403 |
| Change either status | ✅ | ✅ own | ❌ 403 | ❌ 403 |

**Operator is read-only**, consistent with Modules 3 and 4. There is no charger *operation* to
perform yet — remote commands arrive in Module 6 and monitoring in Module 8, and that is where a
genuine write need would first appear.

## 7. Status — independent by design

| Charger | Connector |
|---|---|
| `available` · `unavailable` · `faulted` · `maintenance` | `available` · `occupied` · `faulted` · `unavailable` |

**Setting a charger to `maintenance` does NOT cascade to its connectors.** This is static,
admin-entered data that Module 6 will entirely supersede with real OCPP `StatusNotification`
events — which arrive **per connector**, from the hardware. Inventing cascade rules now would
mean writing logic that gets removed in one module, and which could then contradict the real
data. **Verified by test.**

**Names are lowercase, not OCPP's PascalCase** (`Available`, `Preparing`, `Charging`…). Protocol
values should not leak into the domain model — translating them is precisely the gateway's job.
Module 6 will additively extend the connector enum with the states hardware reports.

**No connectivity fields yet.** `isOnline` / `lastHeartbeatAt` are set *by the gateway*. Adding
them now would mean every charger displaying "Offline" forever with nothing able to change it — a
UI that lies. Module 6 adds them when something can write them.

## 8. API

| Method | Path | Who |
|---|---|---|
| `POST` | `/chargers` | super_admin, cpo_admin |
| `GET` | `/chargers` | all three admin roles — `?stationId=&status=&chargerType=&manufacturer=&companyId=&search=` |
| `GET` | `/chargers/:chargerId` | all three |
| `PATCH` | `/chargers/:chargerId` | super_admin, cpo_admin — rejects `stationId`, `companyId`, `status` |
| `PATCH` | `/chargers/:chargerId/status` | super_admin, cpo_admin |
| `GET·POST` | `/chargers/:chargerId/connectors` | read: all three · create: admins |
| `GET·PATCH` | `/chargers/:chargerId/connectors/:connectorId` | |
| `PATCH` | `/chargers/:chargerId/connectors/:connectorId/status` | super_admin, cpo_admin |

**No DELETE anywhere.** Chargers will own sessions and revenue from Module 7, and connectors are
referenced by every session. Taking hardware out of service is a status change. This also
satisfies the "deleting a parent with dependents" integrity rules structurally: **the destructive
operation does not exist**, so there is no cascade to get wrong. Verified — `DELETE` on a charger,
a connector and a station all return 404.

Codes: `200` · `201` · `400` malformed id · `401` no token · `403` wrong role or wrong company ·
`404` unknown (super_admin) or unknown connector · `409` duplicate `ocppId`, `chargerCode` or
`connectorNumber` · `422` validation.

## 9. Indexes — each justified

| Index | Why |
|---|---|
| Charger `{ companyId }` | Every scoped query |
| Charger `{ stationId }` | "Chargers at this station" |
| Charger `{ ocppId }` **unique** | §4 — Module 6's lookup on every connection |
| Charger `{ stationId, chargerCode }` **unique** | §4 table |
| Charger `{ companyId, status }` | Filtered list |
| Connector `{ chargerId }` | Every connector query |
| Connector `{ chargerId, connectorNumber }` **unique** | One connector per position, at the database |

## 10. Verification — 99 automated checks, all passing

### The scoping matrix

Company A (Station A1 → Charger A1 → Connector 1, 2) · Company B (Station B1 → Charger B1 → Connector 1).

| Actor | Charger A1 | Charger B1 | Connectors of B1 | Create in B's station |
|---|:-:|:-:|:-:|:-:|
| super_admin | 200 | 200 | 200 | ✅ 201 |
| cpo_admin_A | 200 | **403** | **403** | **403** |
| operator_A | 200 | **403** | **403** | **403** (no create) |
| cpo_admin_B | **403** | 200 | 200 | — |
| operator_B | **403** | 200 | 200 | — |
| driver | **403** | **403** | **403** | **403** |
| anonymous | **401** | **401** | **401** | **401** |

### Uniqueness rules

Duplicate `chargerCode` at the same station → **409**; the **same code at a different station →
201**. Duplicate `ocppId` within one company → **409**; duplicate `ocppId` **across companies →
409**, proving global uniqueness. Duplicate `connectorNumber` on one charger → **409**.

### Ownership chain

cpo_admin_A creating a charger in company B's station → **403** · creating a connector on company
B's charger → **403** · updating company B's connector → **403**, and B's connector re-read to
confirm it was **unmodified** · a connector id from another charger requested through charger A →
**404**.

### Independence

Setting charger A1 to `maintenance` leaves its connector statuses **byte-identical** — asserted by
comparing the list before and after.

### Validation

`powerKw: 0` → 422 · bad `chargerType` → 422 · `connectorNumber` 0 and 9 → 422 · bad
`connectorType` → 422 · `chargerId` in a connector body → 422 · `stationId`, `companyId` or
`status` in a charger PATCH → 422 · malformed ids → 400 · unknown charger → 404 (super_admin) /
403 (scoped) · invalid status values → 422 · empty update → 422.

### Regression

Module 1 **36/36**, Module 2 **82/82**, Module 3 **102/102**, Module 4 **87/87** — all green.
**406 checks total.** Frontend typechecks, lints and builds clean; all 20 routes serve.

## 11. Frontend

| Route | Roles | Content |
|---|---|---|
| `/chargers` | all three | List, search, type and status filters, `?stationId=` filter |
| `/chargers/new` | super_admin, cpo_admin | Create; station picker scoped to what they can see |
| `/chargers/[chargerId]` | all three | Detail, edit, status + **connector management inline** |

Connectors live on the charger page rather than a route of their own — they are never meaningful
in isolation, and it mirrors the nested API. Station detail now links through to its chargers.

No OCPP command buttons, no live data, no meter charts.

## 12. Changes to previous modules

- `routes/index.ts` — mounts `/chargers`.
- `constants/vehicle.ts` — **one line**: `CONNECTOR_TYPES` moved to `constants/connector.ts` and
  re-exported, so Vehicle and Connector share one enum (§2).
- `scripts/seedDemoCompanies.ts` — now also seeds four chargers and five connectors.
- `stations/[stationId]/page.tsx` — links to that station's chargers.

**No API contract from Modules 1–4 was altered.**

## 13. Known state / notes

- Demo data: Livanto Green has `LIV-DEL-CP-01-A` (CCS2 + CHAdeMO), `LIV-DEL-CP-01-B` (Type2),
  `LIV-DEL-AC-02-A` (CCS2); Sharma Energy has `SHA-MUM-AE-01-A` (CCS2).
- Statuses are set manually and mean nothing operationally until Module 6.
- `firmwareVersion` is recorded but firmware management is not implemented.
- `search` is an unindexed regex across name, code, `ocppId` and model — acceptable at demo scale.

## 14. What Module 6 will add

The OCPP gateway (a `ws` server on the existing HTTP server) and the simulated charger. It will
look chargers up by `ocppId`, add connectivity fields (`isOnline`, `lastHeartbeatAt`), extend the
connector status enum with the states hardware reports, and begin driving these records from real
messages instead of admin input.
