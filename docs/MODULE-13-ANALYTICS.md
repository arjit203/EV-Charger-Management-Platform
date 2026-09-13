# Module 13 — Analytics & Dashboards

**Status:** Complete · 117 Module 13 checks passing, **1149 across Modules 1–13**
**Depends on:** Modules 4, 5, 7, 10 and 11 — it reads what they write, and changes none of them
**Feeds:** Module 15's operations dashboard

---

## 1. Purpose

Sessions, energy, revenue and complaints, aggregated over a date range and scoped to a company.

**This is the first module that only READS.** It owns no collection, defines no state machine,
emits nothing and writes nothing. That inverts the risk of every module before it: nothing here
can corrupt data, and everything here can **misreport** it.

> A wrong number on a dashboard is believed.

So the decisions below are almost entirely about **which source is authoritative** when the same
figure can be computed two ways — because the wrong way is never obviously wrong.

---

## 2. D1 — Revenue is paid **`session_debit`** payments. Not all paid payments.

The brief said revenue should come from `PaymentTransaction` rather than
`ChargingSession.amountPaise`, and that part is right: a session can sit `completed` and `unpaid`
indefinitely — that is the whole point of Module 10's failure path. **Owed is not collected.**

But *"sum every paid `PaymentTransaction`"* is still wrong, and would have shipped a real bug.
Module 10 has two purposes, and only one of them is a sale:

| purpose | What it actually is |
|---|---|
| `wallet_recharge` | a driver **deposits** money. The platform now owes them electricity |
| `session_debit` | a driver **spends** it on electricity. **This is the sale** |

A recharge is a **customer deposit — a liability, not income.** The money was already in the
platform's account; the sale is the moment it converts. Summing both counts every rupee twice.

```js
{ status: 'paid', purpose: 'session_debit' }   // constants/analytics.ts — REVENUE_MATCH
```

**The trap that hides it.** `companyId` is `null` on a recharge, because no company is involved
when a driver tops up. So a cpo_admin's company filter excludes recharges **anyway** — the bug
is invisible in company-scoped testing. It appears only for **super_admin**, who is unscoped.
That one line is the entire difference between a real platform revenue figure and an inflated one.

*Verified on real traffic:* ₹500 deposited, ₹277.20 of electricity sold across three charges.

```
A naive "sum every paid payment" would report   Rs777.20
The dashboard reports                           Rs277.20
```

---

## 3. D2 — Energy is `ChargingSession.energyConsumedWh`. Never a sum of meter readings.

`MeterReading.energyWh` is a **cumulative lifetime counter**, exactly as OCPP reports it. A
session metering `0 → 1666 → 3333 → 5000 Wh` delivered **5 kWh**; adding those readings gives
**9.999 kWh**.

The error is not a fixed factor — **it scales with how chatty the charger is.** A charger
configured to send `MeterValues` twice as often would appear to deliver twice the energy, which
is the kind of bug that survives review because both numbers look plausible.

`ChargingSession.energyConsumedWh` is `endMeter − startMeter`, computed once by Module 7 and
clamped at zero. That is authoritative and it is the only thing summed here.

**`MeterReading` is used for exactly one thing in this project:** the time-series of a *single*
session, which Module 7's `/readings` endpoint already serves. It never appears in a
cross-session aggregation.

Sessions still running are **included** — `energyConsumedWh` holds energy-so-far, and electricity
that has already flowed is delivered whether or not the car has unplugged.

---

## 4. D3 — Live queries. No cache, no rollup, no background job.

Closing the carryover from Module 12 explicitly: **every analytics query runs against the live
collections on every request.**

Same reasoning as every other deferral here (Redis in Modules 6 and 8, GeoJSON in Module 4,
date-ranged tariffs in Module 9): a rollup buys speed this dataset does not need, and pays for it
with **a second source of truth that can silently drift from the first**, plus invalidation logic.

**The trigger for revisiting is a measurement, not a guess:** when an overview query on a
realistic dataset stops returning fast enough to feel instant.

One index was added to Module 10's model to make that deferral honest rather than optimistic:

```js
paymentTransactionSchema.index({ companyId: 1, purpose: 1, status: 1, paidAt: -1 });
```

The existing `{ companyId, createdAt }` cannot serve it, because revenue is anchored on `paidAt`.
Additive and behaviour-neutral — no existing query plan gets worse for it.

---

## 5. D4 — One date rule: UTC, both ends inclusive

```
from  ->  that calendar date at 00:00:00.000 UTC
to    ->  that calendar date at 23:59:59.999 UTC
```

Stated once in `constants/analytics.ts`, implemented once in `utils/dateRange.ts`, used by every
endpoint — because *"does `to` include that day?"* is exactly the question that gets answered
differently in three places and produces three subtly disagreeing charts.

The inclusive end is the part worth being deliberate about: `$lte: new Date('2026-09-07')` means
`00:00:00.000Z`, which **silently drops the whole of the last day the user asked for**.

Dates are `YYYY-MM-DD` only — a full ISO timestamp is rejected. A format that cannot express a
time cannot imply the time is honoured. Default window: **the last 30 days.** Maximum: 366.

---

## 6. D5 — Which timestamp anchors which metric

Not raised in the brief, and it silently corrupts every chart if each endpoint guesses.

| Metric | Anchored on | Why |
|---|---|---|
| Sessions, energy | `startedAt` | when the charge actually happened |
| Revenue | `paidAt` | when the money actually moved |
| Complaints | `createdAt` | when it was reported |

**These genuinely differ, and Module 10 made them differ on purpose.** A driver whose wallet is
short gets their electricity anyway and settles later, so a charge delivered Monday and collected
Wednesday is **Monday's energy and Wednesday's revenue**. Both are correct. Forcing them onto one
timestamp would make one of the two numbers a lie.

Anchoring sessions on `startedAt` does a second job for free: it **excludes sessions that never
started**. An `initiating` session the charger never confirmed has `startedAt: null`, delivered
nothing, and has no business in a count of charges.

*Verified:* a charge started Sep 10 and settled Sep 12 reports as Sep 10 energy with zero revenue,
and Sep 12 revenue with zero energy.

---

## 7. D6 — Status snapshot. Utilization is deliberately not built.

Charger utilization — busy time ÷ total time — **is not built**, and the reason is stated rather
than hidden:

> This project's chargers are simulated and every session is started by hand. Utilization computed
> from sparse, manually-triggered sessions would be **a meaningless number wearing the costume of
> a metric** — and worse, it would look authoritative sitting next to figures that are real.

The distinction that decides it:

**Current status is a fact about this instant. Utilization is a claim about a period.**

Only the first is honestly computable here. So the fleet section reports a live snapshot —
chargers by status, connectors by status, online/offline, sessions charging right now — and the
dashboard labels every one of them "now".

What would change the answer: real chargers running unattended, so that "busy" is measured rather
than staged.

---

## 8. Scoping

`applyCompanyScope` is the **first stage of every pipeline**, unchanged since Module 2:

```js
{ $match: { ...companyFilter, startedAt: { $gte: from, $lte: to } } }
```

`companyId` denormalised onto sessions (Module 7's D5) and payments (Module 10) is what lets a
`$match` do the scoping directly rather than a `$lookup` across three collections. **This is the
module those denormalisations were argued for.**

A company-scoped caller sending `?companyId=` is a **visible 422, not a silent rescope.** Module 9
established the rule — *a dropped field looks like success* — and this is the worst version of it:
for a write, a dropped field still lands the row in the right place; for a **read**, a cpo_admin
who believes they are looking at a rival's revenue is shown their own, with nothing on screen to
say so.

| | super_admin | cpo_admin | operator | driver |
|---|---|---|---|---|
| Sessions, energy, fleet, complaints | ✓ all | ✓ own | ✓ own | **✗ 403** |
| **Revenue** | ✓ | ✓ | **✗ 403** | **✗ 403** |

**The operator is narrower, and not only cosmetically.** The overview **omits** the `revenue` key
and never runs the query; the station leaderboard drops the revenue columns **and re-sorts by
energy** — because sorting by a hidden column leaks the ranking it hides.

`revenue === undefined` means *"you may not see this"*, which is a different statement from
`revenuePaise === 0` (*"nothing was earned"*). The dashboard does not collapse them into one
blank card.

**Drivers are absent entirely.** A driver's analytics is their own charging history, which
`GET /charging/sessions` has returned, owner-scoped, since Module 7.

---

## 9. API

| Method | Path | Returns |
|---|---|---|
| `GET` | `/analytics/overview` | summary cards — windowed totals + fleet snapshot |
| `GET` | `/analytics/sessions` | sessions **and** energy per day |
| `GET` | `/analytics/revenue` | revenue per day (super_admin, cpo_admin only) |
| `GET` | `/analytics/stations` | per-station sessions, energy, revenue |

All take `?from=&to=`; the leaderboard also takes `?limit=`.

Four endpoints, not seven. **Energy rides along with sessions** because they come from one
`$group` over the same documents — splitting them would run an identical pipeline twice to read a
second field.

**No `:id` anywhere, no writes.** There is no 403-vs-404 question because nothing addresses a
single resource.

### Zero state

**`$group` over an empty match returns no documents at all — not a zero.** Every aggregation is
defaulted at the service boundary, so a brand-new company reads `0` everywhere rather than
`undefined`. This is the single most likely way the module breaks on a fresh database, and it is
tested against a genuinely empty company, not a small one.

---

## 10. Frontend

`/analytics`, for the three staff roles. Six cards, four charts, a date-range picker with
Today / 7d / 30d / 90d presets, and a company selector **rendered only for super_admin**.

**Windowed and snapshot numbers are labelled differently on purpose** — "in the last 30 days"
versus "now". Mixing them silently is how a dashboard lies.

### No charting library

Verified before deciding: the frontend's entire dependency list is `next`, `react`, `react-dom`
and `socket.io-client`. **A charting library would be the largest thing in it**, added to draw
four charts whose hardest requirement is "a rectangle proportional to a number". Module 8 already
set the precedent with the inline SVG energy curve on the session page.

`BarChart`, `HorizontalBarChart` and `LineChart` are about forty lines of SVG each.

*What would change the answer:* axes that pan and zoom, cursor-tracking tooltips, or
stacked/overlaid series. At that point a library is doing real work.

The presets compute their dates **in UTC**, because the server's window is UTC — using the
browser's local date would put a user in IST past 05:30 on a different "today" from the one the
API resolves.

---

## 11. Verification — 117 checks, and three real bugs

### The numbers that matter

**Revenue excludes recharges (D1):**
```
Rs500 recharge         -> PLATFORM revenue delta = 0 paise         PASS
Rs60 charge settled    -> PLATFORM revenue delta = 6000 paise      PASS
two Rs500 top-ups + two Rs60 charges -> delta 12000, not 112000    PASS
```

**Energy is not double-counted (D2):**
```
meter 0 -> 1666 -> 3333 -> 5000 Wh
analytics reports                        5000 Wh / 5.000 kWh       PASS
sum of stored readings would be higher                             PASS
analytics does NOT report that sum                                 PASS
```

**Date anchoring (D5):**
```
Sep 10 charge, settled Sep 12
  Sep 10: 1 session, 1000 Wh, Rs0.00 revenue                       PASS
  Sep 12: 0 sessions,    0 Wh, Rs12.00 revenue                     PASS
```

**Boundaries (D4):** sessions at `00:00:00.000` and `23:59:59.999` both land inside a one-day
range, and neither leaks into the previous day.

Plus: delivered-but-uncollected counts as energy and **not** revenue; the money appears when the
sweeper actually collects it; cross-company isolation; operator 403 and key-absence; every
illegal window shape; and self-consistency — overview totals equal the sum of each daily series
and of the per-station breakdown.

### Three bugs the suite caught

1. **`2026-02-31` was silently accepted.** V8 does not reject it — it **rolls it over** to
   `2026-03-03`. An `Invalid Date` check passes, and the caller is shown three days in March
   while their screen says February. Fixed with a **round trip**: parse it, format it back, and
   insist the server got out what the caller put in.
2. **A three-day span reported as four days.** `daysInRange` already returns the *inclusive*
   count; the `+ 1` was double-counting.
3. **A 500 where a 400 belonged** — introduced by fix 1 and caught immediately. Zod runs every
   refinement even after the regex fails, so the round-trip check received raw input like
   `yesterday`, and `Invalid Date.toISOString()` **throws** rather than returning something falsy.

### Hand reconciliation

Real simulator traffic across two stations, reconciled against raw database rows by arithmetic
rather than by an assertion I also wrote:

```
  station  status     energyWh   amount     payment
  North    completed      7500     Rs90.00  paid
  North    completed      3200     Rs38.40  paid
  South    completed     12400    Rs148.80  paid
  North    completed      5000     Rs60.00  unpaid

  hand total energy   28100 Wh = 28.100 kWh    dashboard  28100 Wh / 28.1 kWh   MATCH
  hand total revenue  Rs277.20                 dashboard  Rs277.20              MATCH
  hand outstanding    Rs60.00                  dashboard  Rs60.00               MATCH
  per-station         North 15700 Wh / Rs128.40, South 12400 Wh / Rs148.80      MATCH
```

Note the leaderboard ranks **South above North** despite North having three times the sessions and
more energy — because it is ranked by revenue, and North's extra charge was never collected.

### Regression

All **1032** prior checks green, unchanged. Backend `tsc`, frontend `tsc`, ESLint and
`next build` all clean.

---

## 12. Files

**New (backend):** `constants/analytics.ts`, `utils/dateRange.ts`,
`services/analytics.service.ts`, `validators/analytics.validator.ts`,
`controllers/analytics.controller.ts`, `routes/analytics.routes.ts`

**Changed (backend):** `routes/index.ts` (one mount), `models/paymentTransaction.model.ts`
(one flagged index)

**New (frontend):** `services/analytics.service.ts`, `components/charts/BarChart.tsx`,
`components/charts/LineChart.tsx`, `app/analytics/page.tsx`
**Changed (frontend):** `types/api.ts`, `app/dashboard/page.tsx` (nav link for three roles)

**No new model, no new collection, no new dependency.**

---

## 13. Known limits — say these before an interviewer finds them

- **No caching or rollups.** Deliberate (D3), with a stated revisit trigger — but every request
  aggregates from scratch.
- **No charger utilization** (D6), and no peak-hour or time-of-day breakdown for the same reason.
- **No driver-facing analytics.** `/charging/sessions` already answers it.
- **Complaint analytics is counts by status only** — no category or resolution-time breakdown.
- **No CSV or PDF export.** Nothing consumes one yet.
- **No comparison to a previous period** ("+12% vs last month"), which is the first thing a real
  CPO would ask for.
- **Revenue is collections, not accruals.** A finance team would want both, and would want
  refunds separated out rather than simply absent from `REVENUE_MATCH`.
- **366-day maximum window**, and the charts label only the first and last day on the axis.

---

## 14. What Module 14 adds

The charging-station map. Module 4 stored `latitude` and `longitude` from the beginning and
deferred GeoJSON; that is the deferral Module 14 either cashes in or keeps.
