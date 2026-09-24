/**
 * One-time migration — give existing stations the GeoJSON `location` "near me" needs.
 *
 *   npm run fix:station-location              report only, changes nothing
 *   npm run fix:station-location -- --apply   write location from latitude/longitude
 *
 * WHY THIS EXISTS. `location` is derived from latitude/longitude by a pre-validate hook, so
 * every station created or saved from now on has it. Stations written before the field existed
 * do not, and `$geoNear` simply skips documents without it — so without this, every existing
 * station is invisible to "near me" until someone happens to edit it.
 */

import { connectDatabase, disconnectDatabase } from '../config/db';
import { Station } from '../models/station.model';
import { logger } from '../utils/logger';

const SCOPE = 'fix:station-location';

const apply = process.argv.includes('--apply');

async function main(): Promise<void> {
  await connectDatabase();

  const missing = { 'location.coordinates': { $exists: false } };
  const count = await Station.countDocuments(missing);

  if (count === 0) {
    logger.info(SCOPE, 'Nothing to backfill — every station already has a location.');
    await disconnectDatabase();
    return;
  }

  logger.info(SCOPE, `Stations without a location: ${count}`);

  if (!apply) {
    logger.warn(SCOPE, 'Dry run. Re-run with --apply to write.');
    await disconnectDatabase();
    return;
  }

  // An update PIPELINE, so each station's own numbers are copied server-side in one command.
  // GeoJSON order is [longitude, latitude].
  const result = await Station.updateMany(missing, [
    { $set: { location: { type: 'Point', coordinates: ['$longitude', '$latitude'] } } },
  ]);

  logger.info(SCOPE, `Updated ${result.modifiedCount} station(s).`);
  await disconnectDatabase();
}

main().catch((error: unknown) => {
  logger.error(SCOPE, 'Backfill failed', error);
  process.exit(1);
});
