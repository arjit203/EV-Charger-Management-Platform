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

/** How often unsettled sessions are retried. Matches Module 7's session sweeper cadence. */
export const SETTLEMENT_SWEEP_INTERVAL_MS = 15_000;
