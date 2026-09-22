# Tariffs & Pricing

**Status:** Complete · 98 Module 9 checks passing (25 money + 73 tariff), 767 across Modules 1–9
**Depends on:** Module 2 (company scoping) and Module 7 (sessions, energy)
**Feeds:** Module 10 (wallet/payments), Module 13 (revenue analytics)

---

## 1. Purpose

Module 7 measured energy. Module 9 turns it into a number of rupees.

It stops there deliberately: **nothing here moves money.** No wallet, no Razorpay, no receipt.
This module answers "what does this charge cost?" and Module 10 answers "who pays, and how?"

---

## 2. D1 — Money is integer paise, everywhere

```
₹12.00/kWh  ->  1200 paise
2.5 kWh     ->  2500 Wh
amount       =  round(2500 × 1200 / 1000)  =  3000 paise  =  ₹30.00
```

The problem this closes is not hypothetical: `0.1 + 0.2 === 0.30000000000000004` is how IEEE-754
represents decimal fractions, in every language. A total built from repeated float arithmetic
drifts, and the drift is invisible until a customer disputes a bill. **With integers, `1049.9999`
paise has no bit pattern** — the wrong value is unrepresentable rather than merely unlikely.

Three supporting rules, all enforced in code:

- **The unit is in the field name.** `amountPaise`, `pricePerKwhPaise`, `appliedPricePerKwhPaise`.
  A bare `amount` can be misread; these cannot.
- **Rupees exist only at the edges** — one `formatPaise()` in the frontend for display, and one
  `rupeesToPaise()` in the validator for form input. Nothing else divides or multiplies by 100.
- **Rounded exactly once**, at the end, half-up. Rounding intermediate values is how a
  calculation that looks right accumulates error.

**No `currency` field.** One legal value is not a field — the same call as Module 4's deferred
GeoJSON. Module 10 needs the string `'INR'` for Razorpay and gets it from a constant. If the
platform ever goes multi-currency, adding the column is additive and every existing row is
already correct.

It is also, not incidentally, the representation Razorpay's API expects, so Module 10 passes
`amountPaise` through with no conversion layer.

---

## 3. D2 — Tariffs are company-level

```
Company ──▶ Tariff ──▶ applies to every Station the company owns
```

A CPO with forty stations wants one pricing sheet. Per-station overrides bring a fallback rule
with them — *which wins? what if the station has none?* — and that complexity has no demonstrated
consumer. Adding an optional `stationId` later is **purely additive**: null means "the company
default", and every row written today already satisfies it.

**Six fields**, and the absences are as deliberate as the presences:

| Field | Why |
| ----- | --- |
| `companyId` | the owner, and the scoping key |
| `name` | for humans — "Standard DC" |
| `pricePerKwhPaise` | integer paise; a `validate` on the schema rejects fractional paise |
| `status` | `active` / `inactive` |
| `createdBy` | audit |
| timestamps | |

Absent on purpose: `currency`, `pricingType`, `effectiveFrom`/`effectiveTo`. Each would be a
field with one legal value or no consumer.

---

## 4. D3 — "One active tariff" is a database invariant

```js
tariffSchema.index(
  { companyId: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);
```

The race: two admins activate different tariffs at the same moment, both pass an application
check, and the company now has two rates with no deterministic answer to "what does a charge
cost?" The second write fails with E11000, which the error middleware already maps to 409.

Same mechanism and same reasoning as Module 7's one-open-session-per-connector.

**Activation is a swap, and the order matters.** The incumbent is deactivated *first*, then the
new one activated — the reverse order would momentarily hold two active rows, which the index
refuses. Both writes run in one transaction, so a company can never be left with zero tariffs
because the second write failed.

*Verified:* two simultaneous activations leave exactly one active tariff.

---

## 5. D4 — The rate is snapshotted onto the session at start

`ChargingSession.appliedPricePerKwhPaise`, written when the session row is created.

A `tariffId` reference alone would be wrong, and subtly so: an admin editing the rate while a car
is charging would **retroactively reprice a session already in progress**. Two drivers who
plugged in at the same moment could be billed differently depending on when the edit landed.

Copying the *value* locks the price the instant charging is requested. Whatever happens to the
Tariff document afterwards — edited, deactivated, superseded — cannot move it.

This is Module 5's denormalisation reasoning (*denormalise when the source cannot be trusted to
stay stable*) applied to a field that is explicitly **expected** to change.

`appliedTariffId` is stored beside it as **provenance**, not pricing. The snapshot says *what* was
charged; the id says *which price sheet said so*, which is what a Module 11 billing dispute
actually needs. Neither replaces the other, and the code comments say so to stop a later
"simplification" dropping the id.

*Verified end to end:* a session started at ₹12/kWh, the tariff was raised to ₹25/kWh and then
deactivated mid-charge, and the session still priced at ₹12.

---

## 6. D5 — No published price, no charging

A flagged addition to Module 7's `startSession`: resolve the station's company tariff, **409** if
there is none.

With D3 in force this is the *only* place "no tariff" can surface. At most one active tariff can
exist per company, so there is no ambiguity at completion — only this precondition at the start.
Letting a session run and produce an undefined price would hand Module 10 a record it can neither
settle nor explain.

The driver-facing consequence is visible before they commit: `GET /charging/connectors/:id`
returns `canStart: false` with *"This operator has not published a price yet."*

**Consequence handled:** the demo seed now publishes a tariff for each demo company, or Livanto
Green and Sharma Energy would have become unusable the moment this shipped. Flagged touch to
`seedDemoCompanies.ts`.

---

## 7. D6 — Pricing lives in a `pre('save')` hook

A session reaches a terminal state in **five** places across two files:

```
sessionEvents.onStopTransaction              the normal end
sessionEvents.failOpenSessionsForCharger     charger vanished mid-charge
sessionEvents.sweepUnconfirmedSessions       start never confirmed
chargingSession.markFailed                   charger rejected or timed out
chargingSession.stopSession                  stop requested while charger offline
```

Pricing at each is five chances to forget, and a sixth call site added in a later module would
silently produce an unpriced session. The hook makes it **structurally impossible to skip** —
the same instinct as the partial unique indexes, applied to a different kind of correctness
problem.

```
if status is terminal AND amountPaise is null AND a rate was snapshotted:
    amountPaise = round(energyConsumedWh × appliedPricePerKwhPaise / 1000)
```

Pure arithmetic on fields already present: no I/O, no await, no ordering hazard.

**Guarded on `amountPaise === null`**, so a later save touching an unrelated field cannot
recompute and overwrite a settled amount. Once priced, the number is final — verified by forcing
a second save on a completed session and asserting the amount does not move.

---

## 8. D7 — Failed sessions are priced too

A session that died with `ChargerDisconnected` after delivering 0.4 kWh delivered real
electricity. Billing zero would mean giving energy away on every network blip; refusing to price
it would leave Module 10 with an unsettleable record.

So the hook fires on `completed` **and** `failed`. A failure with no energy prices at zero on its
own — no special case, which is why the condition is about the *status*, not about how the
session ended.

*Verified:* a charger killed mid-charge after 0.4 kWh at ₹12/kWh produced exactly 480 paise.

---

## 9. Permissions

| Action | super_admin | cpo_admin | operator | driver |
| ------ | ----------- | --------- | -------- | ------ |
| Create / edit / activate | ✓ any company | ✓ own company | ✗ | ✗ |
| View tariffs | ✓ all | ✓ own company | ✓ read-only | ✗ |
| See the rate before charging | — | — | — | ✓ at the connector |

**Operator is read-only, full stop** — same position as Modules 3 and 5. They run the hardware;
they do not set prices. Their one write in this project remains the Module 7 force-stop.

**A `companyId` from a company-scoped caller is a visible 422, not a silent strip.** The value was
never trusted either way — their company comes from the verified account — but ignoring it would
hide an escalation attempt that should appear in the logs. Zod cannot enforce this alone, because
the field's legality depends on the caller's role, which the schema cannot see. *(This was caught
by the test suite as a genuine gap on the first run.)*

---

## 10. API

| Method | Path | Who |
| ------ | ---- | --- |
| `POST` | `/tariffs` | super_admin, cpo_admin |
| `GET` | `/tariffs` | + operator |
| `GET` | `/tariffs/:tariffId` | + operator |
| `PATCH` | `/tariffs/:tariffId` | super_admin, cpo_admin |
| `PATCH` | `/tariffs/:tariffId/status` | super_admin, cpo_admin |

**No driver-facing tariff endpoint.** The rate a driver needs is the one at the plug in front of
them, and `GET /charging/connectors/:connectorId` already answers that — it gained
`pricePerKwhPaise`. A second endpoint returning the same number would be duplicate surface.

The request accepts `pricePerKwh` in **rupees**; everything returned is paise (plus a
`pricePerKwhRupees` convenience for display). No DELETE — a tariff is quoted by every session
priced under it.

---

## 11. Frontend

| Route | Who | What |
| ----- | --- | ---- |
| `/tariffs` | staff | List, with the active rate called out at the top |
| `/tariffs/new` | admin | Create (starts inactive) |
| `/tariffs/[id]` | staff | Detail, edit, activate/deactivate |
| `/charge` | driver | The price, shown **before** committing to start |
| `/sessions/[id]` | all | Live cost estimate, then the final amount |

**The live estimate costs nothing extra.** Module 8 already streams `energyConsumedKwh` on every
meter update, and the rate was snapshotted onto the session at start — so the estimate is those
two numbers multiplied, client-side. No new endpoint, no new Socket.IO event, no new backend
work. It is explicitly an estimate; the authoritative figure is what the server computes from the
final meter reading.

---

## 12. Verification — 98 checks

**Money (25), run against the compiled module with no server**, because the arithmetic had to be
proven before anything depended on it: the worked examples, a demonstration that float addition
really does drift while integer paise do not, `₹12.34 → 1234` (truncation would give ₹12.33),
rounding, and defensive cases where a charge can never go negative.

**Tariff (73):** CRUD and roles, company isolation, validation, the activation swap and its race,
the no-price precondition, pricing arithmetic end to end, determinism under a mid-charge tariff
change, the re-save guard, failed-session pricing, and client-supplied-amount rejection.

### End-to-end with the real simulator

```
1. CPO publishes "Standard DC" at ₹12.00/kWh  (stored as 1200 paise), status inactive
   starting a charge before activation      -> HTTP 409 (no published price)
   tariff activated
2. charger online; driver sees ₹12.00/kWh, canStart=true
3. meterStart = 10000 Wh
   meter 10833 Wh -> 0.833 kWh · live estimate ~₹10.00
   meter 11666 Wh -> 1.666 kWh · live estimate ~₹19.99
   meter 12500 Wh -> 2.500 kWh · live estimate ~₹30.00
4. CPO raises the price to ₹25.00/kWh WHILE THE CAR IS PLUGGED IN
5. StopTransaction at 12500 Wh

   energy consumed    2.5 kWh
   rate applied       1200 paise/kWh (₹12.00)
   amount             3000 paise  =  ₹30.00
   status             completed

   the tariff now reads ₹25.00/kWh — the session was NOT repriced
```

**2.50 kWh × ₹12.00/kWh = ₹30.00 exactly.**

---

## 13. Files

**New (backend):** `constants/tariff.ts`, `models/tariff.model.ts`, `services/tariff.service.ts`,
`validators/tariff.validator.ts`, `controllers/tariff.controller.ts`, `routes/tariff.routes.ts`,
`utils/money.ts`

**Changed (backend):** `models/chargingSession.model.ts` (3 fields + the hook),
`services/chargingSession.service.ts` *(flagged Module 7 touch: precondition + snapshot + rate on
the connector lookup)*, `routes/index.ts`, `scripts/seedDemoCompanies.ts` *(flagged)*

**New (frontend):** `lib/money.ts`, `services/tariff.service.ts`, `components/TariffForm.tsx`,
`app/tariffs/*`
**Changed (frontend):** `types/api.ts`, `components/SessionSummary.tsx`, `app/charge/page.tsx`,
`app/sessions/[sessionId]/page.tsx`, `app/dashboard/page.tsx`

---

## 14. Known limits — say these before an interviewer finds them

- **One rate, per kWh, per company.** No time-of-day pricing, no per-station overrides, no idle
  fees. All additive later.
- **No tax handling.** GST would be a separate field and a separate conversation.
- **Editing an active tariff is allowed** and affects only future sessions. That is correct, but
  it means there is no approval workflow around a price change.
- **A deactivated tariff stops all charging at that company** until another is activated. That is
  intentional — it is the "no price, no sale" rule — but it is a sharp edge for an admin who
  deactivates without activating a replacement. The UI warns; nothing prevents it.
- **`Math.round` is half-up.** Banker's rounding would be defensible for large volumes; half-up
  is what a customer expects on a single bill.

---

## 15. What Module 10 adds

The wallet and Razorpay. `amountPaise` is already in the unit Razorpay's API takes, so Module 10
debits the figure this module computed rather than recalculating it — and the snapshot means a
price quoted at the start of a charge is the price settled at the end.
