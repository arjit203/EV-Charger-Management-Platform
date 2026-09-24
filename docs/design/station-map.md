# Charging Station Map

> **Revised later (real-world pass):** `/stations/public` now carries `operatorName`; city dropdown endpoints added — see `docs/learning/fixes-real-world-pass.md` and `API.md`.

**Status:** Complete · 72 Module 14 API checks + 46 browser checks, **1221 across Modules 1–14**
**Depends on:** Module 4 (coordinates), Module 5 (connectors), Module 6 (connector status)
**Resolves:** two deferrals Module 4 recorded — one cashed in, one deliberately kept

---

## 1. Purpose

Turn the `latitude` / `longitude` Module 4 has stored since the beginning into a map, for all
four roles.

It is a small module with two genuinely consequential decisions, both inherited from Module 4:

| Module 4 said | Module 14 decided |
|---|---|
| *"Module 14's map needs `$near` queries"* (§9) | **Wrong — and the deferral stays.** See D1 |
| *"`/stations/public` does not exist… deferred to Module 5 or 14"* (§4) | **Built here.** See D2 |

---

## 2. D1 — The GeoJSON deferral **stays deferred**. This module does not trigger it.

Module 4 §9 predicted that this module would need `$near`, a GeoJSON `location` field and a
`2dsphere` index. **That prediction was wrong**, and it is worth being precise about why,
because the distinction is the whole of this decision:

| Operation | What it needs |
|---|---|
| **Draw these stations on a map** | latitude + longitude. Two numbers. |
| **Find stations within 10 km of me** | GeoJSON + `2dsphere` + `$near` |

Module 14 does the first. The second — *nearby-station recommendation* — is **explicitly out of
this module's scope**. So no `2dsphere` index was added, because an unused geo index costs write
performance on every station write to serve exactly zero reads.

**The trigger is now named precisely: the first `$near` query.** A radius filter, or "stations
near me" sorted by distance. Module 4's migration note stays on the books — still additive, still
non-breaking, still unnecessary.

---

## 3. D2 — `/stations/public` is built here, and it is the project's first cross-company read

Module 4 deferred it for a reason that has since expired:

> *"A station with no chargers, no connectors and no availability data is not useful to a driver…
> Deferred to Module 5 or 14, whichever needs it first."*

Module 5 built connectors, Module 6 gave them live status. **The missing information now exists.**

### Two endpoints, not one — because the difference is a scope rule, not a projection

Module 13 set a precedent for shaping *one* endpoint by role (the operator's missing `revenue`).
That precedent is deliberately **not** followed here:

```
/stations/map      applyCompanyScope(actor, …)   "stations belonging to MY company"
/stations/public   NO company scope, by design   "active stations across EVERY company"
```

> **This is the first deliberately cross-company read in the project.** Every query since
> Module 2 has been narrowed by `applyCompanyScope`.

Burying that inversion inside a role branch of a shared function would hide the single most
security-sensitive line in the module — and the next person to edit that function would not see
the exception. So it gets its own file (`services/stationMap.service.ts`), its own route, its own
tests, and a header comment that says so in capitals.

### The two-level filter

Filtering on `station.status === 'active'` alone is **not enough**. When Module 2 suspends a
company, its stations keep whatever status they individually had — so a suspended CPO's sites
would carry on advertising themselves to drivers through the one endpoint that does not check
company scope. **That would undo company suspension through a side door, on the single route
where nobody would think to look.**

```
station is active   AND   the company that owns it is active
```

*Verified:* a suspended company's station, still individually `active`, vanishes from driver
discovery and returns when the company is reactivated.

### "Public" means public in **content**, not in access

`/stations/public` still requires a valid token. This app has no logged-out screen that shows
data, the project has **no rate limiting** (a stated gap), and an open endpoint would be new
attack surface with no consumer. Opening it later is a one-line change.

**`requireActiveCompany` is deliberately absent from this route.** That middleware calls
`resolveCompanyScope`, which **throws 403 for any company-scoped account without a company** — so
adding it out of habit would 403 the exact role the endpoint exists for.

### The response type is narrower, not blanked

`PublicMapStation` has no `companyId`, `stationCode`, `createdBy`, `contactPhone` or timestamps
**as fields at all**. A company id cannot reach a driver through this shape, because it would not
compile — a stronger guarantee than remembering to delete it before responding.

> On `contactPhone`: Module 4's model describes it as *"someone a driver can call when a site is
> blocked"*. True — and it still does not belong in a bulk cross-company marker list. It belongs
> on a driver-facing station **detail** view, which does not exist yet. Left out deliberately.

---

## 4. D3 — Availability is a request-time count, not a live feed

```
availableConnectors  = connectors with status 'available',
                       on chargers whose status is 'available'
totalConnectors      = every connector on that station's chargers
```

One aggregation for the whole marker set, starting at `Charger` because `Connector` carries no
`stationId` — the same pipeline shape as Module 13's fleet snapshot.

**Charger `status` is in the gate; `isOnline` is not.** A charger in maintenance genuinely has no
usable plugs. Connectivity flips second to second, and folding it in would make the number
flicker while hiding the more useful fact — so `chargersOnline` is returned separately.

**Honest limit:** a database snapshot, not a reservation. A driver who sees "3 available" may
arrive to find two. Closing that gap is a reservation system, which this project does not have.

### Live markers were attempted and dropped, for a structural reason

`emitConnectorStatus` publishes to **`companyAudience(companyId)`** — the company and platform
rooms. **Drivers are in neither.** Module 12 established that a socket joins `user:{id}` plus the
rooms for *what you can see*, and a driver sees no company room.

So live map markers are **structurally impossible for drivers** without a new room type or
widening Module 8's audience — both of which are *"rebuild the real-time infrastructure"*, which
this module does not do. Deferred, with the blocking reason recorded rather than hand-waved.

---

## 5. D4 — Invalid coordinates: excluded from the map, listed with a badge

- **Map:** no marker. `NaN` or an out-of-range latitude handed to Leaflet **throws**, so one bad
  row would blank the entire map rather than omitting its own marker.
- **List:** still shown, with a **"Location not set — not shown on map"** badge, so an admin can
  click through and fix it. Silently vanishing is worse than visibly broken.

**The honest framing:** `latitude` and `longitude` are `required` with `min`/`max` on the schema,
so **no station created through the API can have invalid coordinates.** This is defence-in-depth
against a row written directly to the database or by a future import path — not routine handling.
The test writes such a row directly, because the API refuses to.

The same rule applies to drivers: an active station with no coordinates is listed for them too,
with the same badge. The rule is applied uniformly rather than hiding a record from drivers
because of a data-quality problem.

---

## 6. Map technology

**Leaflet 1.9.4 + React Leaflet 5.0.0**, both pinned exactly. `@types/leaflet` in
`devDependencies` — the Module 10 lesson about a client library landing in `dependencies`.

Chosen over Google Maps because it needs **no API key, no billing account and no usage quota**,
which is what keeps this project runnable by anyone who clones it.

### Three Next.js / Leaflet specifics

**1. `ssr: false`, and why it is not enough on its own.**
Leaflet reads `window` at **module load**, so the map is loaded via `next/dynamic` with
`ssr: false` from a Client Component.

> **The build caught a real mistake here.** `hasUsableCoordinates` was originally exported from
> `StationMap.tsx`, so the page and the list imported it **statically** — which pulled Leaflet
> into the server bundle and defeated the dynamic boundary completely. `next build` failed with
> `ReferenceError: window is not defined` while prerendering `/map`.
>
> **`ssr: false` only protects a module nobody imports statically.** One ordinary
> `import { helper } from './TheMapComponent'` anywhere undoes it.

Fixed by moving the helper to `components/map/coordinates.ts`, which imports no Leaflet.

**2. Markers are `divIcon`, not the default image icon.** Leaflet's default marker resolves its
own PNG paths at runtime, which every bundler breaks; the usual fix is a webpack shim rewriting
`L.Icon.Default`. A `divIcon` is plain HTML — no asset to resolve, nothing to shim — and it can
be coloured by status for free (green = available, amber = none free, grey = inactive, blue =
selected). Each carries `aria-label` and `data-station-id`, because Leaflet otherwise renders a
marker as an unnamed `div` that a screen reader announces as just "button".

**3. OpenStreetMap tiles, with attribution rendered.** That is a licence condition, not decoration.

---

## 7. API

| Method | Path | Who | Returns |
|---|---|---|---|
| `GET` | `/stations/map` | super_admin, cpo_admin, operator | company-scoped markers, all statuses |
| `GET` | `/stations/public` | **every role** | active stations of active companies |

Neither paginates — you cannot show half a map. Both cap at `MAX_MAP_STATIONS` (500) and return a
**`truncated` flag**, so a clipped view can say so rather than quietly pretend it is complete.

Search reuses Module 4's exact semantics: `search` matches name/code/address, `city` is a separate
**exact** match. The driver variant swaps `stationCode` for `city` in the `$or` — matching on a
code it never returns would let a driver confirm one exists.

### The route-ordering trap

`/map` and `/public` are declared **before** `/:stationId`. Express matches in declaration order,
and `stationIdParamSchema` requires 24 hex characters — so a wrongly-ordered route would return a
baffling **400 "Invalid request parameters"** for a route that plainly exists. Tested explicitly.

---

## 8. Frontend

`/map`, the **only page in the project with no role restriction** — "where can I charge?" is a
question every user of a charging platform has.

**Selection is one piece of state**, owned by the page and read by both panes. The list and the
map do not each keep their own copy.

| | Staff | Driver |
|---|---|---|
| Title | "Station map" | "Find a charging station" |
| Status filter | ✅ | ❌ not rendered |
| Station code | ✅ in popup + detail | ❌ absent from the payload |
| "Open station" link | ✅ | ❌ (no driver station page exists) |

**Responsive:** below `lg` the map sits on top at fixed height with a collapsible list beneath.

---

## 9. Verification

### 72 API checks

- **Driver payload asserted by KEY SET**, not spot-check — so a field added later cannot leak
  silently. `companyId`, `stationCode`, `createdBy`, `contactPhone`, `createdAt`, `updatedAt` all
  confirmed absent, plus "no company name anywhere in the payload".
- **Cross-company proven positively:** a driver sees company A's *and* company B's stations.
- **Two-level suspension filter:** a suspended company's still-`active` station disappears from
  discovery and returns on reactivation.
- **Availability fixture:** 2 chargers, 5 connectors, 2 set to `charging` → exactly **3
  available**; putting one charger in maintenance drops it to **2** while `totalConnectors`
  stays 5.
- A driver gets **403** on `/stations/map`; anonymous gets **401** on both.
- A cpo_admin naming a rival gets **403**, not a silent rescope.
- Route ordering, `.strict()` rejection of `companyId`/`status` from a driver, limit bounds,
  truncation reporting, and a station whose coordinates were removed directly in the database.

### 46 browser checks (Playwright, scratchpad only — not a project dependency)

Everything no API test can see: markers render, popup content, **marker → list** and
**list → marker** selection both directions, search narrowing both panes simultaneously, the
empty-search message, the "location not set" badge, no company name or station code anywhere on
a driver's screen, no status filter for a driver, and a 390 × 844 phone viewport with the map
first, no horizontal scroll and a working collapse toggle.

Screenshots were reviewed, not just asserted on.

### One deliberate contract change to Module 4's suite

Module 4 asserted `/stations/public` **does not exist** (driver → 403). That assertion was
correct when written and Module 14 changes it on purpose, so it was **rewritten rather than
deleted**, with the reason in the test file. The anonymous case is unchanged — which is the part
worth keeping, because it proves "public" describes the content, not the access.

### Regression

All **1149** prior checks green. Backend `tsc`, frontend `tsc`, ESLint and `next build` clean.

---

## 10. Files

**New (backend):** `services/stationMap.service.ts`
**Changed (backend):** `constants/station.ts` (one constant), `validators/station.validator.ts`
(two query schemas), `controllers/station.controller.ts` (two handlers),
`routes/station.routes.ts` (two routes + the Module 4 deferral comment resolved)

**New (frontend):** `components/map/StationMap.tsx`, `components/map/StationList.tsx`,
`components/map/coordinates.ts`, `app/map/page.tsx`
**Changed (frontend):** `types/api.ts`, `services/station.service.ts`, `app/dashboard/page.tsx`
(nav for all four roles), `package.json`

**No model change. No new collection. No `2dsphere` index.**

---

## 11. Known limits — say these before an interviewer finds them

- **No clustering.** At country zoom the Delhi-NCR markers overlap into a blob. Fine for this
  dataset; a real deployment with hundreds of sites needs clustering.
- **No live markers**, for the structural reason in D3 — availability is correct at load and
  then goes stale until reload.
- **No `$near`, no distance sorting, no "nearest station"** — that is the deferred geospatial
  work, and it is the trigger that would finally cash in Module 4's migration.
- **No routing, directions or navigation hand-off.**
- **Availability is a snapshot, not a reservation.**
- **Search is name/address/city only** — no fuzzy matching, no typo tolerance.
- **OpenStreetMap's public tile server** is rate-limited and unsuitable for production traffic; a
  real deployment needs a tile provider or a self-hosted cache.
- **A driver has no station detail page**, so the map is the whole driver-facing station
  experience — which is also why `contactPhone` has nowhere to live yet.

---

## 12. What Module 15 adds

The admin/operations dashboard — which is where Module 13's analytics and this module's fleet
view are likely to meet.
