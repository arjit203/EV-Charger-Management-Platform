/**
 * One-time migration — give existing pending session debits a retry schedule.
 *
 *   npm run fix:settlement-backoff                 report only, changes nothing
 *   npm run fix:settlement-backoff -- --apply      write nextAttemptAt
 *   npm run fix:settlement-backoff -- --apply --reset-attempts
 *
 * WHY THIS EXISTS. `nextAttemptAt` was added to PaymentTransaction to stop the settlement
 * sweeper retrying an insufficient-balance session every 15 seconds forever. Rows written
 * before the field existed have it as `null`, and `null` means "never attempted, take it now" —
 * so without this backfill the whole historical backlog stays permanently due and the sweeper
 * behaves exactly as it did before the fix.
 *
 * ON `--reset-attempts`. The counter is real history: these sessions genuinely were attempted
 * thousands of times. That is worth keeping, and it is also USEFUL — a high count feeds
 * straight into the backoff, so an old stuck payment goes to the 6-hour ceiling immediately
 * instead of climbing there from 30 seconds. Only pass the flag if the counts are pure noise
 * from a development loop and you would rather read a clean number.
 */

import { connectDatabase, disconnectDatabase } from '../config/db';
import { PaymentTransaction } from '../models/paymentTransaction.model';
import {
  SETTLEMENT_RETRY_BASE_MS,
  SETTLEMENT_RETRY_MAX_MS,
} from '../constants/wallet';
import { logger } from '../utils/logger';

const SCOPE = 'fix:settlement-backoff';

const apply = process.argv.includes('--apply');
const resetAttempts = process.argv.includes('--reset-attempts');

/** Mirrors payment.service's schedule. Kept local so the migration cannot drift mid-run. */
function retryDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  if (exponent > 40) return SETTLEMENT_RETRY_MAX_MS;
  return Math.min(SETTLEMENT_RETRY_BASE_MS * 2 ** exponent, SETTLEMENT_RETRY_MAX_MS);
}

async function main(): Promise<void> {
  await connectDatabase();

  const stale = await PaymentTransaction.find({
    purpose: 'session_debit',
    status: 'pending',
    nextAttemptAt: null,
  }).select('_id attempts');

  if (stale.length === 0) {
    logger.info(SCOPE, 'Nothing to backfill — every pending session debit already has a schedule.');
    await disconnectDatabase();
    return;
  }

  const totalAttempts = stale.reduce((sum, p) => sum + p.attempts, 0);
  const maxAttempts = stale.reduce((max, p) => Math.max(max, p.attempts), 0);

  logger.info(SCOPE, `Pending session debits without a schedule : ${stale.length}`);
  logger.info(SCOPE, `Attempts recorded across them             : ${totalAttempts}`);
  logger.info(SCOPE, `Worst single payment                      : ${maxAttempts} attempts`);

  if (!apply) {
    logger.warn(SCOPE, 'Dry run. Re-run with --apply to write.');
    await disconnectDatabase();
    return;
  }

  /*
   * Spread the first retry across the window rather than making all of them due at the same
   * instant. Without the stagger the very first sweep after a restart would find the entire
   * backlog due at once, which is the thundering herd this fix is meant to prevent.
   */
  const now = Date.now();
  let updated = 0;

  for (const [index, payment] of stale.entries()) {
    const attempts = resetAttempts ? 0 : payment.attempts;
    const stagger = index * 1_000;
    const delay = retryDelayMs(Math.max(attempts, 1)) + stagger;

    await PaymentTransaction.updateOne(
      { _id: payment._id },
      { $set: { nextAttemptAt: new Date(now + delay), ...(resetAttempts ? { attempts: 0 } : {}) } },
    );
    updated += 1;
  }

  logger.info(SCOPE, `Scheduled ${updated} payment(s).`);
  if (resetAttempts) logger.info(SCOPE, 'Attempt counters reset to 0.');

  await disconnectDatabase();
}

main().catch((error: unknown) => {
  logger.error(SCOPE, 'Backfill failed', error);
  process.exit(1);
});
