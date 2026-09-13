/**
 * Wallet — a driver's prepaid balance.
 *
 * One per user, created lazily on first access rather than at registration, so Module 1's
 * signup flow is untouched. The upsert that creates it is atomic, so two simultaneous first
 * requests cannot produce two wallets.
 *
 * THE BALANCE IS NEVER WRITTEN DIRECTLY. There is no endpoint that accepts one — not for a
 * driver, not for an admin. It moves only through:
 *
 *   a verified Razorpay payment   (credit)
 *   a completed charging session  (debit)
 *   a recharge reversal           (credit)
 *
 * and every one of those writes a `WalletTransaction` in the SAME transaction, so the ledger
 * and the balance cannot disagree.
 */

import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

import { WALLET_STATUSES, type WalletStatus } from '../constants/wallet';
import { paiseToRupees } from '../utils/money';

export interface IWallet {
  userId: Types.ObjectId;
  /**
   * INTEGER PAISE. ₹500.00 is 50000.
   *
   * Module 9's convention, inherited without exception — floats cannot represent decimal money
   * exactly, and a balance is the last place you want accumulated drift.
   */
  balancePaise: number;
  status: WalletStatus;
  createdAt: Date;
  updatedAt: Date;
}

export type WalletModel = Model<IWallet>;

const walletSchema = new Schema<IWallet, WalletModel>(
  {
    /**
     * Ownership is the USER, never the company.
     *
     * A driver belongs to no company (Module 3), and charges at whichever operator's station
     * they happen to stop at. A wallet scoped by company would make no sense.
     */
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

    balancePaise: {
      type: Number,
      required: true,
      default: 0,
      // A wallet may never go negative. The atomic debit guard makes this unreachable; the
      // schema check means a bug that bypassed it would fail loudly rather than silently.
      min: 0,
      validate: { validator: Number.isInteger, message: 'Balance must be whole paise.' },
    },

    status: { type: String, enum: WALLET_STATUSES, required: true, default: 'active', index: true },
  },
  { timestamps: true },
);

export const Wallet = model<IWallet, WalletModel>('Wallet', walletSchema);
export type WalletDocument = HydratedDocument<IWallet>;

export interface PublicWallet {
  id: string;
  userId: string;
  balancePaise: number;
  /** Display only. Never calculate with this. */
  balanceRupees: number;
  status: WalletStatus;
  createdAt: string;
  updatedAt: string;
}

export function toPublicWallet(wallet: WalletDocument): PublicWallet {
  return {
    id: String(wallet._id),
    userId: String(wallet.userId),
    balancePaise: wallet.balancePaise,
    balanceRupees: paiseToRupees(wallet.balancePaise),
    status: wallet.status,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}
