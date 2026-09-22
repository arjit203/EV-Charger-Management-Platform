/**
 * Demo repair — top up the drivers the seed script left in debt.
 *
 *   npm run fix:arrears              report only, changes nothing
 *   npm run fix:arrears -- --apply   credit each driver and collect
 *
 * WHY THIS IS NEEDED. `seed:activity` writes real priced sessions but does not guarantee the
 * driver can afford them, so a freshly seeded database contains drivers who owe more than
 * their wallet holds. That was harmless while nothing checked — the debt just sat there. Now
 * that an unpaid balance blocks a new charge, the same data locks most demo drivers out of
 * the product, and the demo dies at "start a session".
 *
 * WHAT IT DOES NOT DO: mark anything paid by hand.
 *
 * It credits the wallet and then calls the SAME `settleOutstandingForUser` a real top-up
 * calls. Every session that clears does so through the real debit, the real atomic balance
 * guard and the real ledger entry. Flipping `paymentStatus` to 'paid' directly would be one
 * line shorter and would leave the books describing money that never moved.
 *
 * ON REVENUE FIGURES. Crediting a wallet writes a `recharge` LEDGER row, not a
 * PaymentTransaction, and Module 13 reads revenue from paid `session_debit` payments only. So
 * this does not invent revenue — it lets revenue that was always owed finally be collected.
 */

import mongoose, { Types } from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../config/db';
import { ChargingSession } from '../models/chargingSession.model';
import { User } from '../models/user.model';
import { applyMovement, getOrCreateWallet } from '../services/wallet.service';
import { settleOutstandingForUser } from '../services/payment.service';
import { formatPaise } from '../utils/money';
import { logger } from '../utils/logger';

const SCOPE = 'fix:arrears';
const apply = process.argv.includes('--apply');

/** A little headroom so a rounding paisa does not leave the driver one unit short. */
const HEADROOM_PAISE = 100;

interface Debtor {
  _id: Types.ObjectId;
  owed: number;
  sessions: number;
}

async function main(): Promise<void> {
  await connectDatabase();

  const debtors = await ChargingSession.aggregate<Debtor>([
    { $match: { paymentStatus: 'unpaid', amountPaise: { $gt: 0 } } },
    { $group: { _id: '$userId', owed: { $sum: '$amountPaise' }, sessions: { $sum: 1 } } },
    { $sort: { owed: -1 } },
  ]);

  if (debtors.length === 0) {
    logger.info(SCOPE, 'No driver is in arrears. Nothing to do.');
    await disconnectDatabase();
    return;
  }

  const totalOwed = debtors.reduce((sum, d) => sum + d.owed, 0);
  const totalSessions = debtors.reduce((sum, d) => sum + d.sessions, 0);

  logger.info(SCOPE, `Drivers in arrears : ${debtors.length}`);
  logger.info(SCOPE, `Unpaid sessions    : ${totalSessions}`);
  logger.info(SCOPE, `Total outstanding  : ${formatPaise(totalOwed)}`);

  if (!apply) {
    logger.warn(SCOPE, 'Dry run. Re-run with --apply to credit these wallets and collect.');
    await disconnectDatabase();
    return;
  }

  let cleared = 0;
  let creditedPaise = 0;
  let settledSessions = 0;

  for (const debtor of debtors) {
    const user = await User.findById(debtor._id).select('email');
    if (!user) {
      logger.warn(SCOPE, `Skipping ${String(debtor._id)} — no such user.`);
      continue;
    }

    const wallet = await getOrCreateWallet(String(debtor._id));
    const shortfall = debtor.owed + HEADROOM_PAISE - wallet.balancePaise;

    if (shortfall > 0) {
      /*
       * One credit for the whole debt rather than one per session. The ledger should read as
       * what actually happened — a single top-up that cleared a backlog — not as a burst of
       * fabricated micro-payments engineered to match each row.
       */
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          await applyMovement(
            {
              walletId: wallet._id,
              userId: new Types.ObjectId(String(debtor._id)),
              amountPaise: shortfall,
              type: 'recharge',
              description: 'Demo top-up to clear outstanding charging sessions',
            },
            'credit',
            session,
          );
        });
      } finally {
        await session.endSession();
      }
      creditedPaise += shortfall;
    }

    // The real path. Oldest session first, stopping at the first one the wallet cannot cover.
    const settled = await settleOutstandingForUser(String(debtor._id));
    settledSessions += settled;
    if (settled === debtor.sessions) cleared += 1;
  }

  logger.info(SCOPE, `Credited  : ${formatPaise(creditedPaise)} across ${debtors.length} wallet(s)`);
  logger.info(SCOPE, `Collected : ${settledSessions} session(s)`);
  logger.info(SCOPE, `Fully clear: ${cleared}/${debtors.length} driver(s)`);

  const left = await ChargingSession.countDocuments({
    paymentStatus: 'unpaid',
    amountPaise: { $gt: 0 },
  });
  logger.info(SCOPE, `Unpaid sessions remaining: ${left}`);

  /*
   * Let the fire-and-forget notifications land before pulling the connection.
   *
   * `settleSession` dispatches `notify.paymentSucceeded` with `void` — deliberately, so a
   * slow notification never delays a driver's payment. In a long-lived server that is free.
   * In a script that exits immediately afterwards it is not: closing the pool mid-write throws
   * a pool-teardown error that looks exactly like a failed repair, after a repair that in fact
   * succeeded completely.
   */
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  await disconnectDatabase();
}

main().catch((error: unknown) => {
  logger.error(SCOPE, 'Repair failed', error);
  process.exit(1);
});
