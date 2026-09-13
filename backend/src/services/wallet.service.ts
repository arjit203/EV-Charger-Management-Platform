/**
 * Wallet business logic.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE: a balance is never written, only moved — and every
 * movement writes a ledger row in the same transaction.
 *
 * There is no function here that takes a balance as an argument. Not for a driver, not for an
 * admin. The only inputs are "credit this much because a payment was verified" and "debit this
 * much for this session".
 */

import mongoose, { Types } from 'mongoose';

import { Wallet, toPublicWallet, type PublicWallet, type WalletDocument } from '../models/wallet.model';
import {
  WalletTransaction,
  toPublicWalletTransaction,
  type PublicWalletTransaction,
} from '../models/walletTransaction.model';
import type { LedgerDirection, WalletTransactionType } from '../constants/wallet';
import { ApiError } from '../utils/ApiError';
import { applyOwnerScope } from '../utils/ownerScope';
import type { Paginated } from '../types/pagination';
import type { AuthUser } from '../types/express';

/**
 * The caller's wallet, created on first access.
 *
 * LAZY, and atomic. `upsert` means two simultaneous first requests cannot produce two wallets —
 * the second matches the row the first just created. Creating it at registration instead would
 * mean touching Module 1's signup flow for no benefit.
 */
export async function getOrCreateWallet(userId: string): Promise<WalletDocument> {
  const wallet = await Wallet.findOneAndUpdate(
    { userId: new Types.ObjectId(userId) },
    { $setOnInsert: { balancePaise: 0, status: 'active' } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );

  // Unreachable with upsert, but the type is nullable and failing loudly beats a cast.
  if (!wallet) throw ApiError.internal('Wallet could not be created.');

  return wallet;
}

export async function getMyWallet(actor: AuthUser): Promise<PublicWallet> {
  return toPublicWallet(await getOrCreateWallet(actor.id));
}

/**
 * The caller's ledger.
 *
 * Owner-scoped with no super_admin bypass — Module 3's rule. A driver's transaction history is
 * personal data, and an admin who needs it uses an admin path, not a widened self-service query.
 */
export async function listMyTransactions(
  actor: AuthUser,
  page = 1,
  limit = 20,
): Promise<Paginated<PublicWalletTransaction>> {
  const filter = applyOwnerScope(actor, {});

  const [items, total] = await Promise.all([
    WalletTransaction.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    WalletTransaction.countDocuments(filter),
  ]);

  return {
    items: items.map(toPublicWalletTransaction),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

/* -------------------------------------------------------------------------- */
/* Movement primitives                                                        */
/* -------------------------------------------------------------------------- */

export interface MovementInput {
  walletId: Types.ObjectId;
  userId: Types.ObjectId;
  amountPaise: number;
  type: WalletTransactionType;
  description: string;
  paymentTransactionId?: Types.ObjectId | null;
  chargingSessionId?: Types.ObjectId | null;
}

/**
 * ATOMIC DEBIT — the balance check lives INSIDE the filter.
 *
 * This is the whole defence against double spending, and it is worth understanding exactly why
 * it works. The naive version is:
 *
 *     const wallet = await Wallet.findById(id);          // reads 10000
 *     if (wallet.balancePaise < amount) throw ...;        // passes
 *     wallet.balancePaise -= amount; await wallet.save(); // writes 4000
 *
 * Two requests both read 10000, both pass the check, both write 4000 — and ₹120 of electricity
 * was sold for ₹60. Check-then-act, exactly like the connector race in Module 7.
 *
 * Here the check and the decrement are ONE operation. MongoDB guarantees single-document
 * atomicity, so the second request either matches (and the balance was genuinely sufficient at
 * that instant) or matches nothing and returns null. A wallet cannot go negative by
 * construction.
 *
 * NOTE WHAT THIS IS NOT: a transaction. A balance guard is a single-document concern, and
 * wrapping it in a transaction would be reaching for machinery the problem does not need. The
 * transaction in `applyMovement` below exists for a different reason entirely — keeping three
 * SEPARATE documents consistent.
 *
 * Returns null when the wallet is missing, blocked, or short.
 */
async function atomicDebit(
  walletId: Types.ObjectId,
  amountPaise: number,
  session: mongoose.ClientSession,
): Promise<WalletDocument | null> {
  return Wallet.findOneAndUpdate(
    { _id: walletId, status: 'active', balancePaise: { $gte: amountPaise } },
    { $inc: { balancePaise: -amountPaise } },
    { returnDocument: 'after', session },
  );
}

/** The credit mirror. No guard is needed — a credit cannot fail on insufficiency. */
async function atomicCredit(
  walletId: Types.ObjectId,
  amountPaise: number,
  session: mongoose.ClientSession,
): Promise<WalletDocument | null> {
  return Wallet.findOneAndUpdate(
    { _id: walletId, status: 'active' },
    { $inc: { balancePaise: amountPaise } },
    { returnDocument: 'after', session },
  );
}

export interface MovementResult {
  balanceBeforePaise: number;
  balanceAfterPaise: number;
  ledgerId: Types.ObjectId;
}

/**
 * Move money and write the ledger row, as one indivisible act.
 *
 * MUST be called inside a caller-supplied transaction. The caller has more to do than this —
 * updating a PaymentTransaction, updating a ChargingSession — and all of it has to commit
 * together. Taking the session as a parameter rather than opening one here is what makes that
 * possible.
 *
 * The state this makes unreachable: "wallet debited, ledger not written". Not by careful
 * ordering, but because a partial commit cannot exist.
 */
export async function applyMovement(
  input: MovementInput,
  direction: LedgerDirection,
  session: mongoose.ClientSession,
): Promise<MovementResult | null> {
  const updated =
    direction === 'debit'
      ? await atomicDebit(input.walletId, input.amountPaise, session)
      : await atomicCredit(input.walletId, input.amountPaise, session);

  if (!updated) return null;

  const balanceAfterPaise = updated.balancePaise;
  const balanceBeforePaise =
    direction === 'debit'
      ? balanceAfterPaise + input.amountPaise
      : balanceAfterPaise - input.amountPaise;

  const [ledger] = await WalletTransaction.create(
    [
      {
        walletId: input.walletId,
        userId: input.userId,
        type: input.type,
        direction,
        amountPaise: input.amountPaise,
        balanceBeforePaise,
        balanceAfterPaise,
        paymentTransactionId: input.paymentTransactionId ?? null,
        chargingSessionId: input.chargingSessionId ?? null,
        description: input.description,
      },
    ],
    { session },
  );

  return { balanceBeforePaise, balanceAfterPaise, ledgerId: ledger._id };
}

/**
 * Sum the ledger and compare it to the stored balance.
 *
 * Not used by any endpoint — it exists so a test can assert the two agree, which is the whole
 * point of keeping `balanceBefore`/`balanceAfter` on every row. A ledger you never reconcile is
 * just a log.
 */
export async function reconcile(walletId: Types.ObjectId): Promise<{
  ledgerBalancePaise: number;
  storedBalancePaise: number;
  matches: boolean;
}> {
  const [wallet, entries] = await Promise.all([
    Wallet.findById(walletId),
    WalletTransaction.find({ walletId }).sort({ createdAt: 1 }),
  ]);

  const ledgerBalancePaise = entries.reduce(
    (sum, entry) => sum + (entry.direction === 'credit' ? entry.amountPaise : -entry.amountPaise),
    0,
  );

  const storedBalancePaise = wallet?.balancePaise ?? 0;

  return {
    ledgerBalancePaise,
    storedBalancePaise,
    matches: ledgerBalancePaise === storedBalancePaise,
  };
}
