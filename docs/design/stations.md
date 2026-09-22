# Station Management

**Status:** ✅ Complete
**Depends on:** Module 1 (auth, RBAC), Module 2 (company scoping), Module 3 (nothing directly)

---

## 1. Purpose

A **station** is the physical *site* where chargers are installed — a mall car park, a highway
plaza, an office basement. It is a **place**, not a machine.

```
Station  "Connaught Place, New Delhi"     <- a location
  └── Charger  DEL-014                    <- a machine at that site      (Module 5)
        ├── Connector 1  CCS2   60kW      <- what a car plugs into       (Module 5)
        └── Connector 2  Type2  22kW
```

A charging **session** happens on a *connector*, not on a station.

**Why Station is its own entity:** location data belongs to the site, not the machine. Ten
chargers in one car park share one address, one set of coordinates and one set of opening
hours. Repeating that on every charger would duplicate data and let it drift.

**Why this module exists now:** Module 5's chargers need a `stationId` to belong to. This
creates the parent.

## 2. Where it fits

```
Company ──1:N──▶ Station ──1:N──▶ Charger ──1:N──▶ Connector ──▶ ChargingSession
 (M2)             (M4)             (M5)             (M5)            (M7)
```

Module 4 is the **first ordinary resource to use `applyCompanyScope`**. Module 2's Company was
a special case — the resource *was* the tenant, so the filter was on `_id` and a `/companies/me`
endpoint existed. A Station merely *has* a `companyId`, so the standard pattern applies and no
`/me` variant is needed.

## 3. Entity — `Station`

| Field | Type | Req | Why it exists |
|---|---|---|---|
| `companyId` | ObjectId → Company | ✅ | The owner. Every scoped query filters on it |
| `name` | String | ✅ | Human label — "Connaught Place" |
| `stationCode` | String | ✅ | Operator-facing identifier, **unique per company**, uppercased |
| `address` | String | ✅ | Street line |
| `city` / `state` / `country` | String | ✅ | Filtering and display |
| `postalCode` | String | ❌ | Not universally available |
| `latitude` | Number | ✅ | −90 … 90 |
| `longitude` | Number | ✅ | −180 … 180 |
| `status` | enum | ✅ | `active` \| `inactive` \| `suspended`, default `active` |
| `contactPhone` | String | ❌ | Someone to call when a site is blocked |
| `openingHours` | String | ❌ | Free text — see below |
| `createdBy` | ObjectId → User | ✅ | Audit trail |
| timestamps | | auto | |

**Deliberately excluded:** amenities, photos, parking fees, ratings, per-day opening schedules,
charger counts (derived in Module 5).

**`openingHours` is free text on purpose.** A structured per-day schedule is a real feature with
real complexity — holidays, split shifts, timezones — and has no consumer yet.

### Why `stationCode` is unique **per company**, not globally

Two different CPOs may legitimately both use `DEL-001`. A global unique constraint would let one
company's naming block another's — and worse, a 409 would *leak the existence* of a competitor's
station. Enforced by a compound unique index.

It is not decoration: you cannot tell a field technician *"go to station
6aa67fa3288a53fa0f21130f"*.

### Indexes — each justified

| Index | Why |
|---|---|
| `{ companyId: 1 }` | **Every** scoped query filters on it |
| `{ companyId: 1, stationCode: 1 }` **unique** | Enforces per-company uniqueness at the database, so two concurrent creates cannot both slip through |
| `{ companyId: 1, status: 1 }` | The common list view — "my company's active stations" |
| `status` | Standalone filter |

**No `2dsphere` index.** There is no geospatial query in this module, and an unused geo index
costs write performance for nothing. See §9.

## 4. Permissions

| Action | super_admin | cpo_admin | operator | driver |
|---|:-:|:-:|:-:|:-:|
| `POST /stations` | ✅ any company | ✅ own company only | ❌ 403 | ❌ 403 |
| `GET /stations` | all | own company | own company | ❌ 403 |
| `GET /stations/:id` | any | own only | own only | ❌ 403 |
| `PATCH /stations/:id` | ✅ | ✅ own | ❌ 403 | ❌ 403 |
| `PATCH /stations/:id/status` | ✅ all statuses | ✅ `active`/`inactive` only | ❌ 403 | ❌ 403 |

### Why `operator` is read-only here

A station is an **administrative** record — address, coordinates, opening hours. Operators
*operate chargers*, which arrive in Module 5. Granting station write access now would be
speculative, and it would reverse the precedent set in Module 3 (operators got zero
user-management access for the same reason). Revisit when Module 6 or 8 creates a real
operational trigger.

### Why there is no driver-facing station endpoint

A station with **no chargers, no connectors and no availability data** is not useful to a
driver — which is exactly the information they need. Building the public read now would
guarantee rebuilding it once Module 5 exists. Deferred to Module 5 or 14, whichever needs it
first. **This is tested**, not merely unspecified: drivers get 403 on every station route, and
`/stations/public` does not exist.

> **RESOLVED IN MODULE 14.** Module 5 supplied the connectors and Module 6 gave them live
> status, so the information that was missing now exists and `GET /stations/public` was built
> for the map. The deferral was correct: it was cashed in exactly when something needed it.
>
> What did **not** change: a driver still has **no administrative access** to stations — 403 on
> the list, the detail, create, update and status routes. And the new endpoint still requires a
> token; "public" describes the *content* of the response, not the access to it.
>
> Module 14 also made it the project's **first deliberately cross-company read**, so it filters
> on two levels — the station must be active **and** its owning company must be active, or a
> suspended CPO would keep advertising to drivers through the one route that does not apply
> company scope.

## 5. Status — a deliberate permission split

| Status | Meaning | Who may set it |
|---|---|---|
| `active` | In service | super_admin, cpo_admin |
| `inactive` | Temporarily out of service — construction, seasonal closure, site access blocked. **The CPO's own operational switch** | super_admin, cpo_admin |
| `suspended` | **A platform sanction** — compliance, billing, policy | **super_admin only** |

Two guards in `station.service.ts`:

1. Only a super_admin may **set** `suspended`.
2. Only a super_admin may move a station **away from** `suspended`.

Without the second, a cpo_admin could simply clear a suspension the platform applied, making
the sanction meaningless. They still control `active`/`inactive`, which is what they actually
need to take a broken site offline without waiting on the platform.

This is a considered departure from Module 2, where **all** company status changes are
super_admin-only. The difference: a company is the tenant itself, whereas a station is
operational equipment its owner must be able to manage day to day.

## 6. API

| Method | Path | Who | Notes |
|---|---|---|---|
| `POST` | `/stations` | super_admin, cpo_admin | `companyId` required for super_admin, **derived from the token** for cpo_admin |
| `GET` | `/stations` | all three admin roles | Paginated; `?page=&limit=&status=&city=&companyId=&search=` |
| `GET` | `/stations/:stationId` | all three admin roles | Scoped |
| `PATCH` | `/stations/:stationId` | super_admin, cpo_admin | Strict schema **rejects** `status` and `companyId` |
| `PATCH` | `/stations/:stationId/status` | super_admin, cpo_admin | The only route that changes status |

**No `DELETE`.** Stations will own chargers (M5) and, transitively, sessions and revenue (M7).
Deleting would orphan them. Use `inactive`.

Codes: `200` · `201` · `400` malformed id/query · `401` no token · `403` wrong role, wrong
company, or insufficient rights for `suspended` · `404` unknown station (super_admin) or unknown
company · `409` duplicate `stationCode` within a company · `422` validation.

## 7. Creation security

The attack this prevents: `cpo_admin_A` posts `{ "companyId": "<company B>" }` and plants a
station inside a competitor's network — which they could then read back, because by the
ownership filter it would be "theirs".

```
super_admin  → must supply companyId (they may create for any company)
cpo_admin    → companyId taken from their token
               a body companyId that isn't theirs → 403, not silently overwritten
operator     → cannot create at all
```

Rejecting rather than quietly overwriting keeps the attempt **visible** in the logs — the same
reasoning behind our `.strict()` schemas.

Identical treatment for the list filter: `GET /stations?companyId=B` from a scoped role is
**403**, not silently reset to their own company.

## 8. Scoping

```ts
// list — untouched for super_admin, { companyId: theirs } for everyone else
const filter = applyCompanyScope(actor, base);

// single — a scoped caller cannot match another company's row
const station = await Station.findOne(applyCompanyScope(actor, { _id: stationId }));
```

**Error-code choice:** a company-scoped caller gets **403** for a station outside their company
*and* for an id that doesn't exist — otherwise 404-vs-403 would let them probe which station ids
are real platform-wide. `super_admin` gets **404** for a genuinely missing id. Same rule as
Module 3.

## 9. Deferred to Module 14 — geospatial

Module 14's map needs `$near` queries, which require a GeoJSON `location` field and a
`2dsphere` index. **Deliberately not added now**, because there is no geospatial query yet.

> **MODULE 14 CORRECTED THIS PREDICTION, and the deferral SURVIVES.**
>
> The map does not need `$near`. **Drawing** a marker needs two numbers; **selecting rows by
> proximity** needs GeoJSON and a `2dsphere` index — and nearby-station search was explicitly
> out of Module 14's scope. So no geo index was added, because an unused one costs write
> performance on every station write to serve zero reads.
>
> The trigger is now named precisely: **the first `$near` query** — a radius filter, or
> "stations near me" sorted by distance. Everything below still applies when that day comes.

The migration is **additive and non-breaking**: add a `location: { type: 'Point', coordinates:
[longitude, latitude] }` field, backfill it from the existing numbers, and create the index. No
data loss, no contract change. Recorded here so it isn't forgotten.

## 10. Verification — 87 automated checks, all passing

### The scoping matrix

Company A (stations `A1`, `A2`) · Company B (station `B1`).

| Actor | A1 | A2 | B1 | `GET /stations` | Create for B |
|---|:-:|:-:|:-:|:-:|:-:|
| super_admin | 200 | 200 | 200 | all three | ✅ 201 |
| cpo_admin_A | 200 | 200 | **403** | A only | **403** |
| operator_A | 200 | 200 | **403** | A only | **403** (no create) |
| cpo_admin_B | **403** | **403** | 200 | B only | — |
| operator_B | **403** | **403** | 200 | B only | — |
| driver | **403** | **403** | **403** | **403** | **403** |
| anonymous | **401** | **401** | **401** | **401** | **401** |

Also asserted: a cpo_admin's list contains **only** their company's stations and never the other
company's; `?companyId=<other>` → 403; super_admin *can* filter by company.

### Status split

cpo_admin sets `inactive` ✅ · sets `active` ✅ · sets `suspended` **403** · super_admin
suspends ✅ · cpo_admin tries to clear the suspension **403** · super_admin clears it ✅.

### Creation security

cpo_admin creating under company B **403** · operator creating **403** · operator updating
**403** · operator changing status **403** · super_admin without `companyId` **422** · unknown
`companyId` **404**.

### Validation

`latitude` 91 and −91 → 422 · `longitude` 181 and −181 → 422 · missing name/city → 422 ·
malformed `companyId` → 422 · malformed `stationId` → **400** · unknown station → **404**
(super_admin) / **403** (scoped) · duplicate `stationCode` in the same company → **409** ·
**the same `stationCode` in a different company → 201** (proves per-company uniqueness) ·
`status` or `companyId` in the general PATCH → 422 · unknown field → 422 · empty update → 422 ·
invalid status value → 422.

### Regression

Module 1 **36/36**, Module 2 **82/82**, Module 3 **102/102** — all re-run green. Frontend
typechecks, lints and builds clean; all 17 routes serve; guards engage.

## 11. Frontend

| Route | Roles | Content |
|---|---|---|
| `/stations` | super_admin, cpo_admin, operator | List, search, status filter |
| `/stations/new` | super_admin, cpo_admin | Create (company selector for super_admin only) |
| `/stations/[stationId]` | all three | Detail, edit, status controls |

The detail page shows **no charger data** — that's Module 5. Status buttons mirror the backend
split: a cpo_admin sees active/inactive; only a super_admin sees Suspend / Lift suspension. A
station suspended by the platform shows a locked banner to its CPO.

## 12. Changes to previous modules

- `routes/index.ts` — mounts `/stations`.
- `scripts/seedDemoCompanies.ts` — now also seeds three demo stations (two for Livanto Green,
  one for Sharma Energy). Seed script only; no runtime impact.

**No API contract from Modules 1–3 was altered.**

## 13. Known state / notes

- Demo stations: `DEL-CP-01` and `DEL-AC-02` (Livanto Green), `MUM-AE-01` (Sharma Energy).
- No station deletion — by design (§6).
- `city` filter is an exact, case-insensitive match; `search` is a regex across name, code and
  address and is **unindexed** — a conscious acceptance at demo scale.
- No geospatial index (§9).

## 14. What Module 5 will add

`Charger` and `Connector` models owned by a Station, inheriting the company through it — which
raises the first question this module doesn't answer: whether a charger's company scope is read
from its own `companyId` (denormalised) or resolved through its station. That decision belongs
to Module 5.
