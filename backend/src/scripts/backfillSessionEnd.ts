/**
 * Correct `endedAt` on sessions that died without a StopTransaction.
 *
 * Before utils/sessionEnd.ts, a charger that vanished mid-charge had its session closed at the
 * moment the platform NOTICED — so a 0.5 kWh charge could read "16h 47m". This recomputes the end
 * as the last meter reading (or the start, if there were none) for those sessions only:
 *
 *   status: failed, stopReason: ChargerDisconnected | HardwareFault, startedAt set
 *
 * Only the timestamp moves. Energy and amount were already computed from the last reading, so
 * nothing about billing changes.
 *
 *   npm run fix:session-end            dry run — shows what would change
 *   npm run fix:session-end -- --apply writes
 */

import { connectDatabase, disconnectDatabase } from '../config/db';
import { ChargingSession } from '../models/chargingSession.model';
import { lastEvidenceOfCharging } from '../utils/sessionEnd';
import { logger } from '../utils/logger';

const SCOPE = 'fix:session-end';

const apply = process.argv.includes('--apply');

/** Differences under a minute are just the normal gap between last reading and detection. */
const MIN_CORRECTION_MS = 60_000;

async function main(): Promise<void> {
  await connectDatabase();

  const candidates = await ChargingSession.find({
    status: 'failed',
    stopReason: { $in: ['ChargerDisconnected', 'HardwareFault'] },
    startedAt: { $ne: null },
    endedAt: { $ne: null },
  });

  const corrections: { id: string; from: Date; to: Date }[] = [];
  for (const session of candidates) {
    const to = await lastEvidenceOfCharging(session);
    if (session.endedAt && session.endedAt.getTime() - to.getTime() > MIN_CORRECTION_MS) {
      corrections.push({ id: String(session._id), from: session.endedAt, to });
    }
  }

  logger.info(SCOPE, `Failed mid-charge sessions checked : ${candidates.length}`);
  logger.info(SCOPE, `End time overstated by > 1 minute  : ${corrections.length}`);
  for (const c of corrections.slice(0, 20)) {
    const hours = ((c.from.getTime() - c.to.getTime()) / 3_600_000).toFixed(1);
    logger.info(SCOPE, `  ${c.id}: ${c.from.toISOString()} -> ${c.to.toISOString()} (${hours} h too long)`);
  }

  if (!apply) {
    logger.warn(SCOPE, 'Dry run. Re-run with --apply to write.');
    await disconnectDatabase();
    return;
  }

  // updateOne, not save(): only the timestamp changes, and the pricing hook must not re-run.
  for (const c of corrections) {
    await ChargingSession.updateOne({ _id: c.id }, { $set: { endedAt: c.to } });
  }
  logger.info(SCOPE, `Corrected ${corrections.length} session(s).`);

  await disconnectDatabase();
}

main().catch(async (error: unknown) => {
  logger.error(SCOPE, 'Backfill failed', error);
  await disconnectDatabase();
  process.exit(1);
});
