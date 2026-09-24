# Complaints & Support

> **Revised later (real-world pass):** operator resolution rights (D5), assignment, internal notes and ticket context changed — see `docs/learning/fixes-real-world-pass.md` and `API.md`.

**Status:** Complete · 93 Module 11 checks passing, 963 across Modules 1–11
**Depends on:** Modules 2, 5, 7 and 10 — reads from all of them, writes back to none
**Feeds:** Module 12 (notifications), Module 13 (operational analytics)

---

## 1. Purpose

A place for "the charger stopped and I do not know why" to go, and a record of what was done
about it.

This is the **first module since Module 4 with zero cross-module file touches.** Nothing in
Modules 7, 9 or 10 needed changing to support it — which is a useful signal that the foundations
underneath are now stable enough to build on rather than revise.

---

## 2. D1 — The Module 10 carryover: disputes get a home, not a write-off

After Module 10 I flagged that the settlement sweeper retries unpaid sessions forever with no
dunning or write-off policy, and that a driver disputing a charge is what Module 11 handles.
Resolving that properly, in three parts:

**1. A complaint anchored to a session surfaces that session's LIVE payment state** —
`paymentStatus`, `amountPaise`, `appliedPricePerKwhPaise` — derived at read time, never copied
onto the complaint. Staff see whether the charge is outstanding *now*, not what it was when the
ticket was filed.

**2. Resolution is a manual, auditable note**, attributed and timestamped: *"Charger fault
confirmed from meter logs. Waived pending finance review."*

**3. Resolving a complaint moves no money, and cannot.** There is no write-off mechanism in this
module, deliberately. Module 10 built real discipline around money — atomic debits, transactions,
an append-only ledger, idempotency indexes. A "resolve → forgive the debt" button would be a
financial control with **none** of it: no ledger row, no reconciliation, no idempotency. Bolting
it onto a support workflow would undo the reason Module 10 was careful.

> **Module 11 gives disputes a place to live and be tracked. It does not give staff a way to
> reverse a charge** — that is a future, explicitly-scoped financial capability if it is ever
> needed, and it would belong beside the wallet code with the same discipline, not here.

*Verified:* resolving a dispute on an unpaid session leaves the wallet balance and the session's
`paymentStatus` untouched.

---

## 3. D2 — One anchor, everything else derived

The mismatch attack — a session from Company B submitted with a charger from Company A — is not
*checked for*. It is **unrepresentable**.

A complaint accepts exactly one anchor, and the schema has no field for anything else:

| Anchor | Derived |
|---|---|
| `chargingSessionId` | connectorId, chargerId, stationId, **companyId** |
| `chargerId` | stationId, **companyId** |
| *(none)* | companyId null — platform-level |

The session already carries all four ids denormalised (Module 7's D5), so derivation is a single
fetch. **The anchor is resolved through the caller's own scope**, so a driver referencing another
driver's session gets 404 — not a leak, and not a complaint.

The `chargerId` anchor exists for a real case the session anchor cannot cover: *"I arrived and it
was broken, I never started a charge."*

No `paymentTransactionId`: a session already links to its payment, so a second anchor would be a
second path to the same place. A recharge dispute is an anchorless `payment_issue`.

*Verified:* sending `stationId`, `companyId`, `connectorId`, `userId` or `status` directly is a
**422** each; two anchors together is a 422; another driver's session is a 404 with no complaint
created.

---

## 4. D3 — `companyId` comes from the resource, never the reporter

A driver has `companyId: null`, locked since Module 1 and reinforced by Module 3's D2. So a
complaint's company is derived from its anchor, and an anchorless complaint has **no company**.

That makes it **platform-level: only super_admin sees it.** A CPO has no business reading "I
cannot update my profile" from a driver who has never used their stations. This falls out of
company scoping naturally — `applyCompanyScope` adds `companyId: <theirs>` and a null simply
never matches.

The thing this rules out: nobody should ever "fix" a missing company here by giving drivers one.

---

## 5. D4 — The transition table

```
open ──▶ in_progress ──▶ resolved ──▶ closed
  ▲            │
  └────────────┘        closed is TERMINAL
```

| From | To | Legal? |
|---|---|---|
| `open` | `in_progress` | ✓ |
| `in_progress` | `open` | ✓ — work paused, awaiting the driver or reassignment |
| `in_progress` | `resolved` | ✓ |
| `resolved` | `closed` | ✓ |
| anything else | | **409**, naming the current status |

A table in `constants/complaint.ts`, not prose — the same discipline as Module 9's activation
ordering.

**`closed` is terminal on purpose.** A driver who says "it is still broken" files a *new*
complaint referencing the old one. Mutating a closed ticket back open destroys the record of what
was concluded and when, which is the whole point of keeping one.

**Resolving requires resolution text** — you cannot declare something fixed without saying what
was done. Especially when the ticket is a payment dispute and that note is the only record of the
decision.

*Verified individually:* `open → resolved`, `open → closed`, `in_progress → closed`,
`resolved → in_progress`, `resolved → open`, `closed → open`, `closed → in_progress`,
`closed → resolved` — eight illegal edges, eight 409s.

---

## 6. D5 — Operator scope, stated precisely

| | operator | cpo_admin | super_admin |
|---|---|---|---|
| View company complaints | ✓ | ✓ | ✓ all |
| `open ↔ in_progress` | ✓ | ✓ | ✓ |
| Add / update notes | ✓ | ✓ | ✓ |
| Change priority | ✗ | ✓ | ✓ |
| `→ resolved` | **✗** | ✓ | ✓ |
| `→ closed` | **✗** | ✓ | ✓ |

An operator is field staff: acknowledging and working a ticket is the job, **formally concluding**
a support interaction is an administrative act — especially one that may touch a payment dispute.
This is the operator's second write in the project, after Module 7's force-stop.

**The two gates are independent**, and the test proves it: from `in_progress`, an operator
attempting `→ closed` gets **409** (illegal transition — nobody can do that), and once an admin
has resolved it, the same attempt gets **403** (legal transition, wrong role). Checking them
separately means the error tells the caller which rule they hit.

---

## 7. Entity

Six categories, one per thing a driver can point at: `charger_issue`, `session_issue`,
`payment_issue`, `station_issue`, `account_issue`, `other`. No `connector_issue` — a faulty plug
*is* a charger problem from the driver's side, and the connector id is already derived.

**No `rejected` status** — an invalid complaint closes with a note explaining why. A parallel
terminal state with no distinct behaviour is what `cancelled` would have been in Module 7.
**No `critical` priority** — a fourth tier with no distinct behaviour.

**`subject` and `description` are immutable after creation.** A ticket is an audit record;
letting the reporter rewrite what they reported would destroy the reason to keep it after it
closes. Only `status`, `resolution` and `priority` are mutable, and only by staff.

**The driver sets the initial priority** (default `medium`) and then cannot change it. Safe
because **nothing happens faster** for being called `high` — no SLA, no routing, no escalation —
so there is nothing to win by exaggerating. *Verified both halves:* a driver can set `high` at
creation and gets 403 trying to change it afterwards; a cpo_admin can, an operator cannot.

**Three indexes**, each serving a query that exists:

| Index | Query |
|---|---|
| `{ userId, createdAt: -1 }` | "my complaints" — the driver's only list |
| `{ companyId, status, createdAt: -1 }` | the staff queue, always filtered by status |
| `{ chargingSessionId }` | "is there an open dispute about this session?" |

Category and priority are deliberately not indexed: low-cardinality filters on an already-scoped
result set, where the compound index has done the selective work.

---

## 8. API

| Method | Path | Who |
|---|---|---|
| `POST` | `/complaints` | driver |
| `GET` | `/complaints` | all — scoped by role |
| `GET` | `/complaints/:id` | all — scoped (+ live session context) |
| `PATCH` | `/complaints/:id` | staff — notes, priority |
| `PATCH` | `/complaints/:id/status` | staff — the lifecycle |

**No `/complaints/me`.** `GET /complaints` already returns exactly the driver's own, because the
service picks owner scope for drivers and company scope for staff. A second endpoint would answer
an identical question.

**Staff cannot file complaints.** A ticket carries the `userId` that decides who can read it, so
a staff-created one would belong to the staff member and be invisible to the person with the
problem.

No DELETE. Company-scoped callers get 403 even for ids that do not exist.

---

## 9. Frontend

| Route | Who |
|---|---|
| `/complaints` | all — driver history or staff queue, with filters |
| `/complaints/new` | driver — anchored from `?sessionId=` or `?chargerId=` |
| `/complaints/[id]` | all — detail; staff get the workflow controls |

Plus a **"Something wrong with this charge? Report a problem"** link on a finished session, which
is how a dispute actually starts. The staff controls only offer transitions legal from the current
status *and* permitted for the role — mirroring the two server gates rather than showing buttons
that will be refused.

---

## 10. Verification — 93 checks

Anchor derivation and every injection attempt · the mismatch attack · the charger anchor ·
platform-level visibility · validation · driver ownership · priority immutability ·
subject/description immutability · company isolation · **all eight illegal transitions
individually** · the operator boundary at both gates · payment-dispute surfacing without moving
money.

### End-to-end

```
1. DRIVER files a complaint about the charge they just had
   status                open
   company (DERIVED)     the station owner ✓
   station (DERIVED)     CH-001 site ✓
   charger (DERIVED)     CH-001 ✓
   connector (DERIVED)   plug 1 ✓
   (the driver sent ONE id — a session. Everything else came from the database)

2. OPERATOR picks it up
   status                open -> in_progress
   operator tries to RESOLVE -> HTTP 403

3. ADMIN adds the resolution and resolves it
   status                in_progress -> resolved
   resolution            "Charger connection reset and tested."
   resolvedAt / resolvedBy   recorded ✓

4. ADMIN closes it
   status                resolved -> closed
   trying to reopen      HTTP 409 — closed is terminal

5. THE DRIVER sees the outcome
   Status:      CLOSED
   Resolution:  Charger connection reset and tested.
   The charge:  5 kWh · ₹60.00 · paid
```

### A test-margin fix found along the way

Module 6's heartbeat-timeout check slept 6.5s expecting a charger to be marked offline. With
`OCPP_OFFLINE_AFTER_SECONDS=5` the sweep period is 2.5s, so worst-case detection is **7.5s** — the
assertion had always been marginal and was passing by luck. Raised to 9s and confirmed stable
over repeated runs. Not a regression; a flaky test made honest.

---

## 11. Files

**New (backend):** `constants/complaint.ts`, `models/complaint.model.ts`,
`services/complaint.service.ts`, `validators/complaint.validator.ts`,
`controllers/complaint.controller.ts`, `routes/complaint.routes.ts`
**Changed (backend):** `routes/index.ts` — one line

**New (frontend):** `services/complaint.service.ts`, `components/ComplaintSummary.tsx`,
`app/complaints/*`
**Changed (frontend):** `types/api.ts`, `app/dashboard/page.tsx`, `app/sessions/[sessionId]/page.tsx`

---

## 12. Known limits — say these before an interviewer finds them

- **No assignment.** A complaint belongs to a company, not to a person. No ownership, no queue
  distribution, no "assigned to me".
- **No SLA or ageing.** Nothing measures how long a ticket has been open, and priority drives no
  behaviour.
- **No attachments.** A driver cannot photograph a broken cable.
- **No threaded conversation.** One resolution field, overwritten as staff update it — not a
  back-and-forth with the driver.
- **No notifications.** The driver must come back and look. That is Module 12.
- **No write-off**, by design — see D1.
- **Closed is terminal**, so a recurring problem produces a new ticket rather than a reopened one.
  Deliberate, but it means "how often does this charger break?" needs Module 13 to answer.

---

## 13. What Module 12 adds

Notifications — and this module is the obvious first consumer. A complaint changing status is
exactly the event a driver should be told about without having to check.
