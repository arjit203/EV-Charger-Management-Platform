# Companies & Multi-Tenancy (MVP scope)

**Status:** ✅ Complete
**Depends on:** Module 1 (auth, RBAC, `User.companyId`)

---

## 1. Purpose (from zero)

**CPO = Charge Point Operator** — the company that owns and runs physical chargers, keeps
them working, sets prices and collects revenue. (An **eMSP** gives drivers an app to charge
on networks it doesn't own; a **Platform** sells the CPMS software itself. Only `type`
records the difference — nothing branches on it.)

With one operator and one admin you don't need a Company table. With two operators sharing
one platform, every question suddenly needs an owner: whose revenue is this? who may suspend
charger `DEL-014`? why can Sharma's operator see Livanto's stations?

`Company` is the answer to **"whose is this?"**, and `companyId` is the thread tying the
object graph to an owner:

```
Company (Livanto Green)
  └── Station (Connaught Place)
        └── Charger (DEL-014)
              └── ChargingSession (₹340, 12 kWh)
```

## 2. Where it fits in the CPMS

Module 2 introduces the first **real multi-company data isolation**. Two companies' data
lives in the same database and the same collections, separated by a field rather than by a
server — and both companies hit the identical URL. There is no network boundary doing the
work. The code is the boundary.

Everything from Module 4 onward inherits the pattern established here.

## 3. Role-based vs company-based access

The distinction that makes this module worth the effort:

| | Role-based (RBAC) | Company-based (scoping) |
| --- | --- | --- |
| Question | "May this **kind** of user do this?" | "Does this user own **this record**?" |
| Where | Middleware, before the handler | Inside the query, in the service |
| Answer | Yes/no per endpoint | A filter per request |

`cpo_admin_A` and `cpo_admin_B` have **identical roles** and must see **completely
different data**. Roles alone can never express that.

## 4. Permissions

| Action | super_admin | cpo_admin | operator | driver |
| --- | :-: | :-: | :-: | :-: |
| Create company | ✅ | ❌ | ❌ | ❌ |
| List all companies | ✅ | ❌ | ❌ | ❌ |
| View own company | — (has none) | ✅ | ✅ | ❌ |
| View another company | ✅ | ❌ 403 | ❌ 403 | ❌ 403 |
| Update company | ✅ | ❌ | ❌ | ❌ |
| Activate / suspend | ✅ | ❌ | ❌ | ❌ |
| ~~Create company staff~~ | — | — | — | — | *(moved to Module 3's `POST /users`; a cpo_admin may now create operators in their own company)* |

## 5. Entity — `Company`

| Field | Notes |
| --- | --- |
| `name` | required, **unique**, 2–120 |
| `legalName` | optional registered name |
| `type` | `CPO` \| `eMSP` \| `PLATFORM`, default `CPO` — descriptive only |
| `contactEmail` / `contactPhone` | optional |
| `address` | `{ line1, city, state, country, postalCode }`, all optional |
| `status` | `active` \| `suspended`, indexed |
| `createdBy` | → User, audit trail |
| timestamps | |

Indexes: unique `name`, `status`, `{ type, status }`.

**Deliberately absent** (locked out of scope): SaaS licensing, deal management, subscription
billing, per-charger license cost, SaaS fee %, payout configuration. Those belong to a
software vendor selling to CPOs, not to a CPO running its own network.

## 6. User ↔ Company

```
Company 1 ──── N User   (cpo_admin, operator)
```

| Role | `companyId` |
| --- | --- |
| `super_admin` | `null` — platform-wide |
| `cpo_admin` | **required** |
| `operator` | **required** |
| `driver` | `null` |

Enforced by a `pre('validate')` hook on the User schema, so a company-scoped user without a
company is **impossible to save through any code path** — including future modules, scripts
and seeders. `resolveCompanyScope` fails closed on such a record, so making it unsavable
removes the failure mode rather than handling it.

## 7. API

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| `POST` | `/companies` | super_admin | 201 |
| `GET` | `/companies` | **super_admin only** | paginated; `?page=&limit=&status=&type=&search=` |
| `GET` | `/companies/me` | cpo_admin, operator | own company — **no id in the URL** |
| `GET` | `/companies/:companyId` | super_admin any; others own only | the negative-test path |
| `PATCH` | `/companies/:companyId` | super_admin | rejects a `status` field |
| `PATCH` | `/companies/:companyId/status` | super_admin | the only way to change status |
| ~~`POST`~~ | ~~`/companies/:companyId/users`~~ | — | **Removed in Module 3** — use `POST /users` |

Codes: `200` · `201` · `400` malformed id/query · `401` no token · `403` wrong role, wrong
company, or `COMPANY_SUSPENDED` · `404` unknown company · `409` duplicate name · `422` validation.

**Why `/companies/me` exists.** One endpoint returning "all" for one role and "one" for
another gets confusing fast, and that shape repeats for Stations, Sessions and Analytics.
Splitting it makes each endpoint's answer unambiguous — and `/me` is the safest shape in the
product, because there is no identifier for an attacker to change.

**Why status has its own endpoint.** Suspending a company is always deliberate, never a side
effect of an edit form posting a stale field.

## 8. Server-side scoping — the pattern

```ts
// WRONG — correctness depends on remembering the `if`
const company = await Company.findById(id);        // company B is already loaded
if (company.id !== req.user.companyId) throw forbidden();

// RIGHT — the database physically cannot return someone else's row
const filter = scope.isPlatformWide
  ? { _id: companyId }
  : { $and: [{ _id: companyId }, { _id: scope.companyId }] };
const company = await Company.findOne(filter);
```

In `getCompanyById` there is also an early `403` — that exists **only to choose the status
code**, because 403 "not yours" is more useful than a vague 404. Delete it entirely and a
cross-company read still returns nothing: the `$and` is the guarantee.

`req.user.companyId` comes from the verified token, re-checked against the database by
`auth.middleware.ts`. **A `companyId` supplied by the client is never trusted for access
decisions** — in the staff endpoint it isn't even accepted in the body.

### Reusable for Modules 4–13

`applyCompanyScope(user, filter)` in `utils/companyScope.ts` adds the caller's `companyId`
to any filter and returns it untouched for `super_admin`:

| Module | Usage |
| --- | --- |
| 4 Stations / 5 Chargers | `Station.find(applyCompanyScope(req.user, {}))` |
| 7 Sessions | driver → `{ userId }`; operator → company scope |
| 13 Analytics | scope as the **first** `$match` stage |

One audited function beats the same check hand-written eleven times. Analytics is the
nastiest case — one forgotten `$match` leaks a competitor's revenue.

## 9. Suspended companies — live enforcement

| | Behaviour |
| --- | --- |
| Can staff log in? | **Yes** — `/auth/login` and `/auth/me` unchanged |
| Company-scoped data | **403** `COMPANY_SUSPENDED` |
| Timing | **Live** — DB check per request |
| super_admin | Unaffected; can view and reactivate |
| User accounts | Untouched — separate switch |

**Login stays open** because authentication answers *who are you* and company status answers
*what may you touch*. Blocking login would also change a Module 1 contract, and would leave
the user staring at "invalid credentials" with no idea why.

**Live, not at next login**, because `companyId` is baked into the JWT — a token issued
before suspension would otherwise keep working for up to 7 days. Same reasoning as Module
1's user reload, and the same accepted cost: one indexed lookup. **Do not cache it.**

Verified: a token issued *before* suspension is refused immediately, and works again the
moment the company is reactivated — no re-login needed.

## 10. Scope note — the staff endpoint was a stopgap (REMOVED IN MODULE 3)

> **Superseded.** `POST /companies/:companyId/users` no longer exists. Staff are now created
> through `POST /api/v1/users` (Module 3), which is the single path for it. The route was
> retired rather than left running in parallel, because two endpoints doing the same job
> means a rule added later gets applied to one and silently missed on the other. The
> original rationale is kept below for the record.


`POST /companies/:companyId/users` creates a `cpo_admin` or `operator`. It exists because
Module 1 locked self-registration to drivers only, so without it there would be **no way to
create the company-scoped users whose isolation this module exists to prove**.

It is deliberately minimal — creation only. **Listing, editing, deactivation and password
reset are Module 3 and are not implemented here.** It is nested under `/companies` rather
than a bare `POST /users` so Module 3's URL namespace stays free.

Three constraints make it safe:

1. `companyId` comes from the URL path, which only `super_admin` can reach — structural, not a body field
2. `role` accepts only `cpo_admin | operator` — a strict Zod enum; `super_admin` or `driver` is a 422
3. A `companyId` in the body is rejected outright by `.strict()`

## 11. Verification — 81 automated checks, all passing

### The isolation matrix

| Actor | Company A | Company B | `GET /companies` | `/companies/me` |
| --- | :-: | :-: | :-: | :-: |
| super_admin | 200 | 200 | 200 | 403 |
| cpo_admin_A | 200 | **403** | **403** | 200 → A |
| operator_A | 200 | **403** | **403** | 200 → A |
| cpo_admin_B | **403** | 200 | **403** | 200 → B |
| operator_B | **403** | 200 | **403** | 200 → B |
| driver | **403** | **403** | **403** | **403** |
| anonymous | **401** | **401** | **401** | — |

### Suspension

Pre-existing token refused with `COMPANY_SUSPENDED` · operator also refused · login still
works · `/auth/me` still works · super_admin still reads it · company A unaffected ·
reactivation restores access **with the original token**.

### Validation & privilege escalation

Malformed id → 400 · unknown id → 404 · duplicate name → 409 · missing name → 422 ·
unknown field (`saasFeePercent`) → 422 · `status` in general PATCH → 422 · empty update →
422 · invalid type → 422 · `role: super_admin` → 422 · `role: driver` → 422 ·
`companyId` in body → 422 · cpo_admin creating staff → 403 · cpo_admin updating own
company → 403.

### Regression

Module 0 health 200 on `ev_cms`; Module 1's 36 checks re-run green; JWT still carries role
and companyId; driver self-registration still driver-only.

**Frontend:** typecheck, lint and production build clean; all 8 routes serve; guards engage
while unauthenticated.

## 12. Frontend

| Route | Role | Content |
| --- | --- | --- |
| `/companies` | super_admin | List, search, status filter |
| `/companies/new` | super_admin | Create form |
| `/companies/[companyId]` | all three admin roles | Details, edit, suspend/activate, add staff |
| `/my-company` | cpo_admin, operator | Read-only own company |

`useAsyncData` (new) standardises load/error/success so every later data screen reuses it.

The dashboard shows role-aware links; a driver gets none. **That only hides links** — the
backend still answers 403 if those endpoints are called directly, which is where enforcement
actually lives.

## 13. Changes to previous modules

- `validate.middleware.ts` — added `validateParams` (**400**, because a malformed path
  segment means the URL is wrong) and `validateQuery` (coerces `?page=2` to a number).
- `express.d.ts` — added `req.company`, populated by `requireActiveCompany` so
  `/companies/me` needs no second lookup.
- `roles.ts` — added `ASSIGNABLE_COMPANY_ROLES`.
- `user.model.ts` — added the company-relationship validator (§6). No shape change.

No API contract, folder structure or naming convention from Modules 0–1 was altered.

## 14. Known state / notes

- `npm run seed:demo` creates **Livanto Green** and **Sharma Energy** with staff:
  `cpo@livanto.local` / `Cpo@12345`, `ops@livanto.local` / `Ops@12345`,
  `cpo@sharma.local` / `Cpo@12345`, `ops@sharma.local` / `Ops@12345`.
  Weak on purpose; never use outside local development.
- Company **deletion** is not implemented. Suspension is the reversible, audit-friendly
  equivalent, and deleting a company would orphan its stations and sessions from Module 4 on.
- `cpo_admin` cannot yet edit their own company. Kept super_admin-only for Module 2.

## 15. What Module 3 will add

Full User / EV Owner management: listing users (company-scoped for `cpo_admin`, using
`applyCompanyScope`), editing profiles, activating/suspending accounts, driver and vehicle
records — and it will supersede the §10 stopgap with a proper user-management surface.
