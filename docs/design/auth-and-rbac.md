# Authentication & RBAC

**Status:** ✅ Complete
**Depends on:** Module 0 (env, ApiError, asyncHandler, error middleware, response envelope)

---

## 1. Purpose (from zero)

Module 0 proved data can move. Module 1 answers the two questions every later request
depends on: **who is this?** (authentication) and **what are they allowed to do?**
(authorisation).

These are genuinely separate. Authentication is identity — proving you are the holder of
an account. Authorisation is permission — deciding whether that account may perform this
particular action on this particular record. Conflating them is how systems end up letting
any logged-in user read anyone's data.

## 2. Where it fits in the CPMS

This is not generic login; it is the backbone of the platform's permission model. A driver
may start a charging session, but only on their own account. Only an operator or admin may
send a `RemoteStopTransaction` to a charger. One CPO must never see another CPO's revenue.
Every one of those rules is enforced by the middleware and query-scoping conventions
established here.

## 3. The RBAC model (LOCKED)

| Role | Scope | Can do |
| --- | --- | --- |
| `super_admin` | Platform-wide | Manage companies/CPOs and platform-wide resources. The only unscoped role. |
| `cpo_admin` | Own `companyId` | Manage that company's stations, chargers, operators and operational data. Must never reach another company's data. |
| `operator` | Assigned company/stations | Monitor and operate chargers and stations; perform operational actions. No platform or company administration. |
| `driver` | Own records only | Own profile/vehicle/wallet, view available stations, start/stop **own** sessions, view **own** charging and payment history. No administrative resources. |

### The enforcement rule

**Ownership and company scoping are enforced server-side, in middleware and in
service-layer queries — never by frontend route restrictions alone.**

Role checks answer "may this *kind* of user call this endpoint". They do **not** answer
"does this user own this *particular* record". That second question is answered by scoping
the query itself:

```ts
// cpo_admin / operator
const filter = { companyId: req.user.companyId };
// driver
const filter = { userId: req.user.id };
```

Scope the query rather than fetching first and comparing afterwards. A filtered query
cannot leak a record by accident; a forgotten comparison can. `requiresCompanyScope(role)`
in `role.middleware.ts` exists for exactly this check from Module 2 onward.

## 4. Database entity — `User`

One collection covers every human actor, because they share identity, login and status;
what differs is `role`.

| Field | Notes |
| --- | --- |
| `name` | required, ≤120 chars |
| `email` | required, **unique**, lowercased, ≤254 |
| `phone` | optional |
| `passwordHash` | bcrypt, **`select: false`** |
| `role` | enum of the four roles, default `driver`, indexed |
| `status` | `active` / `suspended`, indexed |
| `companyId` | `ObjectId` ref → Company, default `null`, indexed |
| `lastLoginAt` | set on each successful login |
| `createdAt` / `updatedAt` | via `timestamps: true` |

Compound index on `{ companyId: 1, role: 1 }` supports the company-scoped lookups every
later module performs ("all operators belonging to company X").

### Design decisions

**`passwordHash`, not `password`, and no `pre('save')` hook.** Hashing goes through the
`User.hashPassword()` static and is called explicitly by the service. A hook that hashes
"the password field" is the classic source of double-hashing bugs when a document is saved
twice. Being explicit costs one line and removes the whole bug class.

**`select: false` on the hash.** Queries never return it unless asked with
`.select('+passwordHash')`. This is the main defence against leaking it through a careless
`res.json(user)`.

**`toPublicUser()` is an explicit allow-list.** The schema's `toJSON` transform deletes the
hash, but a delete-list silently leaks any sensitive field added later. `toPublicUser()`
names exactly what may leave the server, so anything new is private by default. It is also
the contract the frontend's `User` type mirrors.

**`status`, not deletion.** Suspending preserves the user's charging sessions and payment
history; deleting would orphan them.

**Forward reference to Company.** `companyId`'s `ref: 'Company'` points at a model that
does not exist until Module 2. Mongoose only resolves a ref on `.populate()`, so declaring
it now is safe and means Module 2 need not alter this schema.

## 5. Authentication mechanics

**Transport: `Authorization: Bearer <token>`.** Chosen over httpOnly cookies because it
makes backend-only testing straightforward and is the simplest path for authenticating the
Socket.IO connection in Module 8. The trade-off is that a token in `localStorage` is
readable by JavaScript, so an XSS bug becomes a session-theft bug. All knowledge of this
choice lives in `utils/jwt.ts`, `auth.middleware.ts` and `lib/authStorage.ts` — switching
to cookies later is a three-file change.

**The database is authoritative, not the token.** A JWT is a snapshot. A token issued
before an admin suspended an account still carries valid claims until it expires. So
`auth.middleware.ts` verifies the signature *and then reloads the user*, rejecting
suspended or deleted accounts. One indexed lookup per request is a cheap price for
revocation actually working. This is verified by test — see §8.

**Login does not reveal which emails exist.** A wrong password and an unknown email return
the identical 401 message. Distinguishing them would turn login into an account-enumeration
oracle.

## 6. Privilege escalation is blocked at two independent layers

Self-registration can only ever produce a `driver`.

1. **Validator** — `registerSchema` is `.strict()`, so a body containing `role` or
   `companyId` is *rejected* with a 422 naming the field. Without `.strict()`, Zod would
   silently strip unknown keys and the attempt would be invisible in the logs.
2. **Service** — `registerDriver()` hardcodes `role: 'driver'` and `companyId: null`,
   ignoring input entirely. This layer still holds if the schema is ever loosened.

Privileged accounts (`cpo_admin`, `operator`) are created by an authenticated
`cpo_admin`/`super_admin` in a later module. The first `super_admin` comes from
`npm run seed:admin`, which is also the only reason that script exists — bootstrapping
without a public endpoint that mints admins.

## 7. API

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/v1/auth/register` | Public | Create a **driver** account. Returns user + token. |
| `POST` | `/api/v1/auth/login` | Public | Email + password. Returns user + token. |
| `GET` | `/api/v1/auth/me` | Bearer | The caller's own profile. Self-scoped by definition. |

Status codes: `201` created · `200` ok · `401` bad credentials / bad token ·
`403` suspended or insufficient role · `409` email taken · `422` validation failed.

Error codes used: `VALIDATION_ERROR`, `UNAUTHORIZED`, `TOKEN_EXPIRED`, `TOKEN_INVALID`,
`FORBIDDEN`, `CONFLICT`, `NOT_FOUND`.

## 8. Verification performed

**Backend — 45 checks, all passing.**

Happy path: register → 201 with `role: driver`, `status: active`, `companyId: null` and a
token; login → 200; case-insensitive email login; `/auth/me` → 200 with the correct user;
`lastLoginAt` set after login; seeded `super_admin` logs in with the right role.

Security:

| Check | Result |
| --- | --- |
| `role: "super_admin"` in register body | **422** — rejected, not stripped |
| `companyId` in register body | **422** — rejected |
| `passwordHash` in any response body | never present (also checked for raw `$2a$`/`$2b$`) |
| Wrong password vs unknown email | identical 401 message — no user enumeration |
| Suspended mid-session, reusing a still-valid token | **403** — DB beat the token |
| Account deleted, reusing a still-valid token | **401** |
| Suspended user attempting login | **403** |
| No token / garbage token / missing `Bearer ` prefix | **401** with `TOKEN_INVALID` where applicable |
| Duplicate email | **409** `CONFLICT` |
| Weak password, invalid email, empty body | **422** with per-field `details` |

**Frontend:** `tsc --noEmit` clean, `eslint` clean, production build succeeds, `/`,
`/login`, `/register`, `/dashboard` all serve 200, and `/dashboard` renders the guard state
while unauthenticated.

**Module 0 regression:** `/health` still 200 with `database.name: "ev_cms"`; unknown routes
still 404 in the standard shape.

**Cleanup:** all `@test.local` users removed; only the seeded `admin@evcms.local` remains.

## 9. Change to a previous module

`error.middleware.ts` gained `translateKnownErrors()`, mapping MongoDB duplicate-key
(`11000`) → **409**, Mongoose `ValidationError` → **422**, and `CastError` → **400**.

Reason: a unique-index violation is a race the application cannot fully prevent — two
simultaneous registrations can both pass the "does this email exist?" check and only fail
at insert. Without this, that race surfaces as a 500, blaming the server for what is
really a conflict. This is an addition; no existing behaviour changed.

## 10. Frontend

```
src/
├── app/
│   ├── login/page.tsx        Email + password form
│   ├── register/page.tsx     Driver self-signup (no role field, by design)
│   └── dashboard/page.tsx    Guarded placeholder; shows the user from /auth/me
├── components/
│   ├── FormField.tsx         Labelled input with per-field error + a11y wiring
│   └── RequireAuth.tsx       Route guard (UX only — see below)
├── context/AuthContext.tsx   Session state; the only writer of the token
├── lib/
│   ├── authStorage.ts        localStorage access, try/catch wrapped
│   └── formatApiError.ts     Turns a 422 `details` array into per-field messages
└── services/auth.service.ts  login / register / me
```

`AuthProvider` never trusts a locally stored user object: on mount it resolves whatever
token is in storage by calling `/auth/me`, and discards the token if the backend rejects
it. A stale token therefore produces a clean login screen rather than silent 401s.

**`RequireAuth` is UX, not security.** It stops a logged-out visitor seeing an empty admin
shell. Anyone can bypass it by disabling JavaScript or calling the API directly. If an
endpoint is only protected by this component, it is not protected.

## 11. Known state / notes

- Seeded account: `admin@evcms.local` / `Admin@12345` (`super_admin`). **Change this
  password before the project is ever exposed publicly.**
- Logout is client-side only: a stateless JWT is invalidated by discarding it, so a stolen
  token stays valid until it expires. A server-side revocation list is a Module 16
  hardening item.
- No refresh-token rotation. `JWT_EXPIRES_IN` defaults to `7d`, so the user simply logs in
  again after that.
- `JWT_SECRET` is required at boot — unlike the database, there is no safe degraded mode
  for auth, so a missing secret stops the process.
- **Accepted performance cost.** Reloading the user on every authenticated request adds one
  indexed `findById` to every API call, and from Module 8 to every socket handshake. This is
  a conscious trade — working revocation over a few saved milliseconds — not an oversight.
  The token's `role`/`companyId` claims are therefore informational only; nothing authorises
  against them. Do not "fix" this with a Redis user cache when Module 8 makes things feel
  slow: a cache reopens the exact staleness window the reload closes. Changing it is a
  deliberate Module 16 decision requiring a cache-invalidation story.

## 12. What Module 2 will add

The `Company` model (MVP scope: name, type, admins, stations, status — **no** SaaS
licensing, deal management, subscription billing or payout configuration), company CRUD
restricted to `super_admin`, and the first real use of company scoping: `cpo_admin` and
`operator` queries filtered by `companyId`, with `User.companyId` finally populated.
