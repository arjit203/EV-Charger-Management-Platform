/**
 * PaymentTransaction — the record of a collection attempt.
 *
 * Two kinds live here, and keeping them in one model is deliberate:
 *
 *   wallet_recharge   external. A Razorpay order, its verification, and what came back
 *   session_debit     internal. Collecting for a completed charge. Razorpay never involved
 *
 * They share a shape (who, how much, what state, what it relates to) and, more importantly, a
 * lifecycle: `pending -> paid | failed`. Splitting them would duplicate that machine.
 *
 * THIS MODEL CARRIES ALL THREE IDEMPOTENCY GUARANTEES for the module. They are database
 * indexes, not application checks, for the same reason as Module 7's one-session-per-connector
 * and Module 9's one-active-tariff-per-company: a rule that must hold under retry and
 * concurrency cannot live in an `if`.
 */

import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

import {
  LIVE_PAYMENT_STATUSES,
  PAYMENT_PROVIDERS,
  PAYMENT_PURPOSES,
  PAYMENT_STATUSES,
  type PaymentProvider,
  type PaymentPurpose,
  type PaymentStatus,
} from '../constants/wallet';
import { paiseToRupees } from '../utils/money';

export interface IPaymentTransaction {
  userId: Types.ObjectId;
  walletId: Types.ObjectId;

  purpose: PaymentPurpose;
  provider: PaymentProvider;

  /** Set only for `session_debit`. Null for a recharge. */
  chargingSessionId: Types.ObjectId | null;
  /** Denormalised from the session, so staff can see their own company's collections. */
  companyId: Types.ObjectId | null;

  amountPaise: number;
  status: PaymentStatus;

  /** Razorpay's order id (`order_...`). Null for an internal debit. */
  providerOrderId: string | null;
  /** Razorpay's payment id (`pay_...`). Null until a payment actually completes. */
  providerPaymentId: string | null;

  /** How many times settlement has been attempted. Only meaningful for a session debit. */
  attempts: number;
  /**
   * Earliest time the SWEEPER may retry this. Null means "never attempted, take it now".
   *
   * Only the blind sweeper honours this. A top-up is real new information about the wallet, so
   * `settleOutstandingForUser` collects immediately and ignores it.
   */
  nextAttemptAt: Date | null;
  failureReason: string | null;
  paidAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export type PaymentTransactionModel = Model<IPaymentTransaction>;

const paymentTransactionSchema = new Schema<IPaymentTransaction, PaymentTransactionModel>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    walletId: { type: Schema.Types.ObjectId, ref: 'Wallet', required: true },

    purpose: { type: String, enum: PAYMENT_PURPOSES, required: true },
    provider: { type: String, enum: PAYMENT_PROVIDERS, required: true },

    chargingSessionId: { type: Schema.Types.ObjectId, ref: 'ChargingSession', default: null },
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', default: null },

    amountPaise: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isInteger, message: 'Amount must be whole paise.' },
    },

    status: { type: String, enum: PAYMENT_STATUSES, required: true, default: 'pending', index: true },

    providerOrderId: { type: String, default: null },
    providerPaymentId: { type: String, default: null },

    attempts: { type: Number, required: true, default: 0, min: 0 },
    nextAttemptAt: { type: Date, default: null },
    failureReason: { type: String, maxlength: 200, default: null },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/* -------------------------------------------------------------------------- */
/* Idempotency                                                                */
/* -------------------------------------------------------------------------- */

/**
 * GUARANTEE 1 — one Razorpay payment can be credited exactly once.
 *
 * This single index covers BOTH the client's verify call and the webhook. They are not two
 * mechanisms: they are two callers racing for the same constraint. Whichever writes second gets
 * E11000 and reads the existing record instead of crediting again.
 *
 * PARTIAL, NOT SPARSE — the distinction that cost a real bug in Module 7. `providerPaymentId`
 * is `null` from the moment an order is created until a payment completes, and `null` is
 * PRESENT, not absent. Under `sparse` the second unpaid order in the entire database would
 * collide with the first.
 */
paymentTransactionSchema.index(
  { providerPaymentId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerPaymentId: { $type: 'string' } },
    name: 'one_credit_per_provider_payment',
  },
);

/** GUARANTEE 2 — one PaymentTransaction per Razorpay order. */
paymentTransactionSchema.index(
  { providerOrderId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerOrderId: { $type: 'string' } },
    name: 'one_payment_per_provider_order',
  },
);

/**
 * GUARANTEE 3 — one live collection attempt per charging session.
 *
 * Filtered to `pending` and `paid`, so a settlement that permanently failed can be superseded
 * while a session that is merely awaiting funds cannot be double-charged.
 *
 * Note what this makes safe: the inline settlement attempt and the background sweeper can both
 * fire for the same session, and one of them simply loses. That is exactly why the inline
 * attempt is allowed to be best-effort rather than load-bearing.
 */
paymentTransactionSchema.index(
  { chargingSessionId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      chargingSessionId: { $type: 'objectId' },
      status: { $in: LIVE_PAYMENT_STATUSES },
    },
    name: 'one_live_payment_per_session',
  },
);

/**
 * "Does this session have a payment row?" — the settlement sweeper's `$lookup`, every 15s. The
 * unique index above cannot serve it: it is PARTIAL (live statuses only) and a lookup's plain
 * equality does not imply that filter, so each lookup scanned the collection.
 */
paymentTransactionSchema.index({ chargingSessionId: 1, status: 1 });

/** "My payments, newest first." */
paymentTransactionSchema.index({ userId: 1, createdAt: -1 });

/** The staff view: collections at this company's stations. */
paymentTransactionSchema.index({ companyId: 1, createdAt: -1 });

/**
 * The settlement sweeper's query: session debits still pending, soonest-due first.
 *
 * `nextAttemptAt` leads the sort because the sweeper asks "what is due?", not "what is
 * oldest?". Sorting by age is what let a handful of permanently unpayable sessions sit at the
 * head of the queue and starve every newer one.
 */
paymentTransactionSchema.index({ purpose: 1, status: 1, nextAttemptAt: 1 });

/**
 * MODULE 13 - the revenue query, exactly.
 *
 * Analytics matches `{ companyId, purpose: 'session_debit', status: 'paid', paidAt: {...} }`
 * and nothing else, on every revenue endpoint. The existing `{ companyId, createdAt }` index
 * cannot serve it: revenue is anchored on `paidAt`, because a charge delivered on Monday and
 * settled on Wednesday is Wednesday's money.
 *
 * This is the one index that makes Module 13's "live query, no cache, no rollup" decision
 * honest rather than optimistic - the alternative to an index here is not a slower query, it
 * is a precomputed rollup collection and a second source of truth that can drift.
 *
 * Additive and behaviour-neutral: no existing query plan gets worse for having it.
 */
paymentTransactionSchema.index({ companyId: 1, purpose: 1, status: 1, paidAt: -1 });

export const PaymentTransaction = model<IPaymentTransaction, PaymentTransactionModel>(
  'PaymentTransaction',
  paymentTransactionSchema,
);

export type PaymentTransactionDocument = HydratedDocument<IPaymentTransaction>;

export interface PublicPaymentTransaction {
  id: string;
  userId: string;
  purpose: PaymentPurpose;
  provider: PaymentProvider;
  chargingSessionId: string | null;
  companyId: string | null;
  amountPaise: number;
  amountRupees: number;
  status: PaymentStatus;
  providerOrderId: string | null;
  /**
   * Exposed because a driver disputing a charge needs the reference Razorpay knows it by.
   * It is an identifier, not a credential — it authorises nothing on its own.
   */
  providerPaymentId: string | null;
  attempts: number;
  failureReason: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toPublicPaymentTransaction(
  payment: PaymentTransactionDocument,
): PublicPaymentTransaction {
  return {
    id: String(payment._id),
    userId: String(payment.userId),
    purpose: payment.purpose,
    provider: payment.provider,
    chargingSessionId: payment.chargingSessionId ? String(payment.chargingSessionId) : null,
    companyId: payment.companyId ? String(payment.companyId) : null,
    amountPaise: payment.amountPaise,
    amountRupees: paiseToRupees(payment.amountPaise),
    status: payment.status,
    providerOrderId: payment.providerOrderId,
    providerPaymentId: payment.providerPaymentId,
    attempts: payment.attempts,
    failureReason: payment.failureReason,
    paidAt: payment.paidAt ? payment.paidAt.toISOString() : null,
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
  };
}
