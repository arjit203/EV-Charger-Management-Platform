/**
 * Payment business logic — recharge, verification, webhooks, and session settlement.
 *
 * TWO FLOWS, ONE IDEMPOTENCY PHILOSOPHY:
 *
 *   recharge   external money in, via Razorpay. Deduped on `providerPaymentId`
 *   settlement internal money out, for a completed charge. Deduped on `chargingSessionId`
 *
 * Both guarantees are DATABASE UNIQUE INDEXES, not application checks — the same reasoning as
 * Module 7's one-session-per-connector and Module 9's one-active-tariff. A check that reads
 * "has this been processed?" and then writes is check-then-act, and retries and webhooks are
 * exactly the traffic that races it.
 */

import mongoose, { Types } from 'mongoose';

import { ChargingSession } from '../models/chargingSession.model';
import {
  PaymentTransaction,
  toPublicPaymentTransaction,
  type PublicPaymentTransaction,
} from '../models/paymentTransaction.model';
import {
  MAX_RECHARGE_PAISE,
  MIN_RECHARGE_PAISE,
  SETTLEMENT_SWEEP_INTERVAL_MS,
} from '../constants/wallet';
import { ROLES } from '../constants/roles';
import { ApiError } from '../utils/ApiError';
import { applyCompanyScope } from '../utils/companyScope';
import { applyOwnerScope } from '../utils/ownerScope';
import { logger } from '../utils/logger';
import { formatPaise } from '../utils/money';
import * as provider from '../payments/razorpay';
import { applyMovement, getOrCreateWallet } from './wallet.service';
import type { Paginated } from '../types/pagination';
import type { AuthUser } from '../types/express';

const SCOPE = 'payments';
const DUPLICATE_KEY = 11000;

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(error) && (error as { code?: number }).code === DUPLICATE_KEY;
}

/* -------------------------------------------------------------------------- */
/* Recharge — step 1: create an order                                         */
/* -------------------------------------------------------------------------- */

export interface RechargeOrder {
  paymentId: string;
  providerOrderId: string;
  amountPaise: number;
  /** The PUBLIC Razorpay key. The secret never leaves this process. */
  keyId: string;
  mode: 'razorpay' | 'stub';
}

export async function createRechargeOrder(
  actor: AuthUser,
  amountPaise: number,
): Promise<RechargeOrder> {
  if (amountPaise < MIN_RECHARGE_PAISE || amountPaise > MAX_RECHARGE_PAISE) {
    throw ApiError.validation(
      `Recharge must be between ${formatPaise(MIN_RECHARGE_PAISE)} and ${formatPaise(MAX_RECHARGE_PAISE)}.`,
    );
  }

  const wallet = await getOrCreateWallet(actor.id);

  if (wallet.status !== 'active') {
    throw ApiError.forbidden('This wallet is blocked. Contact support.');
  }

  // The PaymentTransaction is written FIRST, before we ask the provider for anything, so a
  // successful order can never exist without a local record of it. An order we never hear about
  // again simply stays `pending` — which is the truth.
  const [payment] = await PaymentTransaction.create([
    {
      userId: new Types.ObjectId(actor.id),
      walletId: wallet._id,
      purpose: 'wallet_recharge',
      provider: 'razorpay',
      amountPaise,
      status: 'pending',
    },
  ]);

  let order;
  try {
    order = await provider.createOrder(amountPaise, `rcpt_${String(payment._id)}`);
  } catch (error) {
    // A provider outage must not take the platform down, and must not leave a record implying
    // an order exists when it does not.
    payment.status = 'failed';
    payment.failureReason = 'Could not reach the payment provider.';
    await payment.save();

    logger.error(SCOPE, 'Razorpay order creation failed', error);
    throw new ApiError(502, 'The payment provider is unavailable. Please try again.', 'PROVIDER_UNAVAILABLE');
  }

  payment.providerOrderId = order.orderId;
  await payment.save();

  return {
    paymentId: String(payment._id),
    providerOrderId: order.orderId,
    amountPaise,
    keyId: order.keyId,
    mode: provider.providerMode(),
  };
}

/* -------------------------------------------------------------------------- */
/* Recharge — step 2: verify and credit                                       */
/* -------------------------------------------------------------------------- */

export interface VerifyInput {
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
}

/**
 * Verify a completed payment and credit the wallet.
 *
 * THE BROWSER SAYING "IT WORKED" IS NOT EVIDENCE. Anyone can POST this request — the page is
 * under the user's control, and a forged one would be free money. What makes it trustworthy is
 * the signature: an HMAC over `orderId|paymentId` using a secret only this server and Razorpay
 * hold.
 *
 * IDEMPOTENCY. The unique partial index on `providerPaymentId` is the guarantee. If this
 * payment has already been credited we return the existing record untouched. Two callers racing
 * — the browser's verify and Razorpay's webhook — both hit that constraint, and the loser reads
 * the winner's row instead of crediting a second time.
 */
export async function verifyAndCredit(
  input: VerifyInput,
  actorId?: string,
): Promise<{ payment: PublicPaymentTransaction; alreadyProcessed: boolean }> {
  if (!provider.verifyPaymentSignature(input.providerOrderId, input.providerPaymentId, input.signature)) {
    logger.warn(SCOPE, `Signature rejected for order ${input.providerOrderId}`);
    throw ApiError.badRequest('Payment verification failed.');
  }

  const payment = await PaymentTransaction.findOne({ providerOrderId: input.providerOrderId });
  if (!payment) throw ApiError.notFound('Payment record not found.');

  // Ownership: a driver may only verify their own payment. Absent for webhooks, which are
  // authenticated by signature rather than by a user.
  if (actorId && String(payment.userId) !== actorId) {
    throw ApiError.notFound('Payment record not found.');
  }

  // Already credited — the common duplicate case, answered without touching the wallet.
  if (payment.status === 'paid') {
    return { payment: toPublicPaymentTransaction(payment), alreadyProcessed: true };
  }

  if (payment.status !== 'pending') {
    throw ApiError.conflict(`This payment is already ${payment.status}.`);
  }

  let claimedByUs = false;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      /*
       * CLAIM THE PAYMENT ATOMICALLY. The guard lives in the FILTER, not in an `if` above.
       *
       * This is the fix for a real double-credit bug the concurrency test caught. The earlier
       * version read `payment.status === 'pending'` and then wrote — so four concurrent verifies
       * of one payment ALL read `pending`, all proceeded, and all credited. Classic
       * check-then-act, the same shape as the wallet-balance race in `wallet.service.ts`.
       *
       * Note why the unique index on `providerPaymentId` did NOT catch it: that index stops two
       * DIFFERENT PaymentTransactions claiming one Razorpay payment. Here all four callers were
       * updating the SAME row, so there was never a second document to collide with. The index
       * is still necessary — it guards a different race — but it was never sufficient on its own.
       *
       * With the status in the filter, exactly one of N concurrent callers can match `pending`.
       * The rest match nothing, `claimed` is null, and they report "already processed" instead
       * of moving money a second time.
       */
      const claimed = await PaymentTransaction.findOneAndUpdate(
        { _id: payment._id, status: 'pending' },
        {
          $set: {
            status: 'paid',
            providerPaymentId: input.providerPaymentId,
            paidAt: new Date(),
          },
        },
        { returnDocument: 'after', session },
      );

      // Someone else won the claim. Leave their credit alone.
      if (!claimed) return;

      claimedByUs = true;

      const movement = await applyMovement(
        {
          walletId: payment.walletId,
          userId: payment.userId,
          amountPaise: payment.amountPaise,
          type: 'recharge',
          description: `Wallet recharge of ${formatPaise(payment.amountPaise)}`,
          paymentTransactionId: payment._id,
        },
        'credit',
        session,
      );

      // Rolls back the claim too, so the payment returns to `pending` and can be retried.
      if (!movement) throw ApiError.conflict('This wallet cannot be credited.');
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      // A different PaymentTransaction already owns this provider payment id.
      const existing = await PaymentTransaction.findOne({
        providerPaymentId: input.providerPaymentId,
      });
      if (existing) {
        return { payment: toPublicPaymentTransaction(existing), alreadyProcessed: true };
      }
    }
    throw error;
  } finally {
    await session.endSession();
  }

  const settled = await PaymentTransaction.findById(payment._id);
  if (!settled) throw ApiError.notFound('Payment record not found.');

  if (!claimedByUs) {
    return { payment: toPublicPaymentTransaction(settled), alreadyProcessed: true };
  }

  logger.info(SCOPE, `Credited ${formatPaise(settled.amountPaise)} to wallet ${String(settled.walletId)}`);

  // A top-up is the moment an unpayable debt may have become payable. Fire-and-forget: the
  // recharge already succeeded and must not be failed by a settlement problem.
  void settleOutstandingForUser(String(settled.userId)).catch((error: unknown) =>
    logger.error(SCOPE, 'Post-recharge settlement failed', error),
  );

  return { payment: toPublicPaymentTransaction(settled), alreadyProcessed: false };
}

/* -------------------------------------------------------------------------- */
/* Webhook                                                                    */
/* -------------------------------------------------------------------------- */

export interface WebhookResult {
  handled: boolean;
  reason: string;
}

/**
 * Process a Razorpay webhook.
 *
 * NEVER returns a 4xx for a duplicate. Razorpay retries anything that is not a 2xx, so telling
 * it a duplicate "failed" produces more duplicates — the opposite of what you want. A repeat is
 * acknowledged with 200 and a reason.
 *
 * The signature is over the RAW BYTES, which is why `app.ts` captures `req.rawBody` before
 * `express.json` parses and discards them.
 */
export async function handleWebhook(rawBody: Buffer, signature: string): Promise<WebhookResult> {
  if (!provider.verifyWebhookSignature(rawBody, signature)) {
    logger.warn(SCOPE, 'Webhook rejected: bad signature');
    throw ApiError.badRequest('Invalid webhook signature.');
  }

  let event: {
    event?: string;
    payload?: { payment?: { entity?: { id?: string; order_id?: string } } };
  };

  try {
    event = JSON.parse(rawBody.toString('utf8')) as typeof event;
  } catch {
    throw ApiError.badRequest('Malformed webhook payload.');
  }

  const entity = event.payload?.payment?.entity;

  if (event.event !== 'payment.captured' || !entity?.id || !entity.order_id) {
    // Every other event type is acknowledged and ignored. Subscribing to more than we handle is
    // normal; erroring on them would just generate retries.
    return { handled: false, reason: `Ignored event: ${event.event ?? 'unknown'}` };
  }

  const payment = await PaymentTransaction.findOne({ providerOrderId: entity.order_id });
  if (!payment) return { handled: false, reason: 'No matching payment record' };
  if (payment.status === 'paid') return { handled: false, reason: 'Already processed' };

  /*
   * The webhook carries no client signature, so we mint the one our own verifier expects and
   * take the SAME path as a browser-initiated verify. One code path, one set of guarantees —
   * rather than a second crediting routine that could drift from the first.
   */
  const signatureForVerify = provider.signPayload(`${entity.order_id}|${entity.id}`);

  const result = await verifyAndCredit({
    providerOrderId: entity.order_id,
    providerPaymentId: entity.id,
    signature: signatureForVerify,
  });

  return {
    handled: !result.alreadyProcessed,
    reason: result.alreadyProcessed ? 'Already processed' : 'Credited',
  };
}

/* -------------------------------------------------------------------------- */
/* Session settlement                                                         */
/* -------------------------------------------------------------------------- */

export interface SettlementResult {
  status: 'paid' | 'pending' | 'skipped';
  reason?: string;
}

/**
 * Collect for one completed charging session.
 *
 * CALLED FROM TWO PLACES, and safe because of that: inline right after a session completes (the
 * fast path a driver sees), and from the sweeper below (the safety net, and the retry after a
 * top-up). The unique index on `chargingSessionId` means a race between them is harmless, which
 * is exactly what lets the inline call be best-effort rather than load-bearing.
 *
 * INSUFFICIENT FUNDS IS NOT A FAILURE. The electricity was delivered and cannot be un-delivered.
 * The session stays `unpaid`, the payment stays `pending`, and the next top-up settles it. The
 * one thing this must never do is pretend the money arrived.
 */
export async function settleSession(sessionId: string): Promise<SettlementResult> {
  const charging = await ChargingSession.findById(sessionId);
  if (!charging) return { status: 'skipped', reason: 'Session not found' };

  if (charging.paymentStatus === 'paid') return { status: 'skipped', reason: 'Already paid' };
  if (charging.amountPaise === null) return { status: 'skipped', reason: 'Not priced yet' };
  if (charging.amountPaise === 0) return { status: 'skipped', reason: 'Nothing to collect' };

  const wallet = await getOrCreateWallet(String(charging.userId));

  // One live payment row per session, reused across retries. Creating a new row on every failed
  // attempt would fill the table with noise — the sweeper runs every 15 seconds.
  let payment = await PaymentTransaction.findOne({
    chargingSessionId: charging._id,
    status: { $in: ['pending', 'paid'] },
  });

  if (!payment) {
    try {
      [payment] = await PaymentTransaction.create([
        {
          userId: charging.userId,
          walletId: wallet._id,
          purpose: 'session_debit',
          // Never touches Razorpay — this is money moving inside the platform.
          provider: 'internal',
          chargingSessionId: charging._id,
          companyId: charging.companyId,
          amountPaise: charging.amountPaise,
          status: 'pending',
        },
      ]);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        // The other caller won the race and created it. Let them settle it.
        return { status: 'skipped', reason: 'Settlement already in progress' };
      }
      throw error;
    }
  }

  if (payment.status === 'paid') return { status: 'skipped', reason: 'Already paid' };

  const amountPaise = charging.amountPaise;
  let outcome: SettlementResult = { status: 'pending' };

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const movement = await applyMovement(
        {
          walletId: wallet._id,
          userId: charging.userId,
          amountPaise,
          type: 'session_debit',
          description: `Charging session — ${formatPaise(amountPaise)}`,
          paymentTransactionId: payment!._id,
          chargingSessionId: charging._id,
        },
        'debit',
        session,
      );

      if (!movement) {
        /*
         * The atomic guard refused: the wallet is short, or blocked. Record why and leave
         * everything else alone. Aborting here would roll back the attempt counter too, so the
         * bookkeeping is written outside the transaction, below.
         */
        outcome = { status: 'pending', reason: 'Insufficient balance' };
        throw new SettlementDeferred();
      }

      /*
       * Claim atomically, for the same reason as the recharge path above: two settlement
       * attempts for one session (the inline one and the sweeper, say) would otherwise both
       * read `pending` and both debit. The status guard in the filter means only one can.
       */
      const claimed = await PaymentTransaction.findOneAndUpdate(
        { _id: payment!._id, status: 'pending' },
        { $set: { status: 'paid', paidAt: new Date(), failureReason: null } },
        { returnDocument: 'after', session },
      );

      if (!claimed) {
        // Another attempt settled it while we were inside this transaction. Roll back OUR debit
        // so the money moves exactly once.
        outcome = { status: 'skipped', reason: 'Settled by a concurrent attempt' };
        throw new SettlementDeferred();
      }

      // The session's paymentStatus is a DENORMALISED projection of the payment record. It is
      // written in the same transaction, so the two cannot drift.
      charging.paymentStatus = 'paid';
      await charging.save({ session });

      outcome = { status: 'paid' };
    });
  } catch (error) {
    if (!(error instanceof SettlementDeferred)) throw error;
  } finally {
    await session.endSession();
  }

  if (outcome.status === 'pending') {
    payment.attempts += 1;
    payment.failureReason = `Insufficient balance for ${formatPaise(amountPaise)}`;
    await payment.save();

    logger.warn(
      SCOPE,
      `Session ${sessionId} unpaid: wallet short of ${formatPaise(amountPaise)} (attempt ${payment.attempts})`,
    );
  } else if (outcome.status === 'paid') {
    logger.info(SCOPE, `Session ${sessionId} settled: ${formatPaise(amountPaise)}`);
  }
  // 'skipped' means a concurrent attempt won the claim and our debit was rolled back. Nothing
  // to record — the other attempt logs the settlement.

  return outcome;
}

/** Signals "leave it pending" without rolling back the attempt bookkeeping. */
class SettlementDeferred extends Error {}

/** Settle everything this driver still owes. Called after a top-up. */
export async function settleOutstandingForUser(userId: string): Promise<number> {
  const unpaid = await ChargingSession.find({
    userId: new Types.ObjectId(userId),
    paymentStatus: 'unpaid',
    amountPaise: { $gt: 0 },
  })
    .sort({ endedAt: 1 })
    .select('_id');

  let settled = 0;
  for (const charging of unpaid) {
    const result = await settleSession(String(charging._id));
    if (result.status === 'paid') settled += 1;
    // Stop at the first shortfall: sessions are settled oldest-first, and if the wallet cannot
    // cover this one it cannot cover the next either.
    else if (result.status === 'pending') break;
  }

  return settled;
}

/* -------------------------------------------------------------------------- */
/* Settlement sweeper                                                         */
/* -------------------------------------------------------------------------- */

let sweepTimer: NodeJS.Timeout | null = null;

/**
 * The safety net.
 *
 * Catches sessions the inline attempt missed — a session that ended through the disconnect
 * handler, a crash between pricing and settling, a process restart. Same shape as Module 7's
 * session sweeper, so this is a proven pattern rather than new machinery.
 *
 * It also retries, which is what turns "insufficient balance" from a dead end into a state that
 * resolves itself.
 */
export function startSettlementSweeper(): void {
  if (sweepTimer) return;

  sweepTimer = setInterval(() => {
    void sweepUnsettledSessions().catch((error: unknown) =>
      logger.error(SCOPE, 'Settlement sweep failed', error),
    );
  }, SETTLEMENT_SWEEP_INTERVAL_MS);

  sweepTimer.unref();
}

export function stopSettlementSweeper(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}

export async function sweepUnsettledSessions(limit = 25): Promise<number> {
  const unpaid = await ChargingSession.find({
    paymentStatus: 'unpaid',
    amountPaise: { $gt: 0 },
  })
    .sort({ endedAt: 1 })
    .limit(limit)
    .select('_id');

  let settled = 0;
  for (const charging of unpaid) {
    const result = await settleSession(String(charging._id));
    if (result.status === 'paid') settled += 1;
  }

  return settled;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Payment records, scoped by role.
 *
 * The same dual-scope shape as Module 7's sessions, and for the same reason: a payment has two
 * legitimate audiences. The driver who paid, and the company whose station was paid for.
 */
function applyPaymentScope(actor: AuthUser, filter: Record<string, unknown>) {
  if (actor.role === ROLES.DRIVER) return applyOwnerScope(actor, filter);
  return applyCompanyScope(actor, filter);
}

export async function listPayments(
  actor: AuthUser,
  page = 1,
  limit = 20,
): Promise<Paginated<PublicPaymentTransaction>> {
  const scoped = applyPaymentScope(actor, {});

  const [items, total] = await Promise.all([
    PaymentTransaction.find(scoped).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    PaymentTransaction.countDocuments(scoped),
  ]);

  return {
    items: items.map(toPublicPaymentTransaction),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

export async function getPaymentById(
  actor: AuthUser,
  paymentId: string,
): Promise<PublicPaymentTransaction> {
  const payment = await PaymentTransaction.findOne(applyPaymentScope(actor, { _id: paymentId }));

  if (!payment) {
    // 403 for company-scoped callers even on ids that do not exist, so ids cannot be probed.
    throw actor.role === ROLES.SUPER_ADMIN || actor.role === ROLES.DRIVER
      ? ApiError.notFound('Payment not found.')
      : ApiError.forbidden('You can only access payments for your own company.');
  }

  return toPublicPaymentTransaction(payment);
}

/* -------------------------------------------------------------------------- */
/* Refund — recharge reversal only                                            */
/* -------------------------------------------------------------------------- */

/**
 * Reverse a completed recharge.
 *
 * DELIBERATELY NARROW. Session-debit refunds are not implemented because nothing asks for them
 * — a driver who was correctly billed for electricity they received has nothing to refund, and
 * a disputed charge is Module 11's problem, not a silent reversal here.
 *
 * Idempotent through the status check: a payment already `refunded` is rejected rather than
 * reversed twice.
 */
export async function refundRecharge(
  actor: AuthUser,
  paymentId: string,
): Promise<PublicPaymentTransaction> {
  if (actor.role !== ROLES.SUPER_ADMIN) {
    throw ApiError.forbidden('Only a platform administrator can reverse a recharge.');
  }

  const payment = await PaymentTransaction.findById(paymentId);
  if (!payment) throw ApiError.notFound('Payment not found.');

  if (payment.purpose !== 'wallet_recharge') {
    throw ApiError.conflict('Only a wallet recharge can be reversed.');
  }
  if (payment.status === 'refunded') throw ApiError.conflict('This payment is already refunded.');
  if (payment.status !== 'paid') throw ApiError.conflict(`Cannot refund a ${payment.status} payment.`);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const movement = await applyMovement(
        {
          walletId: payment.walletId,
          userId: payment.userId,
          amountPaise: payment.amountPaise,
          type: 'refund',
          description: `Reversal of recharge ${formatPaise(payment.amountPaise)}`,
          paymentTransactionId: payment._id,
        },
        'debit',
        session,
      );

      // The driver has already spent it. Refusing beats letting a balance go negative.
      if (!movement) {
        throw ApiError.conflict('This balance has already been spent and cannot be reversed.');
      }

      payment.status = 'refunded';
      await payment.save({ session });
    });
  } finally {
    await session.endSession();
  }

  const updated = await PaymentTransaction.findById(paymentId);
  if (!updated) throw ApiError.notFound('Payment not found.');

  logger.info(SCOPE, `Recharge ${paymentId} reversed`);

  return toPublicPaymentTransaction(updated);
}

/** Surfaced so the wallet page can tell a driver what they still owe. */
export async function getOutstandingTotal(userId: string): Promise<number> {
  const unpaid = await ChargingSession.find({
    userId: new Types.ObjectId(userId),
    paymentStatus: 'unpaid',
    amountPaise: { $gt: 0 },
  }).select('amountPaise');

  return unpaid.reduce((sum, s) => sum + (s.amountPaise ?? 0), 0);
}

/** Exposed for the health endpoint — an operator should see if payments are stubbed. */
export function paymentsMode(): string {
  return provider.providerMode();
}
