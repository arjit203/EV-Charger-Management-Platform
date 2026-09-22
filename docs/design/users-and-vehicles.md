# Users & Vehicles

**Status:** ✅ Complete
**Depends on:** Module 1 (auth, RBAC), Module 2 (company scoping)

---

## 1. Purpose (from zero)

Everyone else in the system is *staff* — they work for a company that operates chargers. A
**driver** is the opposite: a member of the public who owns an EV and wants to charge it.
They work for nobody.

That difference drives the whole module. Staff are defined by *who employs them*; drivers
are defined by *what they own* — a profile, vehicles, and later a wallet and charging
history.

## 2. The central distinction: role vs ownership

```
Role      : "may a DRIVER call PATCH /users/me/vehicles/:id ?"   -> yes, all drivers may
Ownership : "may THIS driver modify THIS vehicle?"               -> only if they own it
```

Every driver passes the role check — which is exactly why the role check alone is worthless
here. `driver_A1` and `driver_B1` have identical roles and must never touch each other's
cars. **Roles gate the endpoint; ownership gates the row.**

Module 2 built the company half of this (`applyCompanyScope`). Module 3 builds the personal
half (`applyOwnerScope`).

## 3. Why `companyId` cannot protect driver data

Drivers have `companyId: null` — locked by Module 1's validator, and correct, because a
driver can charge at *any* company's stations and belongs to none.

So a company-scoped filter on driver data would be `{ companyId: null }`, which matches
**every driver at once**. Company scoping doesn't merely fail here, it fails wide open.

| | `companyId` | `userId` |
| --- | --- | --- |
| Means | "which business owns this?" | "which person owns this?" |
| Guards | stations, chargers, company revenue | profile, vehicles, wallet, sessions |
| Applies to | staff | drivers |

**Never substitute one for the other.**

## 4. Entity — `Vehicle`

| Field | Notes |
| --- | --- |
| `userId` | → User, required, **indexed** |
| `make`, `model` | required |
| `registrationNumber` | required, **unique**, uppercased |
| `batteryCapacityKwh` | optional — Module 7 uses it to estimate charge % |
| `connectorType` | `CCS2 \| CHAdeMO \| Type2 \| GBT` — Module 5 matches it to connectors |
| `isActive` | soft-delete flag |
| timestamps | |

**A separate collection, not an array on `User`**, because (a) a driver can own several
with different connector types, and (b) Module 7's `ChargingSession` must reference *which*
vehicle was charged — that needs a stable `_id`, which an array element does not have.

**Indexes, justified.** `{ userId: 1 }` because *every* vehicle query is scoped by owner;
without it each read scans the collection. `registrationNumber` unique because a plate
identifies one physical car — two accounts claiming it is a data error worth blocking at
the database, not just in application code.

**Deletion is soft.** `DELETE` sets `isActive: false`. Module 7's sessions will reference
`vehicleId`; destroying the row would orphan the driver's charging history and any receipt
attached to it. Reactivation is a normal `PATCH { isActive: true }`.

## 5. `User` model — reviewed, unchanged

Module 1's fields already cover every EV-owner need: a driver's profile *is* name / email /
phone, and their identity is the `_id`.

**No fields added.** `dateOfBirth`, `avatarUrl`, `preferredConnector` would all be
speculative with no consumer.

**No split into a separate `Profile` model.** `select: false` on `passwordHash` already
separates auth data at the query level — the hash never leaves the database unless
explicitly requested. A second collection would add a join to every read for no gain.

**No new indexes.** Existing coverage (`email` unique, `role`, `status`, `companyId`,
`{companyId, role}`) matches every filter this module issues; that last compound *is* the
cpo_admin staff-list query. Name/email/phone search is a regex scan and will **not** use an
index — a conscious MVP acceptance at demo scale, recorded here rather than hidden behind a
text index nobody measured a need for.

## 6. Permissions

| Action | super_admin | cpo_admin | operator | driver |
| --- | :-: | :-: | :-: | :-: |
| `GET /users` | all | own company **staff** | ❌ 403 | ❌ 403 |
| `GET /users/:id` | any | own company staff | ❌ 403 | ❌ 403 |
| `POST /users` | any staff, any company | `operator` in own company | ❌ | ❌ |
| `PATCH /users/:id` | any | own company staff | ❌ | ❌ |
| `PATCH /users/:id/status` | any | own company staff | ❌ | ❌ |
| `PATCH /users/me` | ✅ | ✅ | ✅ | ✅ |
| `/users/me/vehicles/*` | ❌ | ❌ | ❌ | ✅ |

### Why a cpo_admin never sees drivers

Their list filter is `{ companyId: theirs, role: { $in: ['cpo_admin','operator'] } }`.
Drivers have no company, so they cannot match. **This is structural, not a rule bolted on.**

Do not "fix" it by giving drivers a `companyId` — it breaks Module 1's validator and, as
§3 shows, makes company scoping match every driver simultaneously.

### Why operators get nothing here

The justification for an operator seeing user data would be operational — "who is on my
charger right now" — and **no charger or session exists yet**. Building it now would be
speculative. Revisit in Module 7, where an active session creates the actual need.

## 7. API

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| `GET` | `/users` | super_admin, cpo_admin | paginated; `?page=&limit=&role=&status=&companyId=&search=` |
| `GET` | `/users/:userId` | super_admin, cpo_admin | scoped |
| `POST` | `/users` | super_admin, cpo_admin | staff only |
| `PATCH` | `/users/:userId` | super_admin, cpo_admin | name, phone only |
| `PATCH` | `/users/:userId/status` | super_admin, cpo_admin | active / suspended |
| `PATCH` | `/users/me` | any authenticated | name, phone only |
| `GET·POST` | `/users/me/vehicles` | driver | |
| `GET·PATCH·DELETE` | `/users/me/vehicles/:vehicleId` | driver | `DELETE` is a soft delete |

**There is deliberately no `GET /users/me`.** `/auth/me` already returns the current user;
a second identical read would be redundant surface.

### Error-code choices worth knowing

| Case | Code | Why |
| --- | --- | --- |
| cpo_admin requests a user outside their company | **403** | Ownership is the failure, not existence |
| cpo_admin requests an id that doesn't exist | **403** | Same answer on purpose — otherwise 404-vs-403 lets them probe which ids are real |
| super_admin requests a missing id | **404** | Nothing to hide from a platform-wide role |
| Driver requests another driver's vehicle | **404** | Within their own namespace, "not yours" and "doesn't exist" are the same fact; 403 would confirm the id is real |
| Malformed id in the path | **400** | The URL itself is wrong |
| Protected field in a body | **422** | Rejected, not stripped — the attempt stays visible |

## 8. Ownership enforcement

```ts
// WRONG — trusts the caller; writes into someone else's account
Vehicle.create({ ...input, userId: req.body.ownerId })

// WRONG — fetch, then hope the comparison is remembered
const v = await Vehicle.findById(id);
if (String(v.userId) !== req.user.id) throw forbidden();

// RIGHT — the database cannot return someone else's row
const v = await Vehicle.findOne(applyOwnerScope(req.user, { _id: id }));
```

`applyOwnerScope` in `utils/ownerScope.ts` is the reusable primitive. **One deliberate
difference from `applyCompanyScope`: there is no platform-wide bypass.** A super_admin gets
scoped too — a personal resource stays personal, and an admin who needs a user's data uses
the admin endpoints, which is an auditable path rather than a silent widening of a
self-service query.

Reused unchanged by Module 7 (sessions), 10 (wallet), 11 (complaints), 12 (notifications).
Wallet is the one where a mistake costs real money; vehicles are cheap practice.

## 9. Migration — Module 2's stopgap is retired

**`POST /companies/:companyId/users` is removed.** `POST /api/v1/users` is now the single
way to create staff.

Two live endpoints doing the same job is how a rule added later — an audit entry, a rate
limit, an extra check — gets applied to one path and silently missed on the other. Nothing
outside Module 2's own tests ever called it, so removal cost nothing.

Files changed in the already-locked Module 2: `company.routes.ts` (route deleted),
`company.controller.ts` (handler deleted), `company.service.ts` (`createCompanyUser` moved
to `user.service.ts`), `company.validator.ts` (schema moved to `user.validator.ts`), and
`types/pagination.ts` extracted so both services share one `Paginated<T>`. The frontend's
company-detail staff form now calls `POST /users`. Module 2's suite was repointed and gained
a check that the old route returns **404**.

**One contract difference:** the stopgap took `companyId` from the URL path, making the
binding structural. `POST /users` takes it from the body. The mitigations are explicit —
the endpoint is admin-only, the `role` enum still rejects anything but `cpo_admin|operator`,
the target company must exist, and for a **cpo_admin** caller a body `companyId` that isn't
theirs is refused with 403 rather than quietly honoured.

## 10. Deliberately deferred

- **Password change.** Module 1 built register/login/me only, so this would be a *new*
  endpoint, not a relocation. Nothing needs it yet — no forgot-password flow, no forced
  rotation. It belongs under `/auth` when a module creates the need.
- **Company reassignment** (`PATCH /users/:id/company`) and **role changes after creation.**
  Both are real operations with no consumer yet; both have knock-on effects once a user owns
  stations or sessions.
- **Hard vehicle deletion.** Only meaningful once Module 7 can confirm no session references
  the vehicle.

Recorded here so the omissions are visible rather than forgotten.

## 11. Verification — 102 checks, all passing

### The ownership matrix

Company A (`cpo_admin_A`, `operator_A`) · Company B (`cpo_admin_B`, `operator_B`) · drivers
`a1`, `a2`, `b1` · `Vehicle A1` and `Vehicle B1`.

| Actor | `GET /users` | A's staff | B's staff | A driver | Vehicle B1 |
| --- | :-: | :-: | :-: | :-: | :-: |
| super_admin | 200 all | 200 | 200 | 200 | — |
| cpo_admin_A | 200 **staff only** | 200 | **403** | **403** | — |
| operator_A | **403** | **403** | **403** | **403** | — |
| driver_a1 | **403** | **403** | **403** | **403** | **404** |
| anonymous | **401** | **401** | **401** | **401** | **401** |

`cpo_admin_A`'s list was asserted to contain **zero drivers** and **only** company-A users.

### Vehicle ownership

`driver_a1` reading, updating and deleting `Vehicle B1` all return **404**, and `Vehicle B1`
was then re-read as `driver_b1` to confirm it was **unmodified and still active** — proving
the attempts were rejected rather than partially applied. `userId` and `ownerId` in a create
body are **422**. Staff hitting vehicle endpoints: **403**.

### Self-service

Profile update works; `role`, `companyId`, `status`, `passwordHash` and `email` each
rejected with **422**; editing another user **403**; empty update **422**.

### Staff creation

`cpo_admin` creates an operator (companyId **forced to their own**); creating into company B
**403**; creating a `cpo_admin` **403**; roles `super_admin` / `driver` / `root` **422**;
super_admin without `companyId` **422**; unknown company **404**; duplicate email **409**.

### Status

cpo_admin suspends own operator → suspended staff **cannot log in** → reactivated;
suspending B's staff **403**; **self-suspension 403**.

### Validation

Invalid email, short password, short phone, bad `connectorType`, missing `make` → 422 ·
malformed ids → 400 · duplicate registration → 409.

### Regression

Module 1: **36/36**. Module 2: **82/82** (81 + the retired-route check). Frontend
typechecks, lints and builds clean; all 14 routes serve; guards engage.

## 12. Frontend

| Route | Role | Content |
| --- | --- | --- |
| `/users` | super_admin, cpo_admin | List, role/status filters, search |
| `/users/[userId]` | super_admin, cpo_admin | Detail, edit name/phone, suspend/activate |
| `/users/new` | super_admin, cpo_admin | Create staff (company selector for super_admin only) |
| `/profile` | all | Own profile, edit name/phone |
| `/my-vehicles` | driver | List, add, edit, deactivate/reactivate |

`AuthContext` gained `updateCurrentUser(user)` so a profile edit refreshes the cached user
without a second `/auth/me` round trip.

The user-detail page hides the suspend button on your own account — and the API refuses it
too, which is the part that matters.

## 13. Known state / notes

- Demo accounts (`npm run seed:demo`): `cpo@livanto.local` · `ops@livanto.local` ·
  `cpo@sharma.local` · `ops@sharma.local`, all weak passwords, local development only.
- Vehicles are driver-only. Staff accounts are not EV owners in this product.
- Search is case-insensitive regex across name, email and phone — unindexed by design (§5).

## 14. What Module 4 will add

Station management: the `Station` model owned by a `Company`, and the first use of
`applyCompanyScope` on a resource other than Company itself — `Station.find(applyCompanyScope(req.user, {}))`.
