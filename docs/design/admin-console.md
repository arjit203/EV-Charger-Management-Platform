# Admin & Operations Console

**Status:** Complete · 24 Module 15 API checks + 58 browser checks, **1245 across Modules 1–15**
**Depends on:** every module before it — this is the one that treats them as a system
**Adds to the backend:** nothing

---

## 1. Purpose

One screen answering *"what is happening across my charging network right now?"*, plus a
navigation model that makes the previous fourteen modules feel like one product.

**No new backend.** No endpoint, no model, no collection, no socket event. Everything here is
integration.

---

## 2. What was actually there first

The design was written only after reading the code, and what it found changed the plan:

| Check | Reality |
|---|---|
| `DashboardLayout` / `Sidebar` / `Topbar` | **None existed.** Zero layout components in the project |
| `app/dashboard/page.tsx` | **221 lines**, `max-w-2xl`, still Module 1's placeholder |
| Its capability list | **Future tense about features that already shipped** — "Find available charging stations (Module 14)" |
| Its identity card | Raw `companyId` ObjectId and a note about `GET /auth/me` — developer debug output |
| Who used it | **Staff and drivers shared the same file** |

So this module is not "build a dashboard". It is **replacing fourteen modules of appended nav
links and a stale placeholder** — on a file that also serves drivers.

---

## 3. D1 — The shell mounts once, in `app/layout.tsx`

Two obvious placements both fail:

| Approach | Why not |
|---|---|
| Shell only on `/dashboard` | A sidebar that vanishes when you click "Stations" is a link page, not a console |
| Convert all ~20 staff pages | Touches **every prior module's frontend at once** for a layout change — the "rewrite previous modules unnecessarily" the brief forbids, and fourteen modules of working UI put at regression risk |

`AppShell` mounts at the root and decides for itself whether to draw chrome:

```
staff, on an app route      →  sidebar + topbar + content slot
/ , /login, /register       →  children, untouched
driver                      →  children, untouched
still resolving the session →  children, untouched
```

**One file changed, every staff page inherits the console, no page file moves.**

The content slot is a `<div>`, not a `<main>` — every existing page already provides its own,
and nesting `<main>` is invalid HTML. The pages were written first, so the shell adapts.

---

## 4. D2 — The driver's experience is not restructured

Drivers shared `/dashboard`. Turning it into a staff console would have silently redesigned the
driver experience under cover of "polish the admin dashboard".

So the old rendering was **extracted verbatim** into `components/dashboard/DriverHome.tsx`, and
`/dashboard` branches on role. `AppShell` independently renders no chrome for drivers. A driver's
page today is byte-for-byte what it was before this module — verified in the browser.

The only change inside it: the `ROLE_LINKS` / `ROLE_CAPABILITIES` records were narrowed to their
driver entries, because the staff branches became unreachable once the component was driver-only.
What a driver *sees* is unchanged.

> **Known carryover, recorded rather than silently fixed:** the driver's capability list is still
> future-tense about features that now exist. Correcting that copy means deciding what a driver's
> home page should say, which belongs to a driver-facing pass, not to this one.

---

## 5. D3 — Recent activity is derived, not stored

Nothing in Modules 0–14 built an event log, and this module does not build one either.

```
GET /charging/sessions?limit=8   +   GET /complaints?limit=5   +   GET /payments?limit=5
                     ↓  merge-sorted in the browser by timestamp, capped at 15
                              an activity feed
```

**No model, no collection, no persisted log, no `/activity` endpoint.** If a row cannot be read
from an endpoint that already exists, it does not appear.

### It is not Module 12's notifications

| | Notifications (Module 12) | Activity feed (Module 15) |
|---|---|---|
| Scope | one **person's** record | an **operational** view for staff |
| Storage | persisted, deduped | assembled fresh per load |
| State | read / unread, badge count | none |
| Delivery | pushed to `user:{id}` | fetched with the page |

Each row is already company-scoped, because every endpoint it reads from is.

---

## 6. D4 — Which sections are live, and which deliberately are not

| Section | Events | Source |
|---|---|---|
| Fleet status | `connector:statusChanged`, `charger:connectivityChanged` | Module 8 |
| Active sessions | `session:statusChanged`, `session:meterUpdate` | Modules 7/8 |
| Notification bell | `notification:new` | Module 12 |

**REST-only, refetched on navigation:** revenue, complaint counts, station summary, analytics
preview.

Those are **aggregates over a window**, and a revenue total twitching on every payment is noise
rather than information — Module 8's own D7 (*"connectivity emits on transition only; heartbeat-rate
emits are noise"*) applied to a card instead of a socket.

Every listener goes through `useSocketEvent`. **No new events, no new rooms, no publisher changes.**

### The honest bit about the fleet counts

A `connector:statusChanged` event carries the connector's **new** status but not its old one, so
the per-status counts cannot be adjusted without guessing which bucket to decrement. Rather than
invent a wrong number, the tile shows what just happened and says *"counts refresh on reload"*.

**Being honestly out of date beats being confidently wrong.**

Charger connectivity *is* a clean ±1, so that one is adjusted directly.

---

## 7. D5 — The operator exclusion needed zero new logic

Module 13 already made `/analytics/overview` **omit** the `revenue` key for operators — not zero
it, omit it — and never run the query.

```tsx
{revenue && <StatCard label="Revenue today" … />}
```

That is the entire mechanism. **The shape is the permission**, decided three modules ago and
already tested there. The sidebar's Billing group is filtered by the same boundary, and
`/analytics/revenue` is simply never called for an operator.

*Verified:* an operator's overview has **no `revenue` key at all**, and a test asserts that
specifically — if it ever became `revenue: {…zeros}` the card would silently reappear.

---

## 8. D6 — The map is a navigation card, not an embedded Leaflet instance

Module 14 had to isolate Leaflet behind `next/dynamic` + `ssr: false`, and its build caught a real
bug when a static import defeated that boundary. **Reproducing that hazard for a thumbnail is not
a trade worth making.** The card shows station and charger counts and links to `/map`.

---

## 9. Data fetching

**Eight parallel calls, all to endpoints that already existed.** No new endpoint, no "everything"
aggregate invented for the dashboard's convenience.

| Section | Endpoint | Module |
|---|---|---|
| Stations, chargers, connectors, charging-now | `/analytics/overview` → `fleet` | 13 |
| Sessions + energy over the window | `/analytics/overview` → `sessions` | 13 |
| Revenue + outstanding | `/analytics/overview` → `revenue` | 13 |
| Complaints | `/analytics/overview` → `complaints` | 13 |
| Today's sessions/energy, and the bar chart | `/analytics/sessions` | 13 |
| Today's revenue | `/analytics/revenue` | 13 |
| Busiest stations | `/analytics/stations?limit=5` | 13 |
| Active sessions table | `/charging/sessions?active=true` | 7 |
| Activity feed | `/charging/sessions`, `/complaints`, `/payments` | 7/11/10 |

`Promise.all`, not a waterfall — none depends on another, so sequencing would make the page as
slow as their sum rather than as slow as the slowest.

**"Today" is the last point of Module 13's daily series**, which zero-fills every day — so today
is always present, no second windowed request is needed, and the number cannot disagree with the
chart drawn from the same array.

**Not one number is computed on this page.** No revenue arithmetic, no energy summing, no company
filtering. The only derived value anywhere is the live *cost estimate* in the sessions table,
which reuses Module 10's existing helper and is labelled an estimate on screen.

---

## 10. The page that turned out to be missing

The browser walkthrough caught **`/payments` returning 404** — the sidebar's Billing entry and the
revenue card both pointed at a page that had never been built.

Module 10 built `GET /payments` (all four roles, scoped per role) and then only ever built the
**driver-facing** `/wallet` screen on top of it. The endpoint had been tested and unused by any
page ever since.

So `app/payments/page.tsx` was added: a read-only staff ledger over that existing endpoint. It
labels the two purposes explicitly — **"Wallet top-up (deposit)"** vs **"Charging session (sale)"** —
so nobody eyeballing the page adds them together, which is the exact mistake Module 13's D1 exists
to prevent.

Restricted in the UI to the two admin roles, matching the Billing group. That is a UX decision;
the API remains the boundary.

---

## 11. Navigation

```
Dashboard
Operations   Live operations · Charging sessions · Stations · Chargers · Station map
Management   Companies | My company · Users · Tariffs · Support
Billing      Payments
Insights     Analytics · Notifications
```

| | super_admin | cpo_admin | operator |
|---|---|---|---|
| Operations | ✅ | ✅ | ✅ |
| Companies / My company | all | own | own |
| Users | ✅ | ✅ | ❌ |
| Tariffs, Support | ✅ | ✅ | ✅ |
| **Billing** | ✅ | ✅ | **❌** |
| Analytics | ✅ | ✅ | ✅ (no revenue) |

The rail says so itself, at the bottom:

> *"Menu reflects your role. Access is enforced by the API, not by this menu."*

---

## 12. Verification

### 24 API checks — the dashboard's data contract

Every call the page makes is enumerated in one array, so a future fetch has to be accounted for.
Asserted: all six core calls return 200 for all three staff roles; the operator is refused
`/analytics/revenue` and their overview has **no `revenue` key**; a driver is refused all three
analytics calls while keeping their own owner-scoped sessions and complaints; company B sees zero
of company A's stations, sessions, revenue and complaints; naming another company is a visible
**422**; and every call is 401 without a token.

### 58 browser checks — real Chromium

**Numbers checked against independently computed values**, not hardcoded: each card is compared
with the figure the same API reports in the same run, including a sanity assertion that revenue
is genuinely non-zero rather than a zero dressed up as data.

**The live test drives a real OCPP session** against the open page:
```
active sessions table populated with NO reload                        PASS
the connector status change was announced live                        PASS
the meter update reached the open table, still with no reload         PASS
a COMPLETED session left the active table, still without reload       PASS
```

Plus: every sidebar link resolving, the shell persisting across six navigations, the operator
seeing no revenue card and no Billing group, the driver landing on their own page with no
sidebar, and a 390 × 844 phone with a working drawer that closes itself on navigation.

Screenshots were reviewed, not merely asserted on.

### Bugs the browser caught

1. **`/payments` 404** — a sidebar link and a card both pointing at a page that did not exist.
   Fixed by building the missing page (§10).
2. **Horizontal scroll on a phone.** A grid item defaults to `min-width: auto` and refuses to
   shrink below its content, so the 34rem sessions table widened the whole column and pushed the
   page sideways instead of scrolling inside its own container. Fixed with `min-w-0` on `Panel`.
3. Three **`set-state-in-effect`** errors from the React Compiler, fixed with React's documented
   alternatives rather than suppression — the drawer now derives "open" from *which path it was
   opened on*, so navigating closes it with no effect at all.

### Regression

All **1221** prior checks green. Backend `tsc`, frontend `tsc`, ESLint and `next build` clean.

---

## 13. Files

**New (frontend):** `components/layout/{AppShell,Sidebar,Topbar,navigation}.tsx|ts`,
`components/dashboard/{primitives,FleetStatus,ActiveSessions,RecentActivity,DriverHome}.tsx`,
`app/payments/page.tsx`

**Changed (frontend):** `app/layout.tsx` (one shell), `app/dashboard/page.tsx` (**rewritten**)

**Backend: nothing.**

---

## 14. Known limits

- **The fleet connector counts go stale between reloads** (§6) — deliberately, and it says so on
  screen.
- **No cross-page live updates.** Only the dashboard consumes the socket; `/stations` and
  `/chargers` still need a refresh.
- **Activity is capped at the last few rows of three endpoints** — it is not a complete audit
  trail, and cannot answer "what happened last Tuesday".
- **No date-range control on the dashboard.** It shows the last 30 days; `/analytics` is where
  ranges live.
- **No customisation** — no reordering, hiding or pinning of cards.
- **The driver home is untouched**, including its stale copy (§4).
- **Eight parallel requests on load.** Fine at this scale; a busier deployment would want a
  combined endpoint, which was deliberately not invented here.

---

## 15. What Module 16 adds

Testing and QA — which is where the honest gap this project has carried since Module 1 (executable
check scripts rather than a test framework) finally gets addressed.
