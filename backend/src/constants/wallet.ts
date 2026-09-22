/**
 * Wallet and payment constants.
 *
 * THREE STATE MACHINES LIVE IN THIS MODULE, and none of them is the session's:
 *
 *   Wallet.status                  can this wallet be used at all
 *   PaymentTransaction.status      what an external provider, or an internal debit, has done
 *   ChargingSession.paymentStatus  has this particular charge been collected
 *
 * A session can be `completed` while its payment is `pending`. That is not an error — it is the
 * honest state after electricity was delivered to a driver who could not pay for it yet.
 */

export const WALLET_STATUSES = [
  /** Normal. Credits and debits allowed. */
  'active',
  /** Frozen by an administrator. No movement in either direction. */
  'blocked',
] as const;

export type WalletStatus = (typeof WALLET_STATUSES)[number];

/* -------------------------------------------------------------------------- */

/**
 * What moved money, from the LEDGER's point of view.
 *
 * Deliberately small. Each value corresponds to a real flow that exists today — there is no
 * `bonus`, `cashback` or `promotion` here because nothing produces them.
 */
export const WALLET_TRANSACTION_TYPES = [
  /** Money in, from a verified Razorpay payment. */
  'recharge',
  /** Money out, paying for a completed charging session. */
  'session_debit',
  /** Money back, reversing a recharge. */
  'refund',
] as const;

export type WalletTransactionType = (typeof WALLET_TRANSACTION_TYPES)[number];

/**
 * Which way the money went.
 *
 * Redundant with `type` today (recharge and refund are always credits, session_debit always a
 * debit) and kept anyway: a ledger is read by people, and summing "all debits" should not
 * require knowing which of a growing list of types happen to be outgoing.
 */
export const LEDGER_DIRECTIONS = ['credit', 'debit'] as const;
export type LedgerDirection = (typeof LEDGER_DIRECTIONS)[number];

/* -------------------------------------------------------------------------- */

/**
 * PaymentTransaction lifecycle.
 *
 *   pending  a Razorpay order exists but is unverified, OR a session debit is awaiting funds
 *   paid     settled — money actually moved
 *   failed   terminal. The provider rejected it, or an order was abandoned
 *   refunded a completed recharge that was later reversed
 *
 * `pending` covering both "awaiting the provider" and "awaiting funds" is deliberate: from the
 * platform's side they are the same thing — money that ought to arrive and has not.
 */
export const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Statuses that still occupy a session — used by the partial unique index on sessionId. */
export const LIVE_PAYMENT_STATUSES: PaymentStatus[] = ['pending', 'paid'];

export const PAYMENT_PURPOSES = [
  /** External: driver adds money via Razorpay. */
  'wallet_recharge',
  /** Internal: the platform collects for a completed charge. Never touches Razorpay. */
  'session_debit',
] as const;

export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

/** Only one provider today. `internal` marks a movement that never left the platform. */
export const PAYMENT_PROVIDERS = ['razorpay', 'internal'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

/* -------------------------------------------------------------------------- */

/**
 * Recharge bounds, in paise.
 *
 * ₹10 minimum — below that the payment-gateway fee exceeds the top-up, which is not a service.
 * ₹10,000 maximum — a sandbox project has no business moving more, and an upper bound is the
 * cheapest possible guard against a fat-fingered extra zero.
 */
export const MIN_RECHARGE_PAISE = 1_000;
export const MAX_RECHARGE_PAISE = 1_000_000;

/** How often the sweeper LOOKS for work. Matches Module 7's session sweeper cadence. */
export const SETTLEMENT_SWEEP_INTERVAL_MS = 15_000;

/*
 * RETRY BACKOFF — why a short-wallet session is not retried every 15 seconds.
 *
 * A shortfall does not resolve on its own. Nothing about the wallet changes between two
 * attempts made seconds apart, so the second attempt is guaranteed to fail exactly like the
 * first. The thing that actually resolves a shortfall is a TOP-UP, and that path is already
 * event-driven: `settleOutstandingForUser` runs the moment money lands, ignoring this backoff
 * entirely.
 *
 * That leaves the sweeper as a pure safety net — for a session that was priced but never
 * settled because the process died in between. A safety net does not need to run four times a
 * minute forever, and when it does, two things break:
 *
 *   1. churn   — one Mongo transaction per attempt per session, indefinitely.
 *   2. STARVATION — the sweeper takes the OLDEST unpaid sessions. If the oldest never clear,
 *                   the window is permanently full and a newly unpaid session is never looked
 *                   at at all. That is the real bug; the log noise is just the symptom.
 *
 * Doubling from 30s to a 6-hour ceiling takes a permanently unpayable session from ~5,760
 * pointless attempts a day down to 4, without ever declaring the debt dead — the electricity
 * was delivered, so the money is still owed, and the next top-up still collects it.
 */
export const SETTLEMENT_RETRY_BASE_MS = 30_000;
export const SETTLEMENT_RETRY_MAX_MS = 6 * 60 * 60 * 1_000;

/** How many sessions one sweep will look at. */
export const SETTLEMENT_SWEEP_BATCH = 25;

/**
 * Attempts that log at WARN before dropping to DEBUG.
 *
 * A session that fails to collect the first couple of times is worth an operator's attention.
 * The four-thousandth identical line is not — it is what buried the starvation bug.
 */
export const SETTLEMENT_LOUD_ATTEMPTS = 3;

/* -------------------------------------------------------------------------- */
/* Arrears — may a driver who already owes money start another charge?        */
/* -------------------------------------------------------------------------- */

/**
 * WHY THIS EXISTS AT ALL.
 *
 * Electricity cannot be repossessed. Once a car has drawn power the cost is sunk, so the only
 * moment a CPO has any leverage is BEFORE the contactor closes. A platform that bills after
 * the fact and never checks the balance before starting is not extending credit deliberately —
 * it is extending unlimited credit by accident, to anyone, forever.
 *
 * This is what happened in this database: nothing checked, so drivers kept charging on empty
 * wallets and the debt simply accumulated.
 *
 * THE TWO LIMITS ARE DELIBERATELY DIFFERENT QUESTIONS.
 *
 *   amount  — "how exposed are we?"        one expensive session can breach this alone
 *   count   — "is this person ever paying?" many tiny debts never breach an amount cap,
 *                                           but the pattern is the same problem
 *
 * Either one trips the block, because either one alone is a real answer.
 */

/**
 * Total unpaid across all sessions, in paise, above which new charges are refused. ₹200.
 *
 * NOT ZERO, on purpose. Settlement is asynchronous: a session that ended seconds ago is
 * legitimately unpaid for as long as it takes the debit to clear. Blocking at ₹0.01 would lock
 * a driver out of the charger they just unplugged from, for a debt that was about to settle
 * itself. The grace buffer is what separates "owes money" from "is not paying".
 */
export const ARREARS_MAX_OUTSTANDING_PAISE = 20_000;

/**
 * Unpaid sessions, regardless of value, above which new charges are refused.
 *
 * Catches what the amount cap cannot: a driver running up many small debts, each far below the
 * money threshold. Three is a pattern, not an accident.
 */
export const ARREARS_MAX_UNPAID_SESSIONS = 3;

/**
 * How long a debt must have gone uncollected before it counts as arrears. 15 minutes.
 *
 * SETTLEMENT IS ASYNCHRONOUS, so "unpaid" and "not paying" are different claims. A session
 * that ended thirty seconds ago is legitimately unpaid: the debit may not have run yet, or it
 * ran and the top-up landed a moment later. Counting it immediately would mean a driver whose
 * money is already in flight gets refused at the next charger, which is both wrong and the
 * kind of wrong that generates support tickets instead of payments.
 *
 * Ageing the debt first is what makes the signal mean what it says. Everything inside this
 * window is the system's problem to resolve; everything outside it has had a fair chance to
 * settle and did not.
 */
export const ARREARS_GRACE_MS = 15 * 60 * 1_000;
