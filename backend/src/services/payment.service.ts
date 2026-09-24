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
  ARREARS_GRACE_MS,
  ARREARS_MAX_OUTSTANDING_PAISE,
  ARREARS_MAX_UNPAID_SESSIONS,
  SETTLEMENT_LOUD_ATTEMPTS,
  SETTLEMENT_RETRY_BASE_MS,
  SETTLEMENT_RETRY_MAX_MS,
  SETTLEMENT_SWEEP_BATCH,
  SETTLEMENT_SWEEP_INTERVAL_MS,
  type PaymentPurpose,
  type PaymentStatus,
} from '../constants/wallet';
import { ROLES } from '../constants/roles';
import { ApiError } from '../utils/ApiError';
import { applyCompanyScope } from '../utils/companyScope';
import { applyOwnerScope } from '../utils/ownerScope';
import { logger } from '../utils/logger';
import { describeSession, describeUser, sessionRef } from '../utils/logLabels';
import { formatPaise } from '../utils/money';
import * as provider from '../payments/razorpay';
import { applyMovement, getOrCreateWallet } from './wallet.service';
import * as notify from './notification.service';
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

    logger.error(SCOPE, "Couldn't create a Razorpay order for a wallet top-up — Razorpay may be down", error);
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
    logger.warn(
      SCOPE,
      `Rejected a top-up confirmation for Razorpay order ${input.providerOrderId}: the signature didn't match, so it may be forged`,
    );
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

  logger.info(
    SCOPE,
    `Wallet top-up: added ${formatPaise(settled.amountPaise)} to ${await describeUser(settled.userId)}'s wallet`,
  );

  // A top-up is the moment an unpayable debt may have become payable. Fire-and-forget: the
  // recharge already succeeded and must not be failed by a settlement problem.
  void notify.walletRecharged(settled.userId, settled._id, settled.amountPaise);

  void settleOutstandingForUser(String(settled.userId)).catch((error: unknown) =>
    logger.error(
      SCOPE,
      "After a top-up, couldn't collect the driver's unpaid sessions — the retry job will try again",
      error,
    ),
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
    logger.warn(SCOPE, 'Rejected a Razorpay webhook: the signature was wrong, so it did not come from Razorpay');
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
        { $set: { status: 'paid', paidAt: new Date(), failureReason: null, nextAttemptAt: null } },
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
    payment.nextAttemptAt = new Date(Date.now() + retryDelayMs(payment.attempts));
    payment.failureReason = `Insufficient balance for ${formatPaise(amountPaise)}`;
    await payment.save();

    /*
     * LOUD ONCE, THEN SILENT. A short wallet is an expected state of the world, not an
     * incident. The first few attempts warn, because a session that will not collect is worth
     * an operator's attention the first time. After that this says nothing at all, and the
     * sweeper reports a single summary line for the whole batch instead.
     *
     * Per-session logging on every attempt is what produced thousands of identical lines and
     * buried a real bug underneath them. A log nobody can read is not observability.
     */
    if (payment.attempts <= SETTLEMENT_LOUD_ATTEMPTS) {
      logger.warn(
        SCOPE,
        `Payment pending for charging on ${await describeSession(charging)}: the wallet can't ` +
          `cover ${formatPaise(amountPaise)}. Will retry in ` +
          `${Math.round(retryDelayMs(payment.attempts) / 1000)}s (attempt ${payment.attempts}). ` +
          sessionRef(charging),
      );
    }

    /*
     * Told ONCE, not once per sweep. The settlement sweeper retries every 15 seconds for as long
     * as the balance is short, so the dedupe key `session:<id>:pending` is what stands between a
     * driver and four notifications a minute, indefinitely.
     */
    void notify.paymentPending(charging, amountPaise);
  } else if (outcome.status === 'paid') {
    logger.info(
      SCOPE,
      `Collected ${formatPaise(amountPaise)} from the driver's wallet for charging on ` +
        `${await describeSession(charging)} ${sessionRef(charging)}`,
    );
    void notify.paymentSucceeded(charging, amountPaise);
  }
  // 'skipped' means a concurrent attempt won the claim and our debit was rolled back. Nothing
  // to record — the other attempt logs the settlement.

  return outcome;
}

/** Signals "leave it pending" without rolling back the attempt bookkeeping. */
class SettlementDeferred extends Error {}

/**
 * Exponential backoff, capped.
 *
 * 30s, 1m, 2m, 4m ... up to a 6-hour ceiling. The cap matters more than the curve: without it
 * doubling would eventually push a retry years out, and a driver who tops up after a long gap
 * would sit uncollected. Six hours means a stuck session is still checked four times a day,
 * while the top-up path collects the instant money actually arrives.
 */
function retryDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  // Guard the shift itself: 2 ** 1024 is Infinity, and Infinity in a Date is an invalid date.
  if (exponent > 40) return SETTLEMENT_RETRY_MAX_MS;
  return Math.min(SETTLEMENT_RETRY_BASE_MS * 2 ** exponent, SETTLEMENT_RETRY_MAX_MS);
}

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
/* Arrears                                                                    */
/* -------------------------------------------------------------------------- */

export interface Arrears {
  outstandingPaise: number;
  unpaidSessions: number;
  /** True when this driver should be refused a NEW charge until they settle up. */
  blocked: boolean;
  /** Driver-facing explanation. Null when not blocked. */
  reason: string | null;
}

/**
 * How much does this driver owe, and is it enough to stop them charging again?
 *
 * READ-ONLY AND CHEAP, because it sits directly in the start path — a driver waiting at a
 * charger is waiting on this query. One indexed aggregation over their own unpaid sessions,
 * no wallet read: the wallet balance is irrelevant here. Whether they CAN pay is settlement's
 * question, asked after the charge. Whether they have NOT paid is this one, asked before it.
 *
 * Deliberately not a stored flag on the user. A denormalised `isBlocked` would need writing
 * from every settle, every top-up and every refund, and any missed write strands a paying
 * customer at a charger. Deriving it makes that class of bug impossible.
 */
export async function assessArrears(userId: string): Promise<Arrears> {
  /*
   * Only AGED debt counts. `endedAt` rather than `createdAt`, because the clock that matters
   * starts when the driver stopped charging and the bill became real — not when they plugged
   * in, which for a long charge could be hours earlier and would make a session count as
   * overdue before it was even billable.
   */
  const cutoff = new Date(Date.now() - ARREARS_GRACE_MS);

  const [summary] = await ChargingSession.aggregate<{ owed: number; count: number }>([
    {
      $match: {
        userId: new Types.ObjectId(userId),
        paymentStatus: 'unpaid',
        amountPaise: { $gt: 0 },
        endedAt: { $ne: null, $lt: cutoff },
      },
    },
    { $group: { _id: null, owed: { $sum: '$amountPaise' }, count: { $sum: 1 } } },
  ]);

  const outstandingPaise = summary?.owed ?? 0;
  const unpaidSessions = summary?.count ?? 0;

  const overAmount = outstandingPaise > ARREARS_MAX_OUTSTANDING_PAISE;
  const overCount = unpaidSessions > ARREARS_MAX_UNPAID_SESSIONS;

  /*
   * The message names the amount and the remedy. "Blocked" on its own at a charger, in the
   * rain, is the worst possible version of this feature: the driver cannot tell whether it is
   * their fault, and cannot tell what would fix it.
   */
  let reason: string | null = null;

  if (overAmount) {
    reason =
      `You have ${formatPaise(outstandingPaise)} in unpaid charging sessions. ` +
      'Top up your wallet to clear it and start charging again.';
  } else if (overCount) {
    reason =
      `You have ${unpaidSessions} unpaid charging sessions (${formatPaise(outstandingPaise)}). ` +
      'Top up your wallet to clear them and start charging again.';
  }

  return { outstandingPaise, unpaidSessions, blocked: overAmount || overCount, reason };
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
      logger.error(SCOPE, 'Background retry of unpaid charging sessions failed', error),
    );
  }, SETTLEMENT_SWEEP_INTERVAL_MS);

  sweepTimer.unref();
}

export function stopSettlementSweeper(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}

/**
 * One pass of the safety net.
 *
 * Two DISTINCT populations, and the old version only really served the first:
 *
 *   1. RETRIES     — a payment row exists and is still pending. Picked up only when its
 *                    backoff says it is due, soonest-due first.
 *   2. ORPHANS     — an unpaid session with no payment row at all. This is the case the
 *                    sweeper genuinely exists for: the process died between pricing the
 *                    session and collecting for it, so nobody has ever tried.
 *
 * The previous query was `unpaid sessions, oldest first, limit 25`, which conflated the two
 * and let population 1 starve population 2 — 25 permanently unpayable sessions from the top of
 * the queue filled every batch, so an orphan created later was never reached. Orphans are
 * therefore taken FIRST here, and they can never block anything, because attempting one always
 * creates a payment row and moves it into population 1.
 */
export async function sweepUnsettledSessions(limit = SETTLEMENT_SWEEP_BATCH): Promise<number> {
  const now = new Date();
  const sessionIds: string[] = [];

  /*
   * Sessions with no payment row. `$lookup` rather than a `$nin` over every pending payment,
   * so the query does not grow an unbounded argument list as the table fills.
   */
  const orphans = await ChargingSession.aggregate<{ _id: Types.ObjectId }>([
    { $match: { paymentStatus: 'unpaid', amountPaise: { $gt: 0 } } },
    {
      $lookup: {
        from: PaymentTransaction.collection.name,
        localField: '_id',
        foreignField: 'chargingSessionId',
        as: 'payments',
      },
    },
    { $match: { payments: { $eq: [] } } },
    { $sort: { endedAt: 1 } },
    { $limit: limit },
    { $project: { _id: 1 } },
  ]);

  for (const orphan of orphans) sessionIds.push(String(orphan._id));

  // Whatever budget the orphans left goes to retries that are actually due.
  const remaining = limit - sessionIds.length;

  if (remaining > 0) {
    const due = await PaymentTransaction.find({
      purpose: 'session_debit',
      status: 'pending',
      chargingSessionId: { $ne: null },
      $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
    })
      .sort({ nextAttemptAt: 1 })
      .limit(remaining)
      .select('chargingSessionId');

    for (const payment of due) {
      if (payment.chargingSessionId) sessionIds.push(String(payment.chargingSessionId));
    }
  }

  let settled = 0;
  for (const id of sessionIds) {
    const result = await settleSession(id);
    if (result.status === 'paid') settled += 1;
  }

  /*
   * ONE LINE PER SWEEP, and only when the sweep did something. A quiet system should produce a
   * quiet log: the overwhelmingly common case is "nothing was due", and saying so every 15
   * seconds is how a log stops being read at all.
   */
  if (sessionIds.length > 0) {
    logger.info(
      SCOPE,
      `Retried unpaid charging sessions: ${sessionIds.length} checked, ${settled} now paid, ` +
        `${sessionIds.length - settled} still waiting for the driver to top up`,
    );
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
  filters: { status?: PaymentStatus; purpose?: PaymentPurpose; companyId?: string } = {},
): Promise<Paginated<PublicPaymentTransaction>> {
  const filter: Record<string, unknown> = {};
  if (filters.status) filter.status = filters.status;
  if (filters.purpose) filter.purpose = filters.purpose;
  // super_admin only: a scoped caller's company is pinned by the scope and cannot be changed.
  if (filters.companyId && actor.role === ROLES.SUPER_ADMIN) {
    filter.companyId = new Types.ObjectId(filters.companyId);
  }

  const scoped = applyPaymentScope(actor, filter);

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

  logger.info(
    SCOPE,
    `Reversed a ${formatPaise(updated.amountPaise)} wallet top-up for ${await describeUser(updated.userId)} ` +
      `[payment ${paymentId}]`,
  );

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
