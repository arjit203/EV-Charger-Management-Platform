# Module 12 — Notifications

**Status:** Complete · 69 Module 12 checks passing, 1032 across Modules 1–12
**Depends on:** Modules 7, 8, 10 and 11 — one line added at each of their existing choke points
**Feeds:** nothing yet; it is the module everything else talks *through*

---

## 1. Purpose

In-app notifications. A driver learns their charge started, finished, was paid for, or could not
be collected — without watching a screen. Staff learn a complaint was filed.

This is the module that ties the previous five together: it has almost no logic of its own and
exists entirely to announce what they already do.

---

## 2. D1 — Where the triggers live

The brief asked for `createNotification()` calls inside Modules 7, 10 and 11's business logic.
After Module 11 we'd agreed the opposite — that Module 12 should subscribe. The resolution is
neither; it's a pattern already in the codebase.

Three mechanisms considered, two rejected:

| Mechanism | Verdict |
|---|---|
| `pre('save')` hook | Module 9's D6 used one for pricing because it is **pure arithmetic**. Notification creation is I/O. |
| `post('save')` hook | Worse. Inside `withTransaction` (Module 10's D3) the save can still **roll back** — it would announce a payment that never committed. |
| **An explicit call beside the existing emit** | ✓ |

Module 8's `realtime.emitSessionStatus()` already sits at every one of these transitions: after
the write, fire-and-forget, wrapped. A notification is the *same shape of thing*. So it goes on
the adjacent line:

```ts
realtime.emitSessionStatus(toPublicChargingSession(session));   // Module 8
void notify.sessionStarted(session);                            // Module 12
```

**Eleven call sites** (I estimated ten in the design; the audit found eleven), every one a bare
`void notify.x(...)` after the write commits, never inside a transaction body:

| File | Sites |
|---|---|
| `sessionEvents.service.ts` | 4 — started, completed, and two failure paths |
| `chargingSession.service.ts` | 2 — `markFailed`, and stop-while-offline |
| `payment.service.ts` | 3 — recharged, settled, short of funds |
| `complaint.service.ts` | 2 — filed, status changed |

No business logic moved. A call site says *"this happened"*; `notification.service` decides
whether anyone is told, who, and what it says. If the wording or audience changes, it changes in
one file.

---

## 3. D2 — `dedupeKey`, not a key made of ids

The mechanism is the project's usual one — a unique index — but the obvious key is wrong:

```
{ userId, referenceType, referenceId, type }   ← breaks a real case
```

`complaint_updated` fires on **every** status change. `in_progress`, `resolved` and `closed` are
three distinct, individually useful events sharing one reference and one type; that index would
silently swallow the second and third.

So the caller states the event:

```
session:<id>:started        complaint:<id>:resolved
session:<id>:completed      complaint:<id>:closed
session:<id>:paid           payment:<id>:recharged
session:<id>:pending        complaint:<id>:created   (per staff member)
```

```js
notificationSchema.index({ userId: 1, dedupeKey: 1 }, { unique: true });
```

**"The same event" is a business concept the caller knows and an index cannot infer.**

**The case that makes it essential, not theoretical:** Module 10's settlement sweeper retries an
unpaid session **every 15 seconds, indefinitely**. Without this, a driver who cannot afford a
charge would be told "payment pending" four times a minute, forever.

*Verified:* an unpaid session left through 35 seconds — more than two sweeps — produced exactly
**one** `payment_pending` row and exactly **one** socket delivery.

---

## 4. D3 — One row per user. No broadcast.

A company-level event writes one row per staff member — every `cpo_admin` **and** `operator` of
that company. Operators are included because Module 11 lets them work tickets.

The argument against a shared row is the question it cannot answer: **what would "mark as read"
mean?** Read by one person, or by all? There is no clean answer, so ownership stays 100%
`userId`-based — one scoping mechanism for the whole module, not two.

*Verified:* one complaint produced one row for Company A's cpo_admin and one for its operator,
with different ids — and **zero** for Company B's cpo_admin and operator.

---

## 5. D4 — Eight types, and why two are missing

| Type | Fires when | To |
|---|---|---|
| `charging_started` / `charging_completed` / `charging_failed` | session transitions | driver |
| `payment_success` / `payment_pending` | settlement outcome | driver |
| `wallet_recharged` | recharge verified | driver |
| `complaint_updated` | complaint status change | driver |
| `complaint_created` | new complaint | **staff fan-out** |

**`charger_fault` and `charger_offline` are deferred**, and the reason generalises:

> **Does someone need a persistent, personal record that a live dashboard does not already
> provide?**

A driver has no screen watching their session — they need the record. Staff watching `/monitor`
already get charger connectivity pushed live into the company room by Module 8; a notification
row would duplicate a channel that already works. Worth keeping as a permanent filter for any
future notification type.

`payment_pending` is the one that closes a loop: it is what prompts a driver to file the
`payment_issue` complaint Module 11 built a home for.

---

## 6. D5 — Socket.IO, and the bug it exposed

Delivery reuses Module 8's `user:{id}` room. One new event, `notification:new`. No new room type,
no new authentication — rooms are server-assigned and there is no join listener, so a driver
cannot subscribe to anyone else's notifications because there is no code path to ask.

**A test caught a real gap in that plan.** Module 8's `roomsFor()` gave a `user:{id}` room only
to drivers; staff joined `company:{id}` alone. So a `complaint_created` notification addressed to
a specific cpo_admin was written correctly and its **live delivery silently went nowhere**.

Fixed with a flagged change to Module 8: **every socket now joins its own `user:{id}` room**, in
addition to its role room.

> The user room is about **who you are**; the company and platform rooms are about **what you can
> see**. Everyone has the first.

This widens nothing it should not — the only other thing emitted to a user room is a session
event carrying the *driver's* id, and staff have no charging sessions. Module 8's 49 checks,
including its silence assertions, still pass unchanged.

---

## 7. Entity

Six fields plus timestamps. **No `metadata`** — `referenceType` + `referenceId` already let the
UI fetch full detail through the existing scoped endpoints, the same "reference, don't duplicate"
rule Module 11 applied. An unstructured blob with no defined shape is the speculative field this
project has declined everywhere.

**Two indexes:**

| Index | Why |
|---|---|
| `{ userId, isRead, createdAt: -1 }` | Serves all three queries — the list, the unread filter, the count — because every query is already pinned to a user. A standalone index on `isRead` or `createdAt` would never be used. |
| `{ userId, dedupeKey }` unique | D2 |

---

## 8. API

| Method | Path |
|---|---|
| `GET` | `/notifications` — newest first, `?unread=true` |
| `GET` | `/notifications/unread-count` |
| `PATCH` | `/notifications/:id/read` |
| `PATCH` | `/notifications/read-all` |

**No POST** — notifications come from business events, never a client. **No detail endpoint** —
the list already carries every field. **No `authorize(...)` anywhere in the router**: every role
has notifications, and ownership is the only boundary, identical for a driver and a super_admin.

Marking an already-read notification is **idempotent, not a 409** — re-reading something is not a
conflict. `read-all` is owner-scoped by construction, so it cannot touch another user's rows even
if someone later adds a parameter.

There is no admin path to another user's notifications at all. *Verified:* even `super_admin`
gets 404.

---

## 9. Frontend

A **bell in the dashboard header** with a live unread badge and a dropdown, plus `/notifications`
for full history. Clicking navigates to `/sessions/:id`, `/complaints/:id` or `/wallet` and marks
it read.

The badge count comes from the **server**, not from counting rows held locally — a local counter
drifts the moment something is read in another tab. Live updates use `useSocketEvent`, the hook
Module 8 built so listeners cannot accumulate.

One React Compiler fix along the way: the bell's initial load now uses the project's established
async-IIFE-with-`cancelled`-flag pattern rather than calling an async loader directly in an
effect body.

---

## 10. Verification — 69 checks

### The three you asked to see

**The sweeper does not spam:**
```
18. a payment_pending notification was created             PASS
24. STILL exactly one payment_pending after 2+ sweeps      PASS   (35s window)
24. and only one arrived over the socket                   PASS
```

**`complaint_updated` is per transition, not per reference:**
```
after in_progress: 1                                        PASS
after resolved: 2                                           PASS
after closed: 3 — the dedupe key is PER TRANSITION          PASS
each message is different                                   PASS
```

**Staff fan-out:**
```
19. company A cpo_admin was notified                        PASS
19. company A operator was notified too                     PASS
    company B cpo_admin was NOT                             PASS
    company B operator was NOT                              PASS
    each is its own row, not a shared one                   PASS
    the driver was not notified of their own complaint      PASS
```

Plus ownership isolation, read/unread and idempotent re-read, an 8-second silence window for
cross-user delivery, and **the row surviving with no socket connected**.

### End-to-end

```
after topping up Rs500  (1 unread)
  * Wallet topped up      ₹500.00 was added to your wallet.

session active  (2 unread)
  * Charging started      Your vehicle is now charging...

session finished  (4 unread)
  * Payment successful    ₹60.00 was paid from your wallet...
  * Charging completed    ...5.000 kWh for ₹60.00

complaint resolved  (6 unread)
  * Complaint resolved    Your complaint has been resolved: Charger firmware updated...
  * Complaint in progress Someone is looking into your complaint.

  delivered live over Socket.IO: 6
  stored in the database:        6
```

---

## 11. Files

**New (backend):** `constants/notification.ts`, `models/notification.model.ts`,
`services/notification.service.ts`, `validators/notification.validator.ts`,
`controllers/notification.controller.ts`, `routes/notification.routes.ts`

**Changed (backend, all flagged and minimal):** `realtime/publisher.ts` (one emit),
`realtime/rooms.ts` (**the user-room fix**), `services/{sessionEvents,chargingSession,payment,complaint}.service.ts`
(11 one-line calls), `routes/index.ts`

**New (frontend):** `services/notification.service.ts`, `components/NotificationBell.tsx`,
`app/notifications/page.tsx`
**Changed (frontend):** `types/api.ts`, `app/dashboard/page.tsx`

---

## 12. Known limits — say these before an interviewer finds them

- **In-app only.** No email, SMS or push. A driver who never opens the app never finds out.
- **No preferences.** A user cannot mute a type they do not care about.
- **No grouping.** Twenty sessions produce twenty notifications, not "20 charges this week".
- **No retention or TTL.** The table grows with activity, same honest gap as `MeterReading`.
- **Single instance**, like everything real-time here — Socket.IO rooms are in-memory. The row is
  always written, so the worst case is a missed live update, not a lost notification.
- **No `charger_fault` / `charger_offline`**, by the test in D4.
- **Fan-out is a loop**, so a company with hundreds of staff would want a different approach.

---

## 13. What Module 13 adds

Analytics. The first module that only *reads* — sessions, payments, complaints and now
notifications are all accumulating exactly the rows it will aggregate.
