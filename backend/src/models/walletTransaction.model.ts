/**
 * WalletTransaction — the INTERNAL LEDGER.
 *
 * Every movement of a balance, append-only. A row is written once and never updated or deleted,
 * which is what makes it a ledger rather than a log.
 *
 * WHY THIS IS SEPARATE FROM PaymentTransaction — the question worth being able to answer:
 *
 *   - Not every wallet movement involves a payment provider. A session debit is purely
 *     internal; Razorpay never hears about it.
 *   - Not every provider interaction moves the wallet. An order created and then abandoned is a
 *     real Razorpay record with no ledger entry at all.
 *   - They have different lifecycles. A PaymentTransaction MUTATES as an external system
 *     reports back (pending -> paid). A ledger row is an immutable accounting fact.
 *
 * Merging them would give a table where half the columns are null half the time, and would let
 * a foreign system's retry semantics leak into the accounting record.
 *
 * `balanceBefore` / `balanceAfter` are stored on every row so the balance is RECONSTRUCTIBLE
 * from the ledger. If the two ever disagree, that is detectable rather than invisible — and a
 * test asserts they agree.
 */

import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

import {
  LEDGER_DIRECTIONS,
  WALLET_TRANSACTION_TYPES,
  type LedgerDirection,
  type WalletTransactionType,
} from '../constants/wallet';
import { paiseToRupees } from '../utils/money';

export interface IWalletTransaction {
  walletId: Types.ObjectId;
  /** Denormalised from the wallet so "my transactions" is one indexed query, not a join. */
  userId: Types.ObjectId;

  type: WalletTransactionType;
  direction: LedgerDirection;

  /** Always POSITIVE integer paise. `direction` carries the sign. */
  amountPaise: number;
  balanceBeforePaise: number;
  balanceAfterPaise: number;

  /** What caused this — a PaymentTransaction, and for a debit the session it settled. */
  paymentTransactionId: Types.ObjectId | null;
  chargingSessionId: Types.ObjectId | null;

  description: string;
  createdAt: Date;
  updatedAt: Date;
}

export type WalletTransactionModel = Model<IWalletTransaction>;

const walletTransactionSchema = new Schema<IWalletTransaction, WalletTransactionModel>(
  {
    walletId: { type: Schema.Types.ObjectId, ref: 'Wallet', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    type: { type: String, enum: WALLET_TRANSACTION_TYPES, required: true },
    direction: { type: String, enum: LEDGER_DIRECTIONS, required: true },

    /**
     * Positive, always. Storing a debit as a negative number invites a sign error somewhere in
     * a sum; keeping the amount absolute and the direction explicit does not.
     */
    amountPaise: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isInteger, message: 'Amount must be whole paise.' },
    },

    balanceBeforePaise: { type: Number, required: true, min: 0 },
    balanceAfterPaise: { type: Number, required: true, min: 0 },

    paymentTransactionId: { type: Schema.Types.ObjectId, ref: 'PaymentTransaction', default: null },
    chargingSessionId: { type: Schema.Types.ObjectId, ref: 'ChargingSession', default: null },

    description: { type: String, required: true, maxlength: 200 },
  },
  { timestamps: true },
);

/** "My transaction history, newest first" — the wallet page's only query. */
walletTransactionSchema.index({ userId: 1, createdAt: -1 });

/** Reconciliation: every movement for one wallet, in order. */
walletTransactionSchema.index({ walletId: 1, createdAt: 1 });

export const WalletTransaction = model<IWalletTransaction, WalletTransactionModel>(
  'WalletTransaction',
  walletTransactionSchema,
);

export type WalletTransactionDocument = HydratedDocument<IWalletTransaction>;

export interface PublicWalletTransaction {
  id: string;
  type: WalletTransactionType;
  direction: LedgerDirection;
  amountPaise: number;
  amountRupees: number;
  balanceAfterPaise: number;
  balanceAfterRupees: number;
  chargingSessionId: string | null;
  description: string;
  createdAt: string;
}

export function toPublicWalletTransaction(
  entry: WalletTransactionDocument,
): PublicWalletTransaction {
  return {
    id: String(entry._id),
    type: entry.type,
    direction: entry.direction,
    amountPaise: entry.amountPaise,
    amountRupees: paiseToRupees(entry.amountPaise),
    balanceAfterPaise: entry.balanceAfterPaise,
    balanceAfterRupees: paiseToRupees(entry.balanceAfterPaise),
    chargingSessionId: entry.chargingSessionId ? String(entry.chargingSessionId) : null,
    description: entry.description,
    createdAt: entry.createdAt.toISOString(),
  };
}
