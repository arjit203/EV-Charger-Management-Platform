# Module 10 — Wallet & Payments

**Status:** Complete · 103 Module 10 checks passing (83 HTTP + 20 in-process), 870 across Modules 1–10
**Depends on:** Module 7 (sessions) and Module 9 (pricing, integer paise)
**Feeds:** Module 11 (complaints/disputes), Module 13 (revenue analytics)

---

## 1. Purpose

Module 9 worked out what a charge costs. Module 10 collects it.

```
ChargingSession → energy → tariff → amountPaise → WALLET → PaymentTransaction
```

Razorpay in **TEST mode only**. No live credentials anywhere.

---

## 2. Step 0 — the Module 9 carryover (D13)

Module 9 left a sharp edge: deactivating a company's last active tariff stopped all charging
there, and only the UI warned about it. That was defensible while a missing tariff merely blocked
new sessions. It stopped being defensible once money depends on it — the blast radius is now
*every future charge stops, and anything awaiting settlement has no rate to collect against.*

**Deactivating a company's last active tariff is now refused (409.)** The activate-a-replacement
*swap* is unaffected — that path deactivates the incumbent inside a transaction, never through
the status endpoint — so changing your rates still works. Only a bare deactivation that would
leave zero active tariffs is blocked.

---

## 3. Three models, and why they are three

| Model | Answers | Mutability |
|---|---|---|
| **Wallet** | How much does this driver have? | balance moves, never set |
| **WalletTransaction** | How did it get to that number? — the **internal ledger** | append-only, never updated |
| **PaymentTransaction** | What did we say to Razorpay, and what came back? | mutates as the provider reports |

**Why the ledger and the gateway record are separate:**

- Not every wallet movement involves a provider. A session debit never touches Razorpay.
- Not every provider interaction moves the wallet. An abandoned order is a real Razorpay record
  with no ledger entry.
- Different lifecycles. A `PaymentTransaction` changes state as an external system reports back;
  a ledger row is an immutable accounting fact.

Merging them would produce a table where half the columns are null half the time, and would let a
foreign system's retry semantics leak into the accounting record.

`balanceBefore`/`balanceAfter` on every ledger row means the balance is **reconstructible**. A
test sums the ledger and asserts it equals the stored balance — a ledger you never reconcile is
just a log.

**Money is integer paise throughout**, inherited from Module 9 without exception. Razorpay's API
takes paise natively, so `amountPaise` passes through with no conversion layer — the payoff
Module 9 predicted.

---

## 4. The four load-bearing mechanisms

### D1 — Idempotency is always a database unique constraint

| Flow | Index | Prevents |
|---|---|---|
| Recharge verify | unique `providerPaymentId`, partial `$type: 'string'` | Double-crediting one Razorpay payment |
| Webhook | **the same index** | A webhook and a client verify racing |
| Session debit | unique `chargingSessionId`, partial to `status ∈ {pending, paid}` | Two settlements for one session |

Webhook and client-verify are **not** two mechanisms — two callers hitting one constraint, which
is why a race between them is safe.

A duplicate webhook gets **200 with "already processed"**, never a 4xx. Razorpay retries anything
that is not a 2xx, so telling it a duplicate failed produces *more* duplicates.

**Partial, not sparse** — the Module 7 lesson. `providerPaymentId` is `null` until a payment
completes, and `null` is *present*; under `sparse` the second unverified order in the database
would collide with the first. Verified empirically:

```
providerPaymentId duplicate  -> REJECTED E11000  (index fires)
two NULL providerPaymentIds  -> ALLOWED  (partial working; sparse would break here)
two live session payments    -> REJECTED E11000  (index fires)
```

### D2 — Atomic wallet debit: the guard goes in the filter

```js
Wallet.findOneAndUpdate(
  { _id, status: 'active', balancePaise: { $gte: amountPaise } },
  { $inc: { balancePaise: -amountPaise } },
)
```

The check and the decrement are **one operation**. Two simultaneous debits cannot both read
"sufficient" before either writes — the second matches no document and returns `null`.

**This is deliberately not a transaction.** A balance guard is a single-document concern, and
MongoDB guarantees single-document atomicity without one. Wrapping it would be reaching for
machinery the problem does not need.

### D3 — Multi-document consistency, in one transaction

A settlement touches four documents. "What if the wallet is debited but the ledger write fails?"
has one answer: **that state cannot exist.**

```
withTransaction:
  1. atomic debit          -> null means insufficient, abort
  2. WalletTransaction     -> balanceBefore / balanceAfter
  3. PaymentTransaction    -> pending → paid
  4. ChargingSession       -> paymentStatus = 'paid'
```

Verified: Atlas is a replica set (`atlas-9wvi0q-shard-0`) and a probe transaction committed.
Module 9's `setTariffStatus` already depends on this, so no new infrastructure decision.

### D4 — Webhook raw body

Razorpay's webhook signature is an HMAC over the **exact bytes sent**. `express.json()` at
`app.ts:50` parses and discards them before any route handler runs.

Solved with the `verify` hook rather than mounting `express.raw` on the webhook path — that mount
would have to be registered before the global parser, making the payments router depend on
middleware ordering in a file it does not own.

```js
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
```

---

## 5. What triggers settlement

Module 9's `pre('save')` hook already fires at all five terminal transitions, so bolting payment
onto it was tempting. **It would have been wrong:**

> Pricing is **pure arithmetic** — safe in a hook. Payment is **I/O with external side effects,
> its own failure modes, and a transaction boundary** — a hook would run it inside the OCPP
> message handler, inside the heartbeat sweep, wherever `save()` happened to be called.

| Step | Where |
|---|---|
| Price the session | `pre('save')` hook (Module 9) — pure, unskippable |
| Mark awaiting settlement | same hook, `paymentStatus: 'unpaid'` |
| **Settle** | a service, called two ways |

1. **Inline, best-effort** — after `onStopTransaction`. The 95% path; gives the driver an instant
   "paid". Fire-and-forget, because a payment problem must never fail the OCPP message.
2. **A settlement sweeper** — every 15s, same shape as Module 7's session sweeper. Catches what
   the inline path missed, **and retries**.

The idempotency index makes a race between them harmless, which is what lets the inline attempt
be best-effort rather than load-bearing.

**A zero-amount session** is marked `paid` by the pricing hook with no ledger entry and no
payment record — there is nothing to collect.

### D5 — A top-up settles outstanding sessions

This is what makes the failure case resolve rather than dead-end. A driver who charges with ₹20
in the wallet and owes ₹60 tops up, and the debt clears automatically — no "pay now" button.

---

## 6. Two state machines that must not be conflated

```
ChargingSession.status          initiating → active → stopping → completed / failed
ChargingSession.paymentStatus   unpaid → paid
PaymentTransaction.status       pending → paid / failed / refunded
```

**`completed` + `unpaid` is a correct state**, not an error: the electricity flowed and the wallet
was short. You cannot un-deliver electricity.

There is deliberately no `failed` on the session — a short wallet is not permanent. `paymentStatus`
is a denormalised projection of the authoritative `PaymentTransaction`, written in the **same
transaction**, so they cannot drift.

---

## 7. Razorpay, and how this stays testable (D6)

| Piece | Network? | Tested |
|---|---|---|
| Order creation | yes | Real SDK when credentials set; deterministic stub when absent |
| **Payment verification** | **no** | Our own HMAC — fully exercised offline |
| **Webhook verification** | **no** | Our own HMAC over raw bytes |

**The stub is gated on credentials being absent, not on a flag.** Audited by reading every
reference: the only condition anywhere is

```js
export function isLiveProvider(): boolean {
  return Boolean(env.razorpayKeyId && env.razorpayKeySecret);
}
```

No `PAYMENTS_STUB`, no `NODE_ENV` check, no override. A deployment with working keys cannot be in
stub mode.

Signature comparison uses `crypto.timingSafeEqual` — `===` returns at the first differing byte,
so how long it took leaks how much of a guess was right.

---

## 8. Permissions

| Action | super_admin | cpo_admin | operator | driver |
|---|---|---|---|---|
| Own wallet / ledger / recharge | — | — | — | ✓ |
| View payments | ✓ all | ✓ own company | ✓ read-only | ✓ own only |
| Reverse a recharge | ✓ | ✗ | ✗ | ✗ |
| **Set a balance** | **✗** | **✗** | **✗** | **✗** |

**No endpoint accepts a balance** — not for admins either. Money moves only through a verified
payment, an atomic debit, or a reversal.

Wallet ownership is `userId`, never `companyId` — a driver belongs to no company. Company scoping
applies only to the staff payment views, through the session's denormalised `companyId`.

**Refunds are narrowed to recharge reversal.** Session-debit refunds have no demonstrated need —
a driver correctly billed for electricity they received has nothing to refund, and a disputed
charge is Module 11's problem, not a silent reversal.

---

## 9. API

| Method | Path | Who |
|---|---|---|
| `GET` | `/wallet` | driver (+ outstanding total) |
| `GET` | `/wallet/transactions` | driver |
| `POST` | `/wallet/recharge/order` | driver |
| `POST` | `/wallet/recharge/verify` | driver |
| `GET` | `/payments`, `/payments/:id` | all, scoped |
| `POST` | `/payments/:id/refund` | super_admin |
| `POST` | `/payments/webhook/razorpay` | Razorpay — signature only, **no JWT** |

**No `POST /charging/sessions/:id/pay`.** Settlement is automatic and retried; a manual pay
endpoint would be a second path to the same state, and Module 7's D12 is the cautionary tale.

Recharge bounds: **₹10 minimum, ₹10,000 maximum.**

---

## 10. The bug the tests caught

The first implementation **double-credited under concurrency.** Four concurrent verifies of one
payment all credited — ₹500 became ₹900.

The unique index on `providerPaymentId` did not stop it, and understanding why matters: that index
prevents two *different* PaymentTransactions claiming one Razorpay payment. Here all four callers
were updating the **same row**, so there was never a second document to collide with. The index
was necessary but never sufficient.

The real fault was `if (payment.status === 'paid') return` — a read outside the transaction, then
a write. Four readers all saw `pending`. **Check-then-act, exactly the shape of the Module 7
connector race**, in the one module where it costs actual money.

The fix is D2 applied to the payment row — the status guard moved into the filter:

```js
PaymentTransaction.findOneAndUpdate(
  { _id, status: 'pending' },              // the guard is here, not in an `if`
  { $set: { status: 'paid', providerPaymentId, paidAt } },
  { session },
)
```

Exactly one of N concurrent callers can match `pending`. The same fix was applied to
`settleSession`.

---

## 11. Verification — 103 checks

**83 over HTTP:** wallet access and ownership, recharge bounds, signature verification (tampered
payment id, tampered order id, wrong secret), idempotent verify, webhook acceptance/rejection/
duplicates, the webhook-vs-verify race, session settlement, insufficient balance, auto-settle on
top-up, company scoping, refunds, and ledger reconciliation.

**20 in-process**, in `settlement-race.test.mjs`. These races cannot be driven over HTTP without
adding a test-only endpoint that moves money — which is exactly the liability Module 7's D12 had
to delete. So the script loads the compiled services from `dist/` and calls them with genuine
parallelism:

```
8 concurrent settlements: exactly ONE paid
₹100 wallet, 5 × ₹30 demanded: exactly 3 settled
the balance is ₹10.00, not negative
the ledger still reconstructs the balance
repeated attempts reuse ONE payment row
```

### End-to-end, both scenarios

**A — the happy path**

```
1. opening balance           ₹500.00
2. recharge ₹500             payment paid, wallet ₹1000.00
3. charged 5 kWh @ ₹12.00/kWh
   session status            completed
   amount                    ₹60.00
   payment status            paid
   wallet after              ₹940.00
4. ledger (3 entries):
   debit     ₹60.00  ->   ₹940.00  session_debit
   credit   ₹500.00  ->  ₹1000.00  recharge
   credit   ₹500.00  ->   ₹500.00  recharge
```

**B — charged more than he had**

```
1. bob's wallet              ₹20.00
2. charged 5 kWh -> ₹60.00 owed
   session status            completed   <- electricity WAS delivered
   payment status            pending     <- NOT falsely paid
   reason                    Insufficient balance for ₹60.00
   wallet                    ₹20.00      <- untouched
3. bob tops up ₹100...
   payment status            paid        <- settled itself
   wallet  ₹20 + ₹100 - ₹60 = ₹60.00
   outstanding               ₹0.00
```

---

## 12. Files

**New (backend):** `constants/wallet.ts`, `models/{wallet,walletTransaction,paymentTransaction}.model.ts`,
`payments/razorpay.ts`, `services/{wallet,payment}.service.ts`, `validators/payment.validator.ts`,
`controllers/payment.controller.ts`, `routes/payment.routes.ts`

**Changed (backend):** `app.ts` (rawBody), `types/express.d.ts`, `config/env.ts`, `.env.example`,
`constants/session.ts`, `models/chargingSession.model.ts` (paymentStatus),
`services/sessionEvents.service.ts` (inline settlement), `services/tariff.service.ts` *(D13,
flagged Module 9 touch)*, `server.ts`, `routes/index.ts`

**New (frontend):** `services/wallet.service.ts`, `app/wallet/page.tsx`
**Changed (frontend):** `types/api.ts`, `app/sessions/[sessionId]/page.tsx`, `app/dashboard/page.tsx`

---

## 13. Known limits — say these before an interviewer finds them

- **No payout system.** Money reaches the platform, not the CPO's bank. Settlement to operators is
  a real product surface and deliberately out of scope.
- **No partial payment.** A session is settled in full or not at all.
- **The sweeper retries forever.** A driver who never tops up accumulates unpaid sessions with no
  escalation, dunning, or write-off policy.
- **No admin balance adjustment.** Intentional — it needs an approval trail, and nothing asks for
  it yet.
- **Refunds are recharge-only**, and only reverse the full amount.
- **Webhooks require a public URL**, so in local development the client-verify path is what runs.
  Both hit identical code, so the difference is reachability, not behaviour.
- **No GST/tax handling**, carried over from Module 9.

---

## 14. What Module 11 adds

Complaints — where `appliedTariffId` and the ledger finally earn their keep. A driver disputing a
charge needs the rate that was in force, the meter readings behind it, and the ledger row that
collected it. All three already exist.
