/**
 * One-time migration — copy AC/DC and the plug standard onto existing charging sessions.
 *
 *   npm run fix:session-hardware              report only, changes nothing
 *   npm run fix:session-hardware -- --apply   write chargerType / connectorType
 *
 * WHY THIS EXISTS. Sessions now snapshot `chargerType` (AC/DC) and `connectorType` (CCS2,
 * CHAdeMO…) at start, so the sessions list can filter on them. Sessions written before that have
 * both as `null`, and a null never matches a filter — so without this backfill every historical
 * charge silently disappears the moment someone picks "DC" or "CCS2".
 *
 * The values come from the charger and connector AS THEY ARE NOW. That is the best information
 * available for old rows; new sessions record the hardware as it was at the time.
 */

import { connectDatabase, disconnectDatabase } from '../config/db';
import { Charger } from '../models/charger.model';
import { ChargingSession } from '../models/chargingSession.model';
import { Connector } from '../models/connector.model';
import { logger } from '../utils/logger';

const SCOPE = 'fix:session-hardware';

const apply = process.argv.includes('--apply');

async function main(): Promise<void> {
  await connectDatabase();

  const stale = await ChargingSession.find({
    $or: [{ chargerType: null }, { connectorType: null }],
  })
    .select('_id chargerId connectorId')
    .lean();

  if (stale.length === 0) {
    logger.info(SCOPE, 'Nothing to backfill — every session already records its charger and plug type.');
    await disconnectDatabase();
    return;
  }

  // One query per collection, not per session.
  const [chargers, connectors] = await Promise.all([
    Charger.find({ _id: { $in: [...new Set(stale.map((s) => String(s.chargerId)))] } })
      .select('chargerType')
      .lean(),
    Connector.find({ _id: { $in: [...new Set(stale.map((s) => String(s.connectorId)))] } })
      .select('connectorType')
      .lean(),
  ]);
  const chargerType = new Map(chargers.map((c) => [String(c._id), c.chargerType]));
  const connectorType = new Map(connectors.map((c) => [String(c._id), c.connectorType]));

  const updates = stale
    .map((s) => ({
      id: s._id,
      chargerType: chargerType.get(String(s.chargerId)) ?? null,
      connectorType: connectorType.get(String(s.connectorId)) ?? null,
    }))
    .filter((u) => u.chargerType !== null || u.connectorType !== null);

  const orphaned = stale.length - updates.length;

  logger.info(SCOPE, `Sessions missing charger/plug type : ${stale.length}`);
  logger.info(SCOPE, `Can be filled from current hardware : ${updates.length}`);
  if (orphaned > 0) {
    logger.warn(SCOPE, `Charger and connector both deleted  : ${orphaned} (left as unknown)`);
  }

  if (!apply) {
    logger.warn(SCOPE, 'Dry run. Re-run with --apply to write.');
    await disconnectDatabase();
    return;
  }

  const result = await ChargingSession.bulkWrite(
    updates.map((u) => ({
      updateOne: {
        filter: { _id: u.id },
        update: {
          $set: {
            ...(u.chargerType ? { chargerType: u.chargerType } : {}),
            ...(u.connectorType ? { connectorType: u.connectorType } : {}),
          },
        },
      },
    })),
  );

  logger.info(SCOPE, `Updated ${result.modifiedCount} session(s).`);
  await disconnectDatabase();
}

main().catch((error: unknown) => {
  logger.error(SCOPE, 'Backfill failed', error);
  process.exit(1);
});
