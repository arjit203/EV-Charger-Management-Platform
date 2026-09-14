/**
 * Coordinate validity — deliberately in its own module, with NO Leaflet import.
 *
 * WHY THIS FILE EXISTS, because it is not obvious and the build caught it:
 *
 * `StationMap.tsx` is loaded through `next/dynamic` with `ssr: false` precisely because
 * Leaflet reads `window` at module load. But this helper was originally exported from that
 * same file — so the page and the list panel imported it STATICALLY, which pulled the whole
 * Leaflet module into the server bundle and defeated the dynamic boundary completely.
 * `next build` failed with `ReferenceError: window is not defined` while prerendering /map.
 *
 * The rule it teaches: `ssr: false` only protects a module nobody imports statically. One
 * ordinary `import { helper } from './TheMapComponent'` anywhere is enough to undo it.
 *
 * So: anything the server may touch lives here; anything that touches Leaflet stays in
 * `StationMap.tsx`, which is imported through `dynamic()` and nowhere else.
 */

import type { AnyMapStation } from '@/types/api';

/**
 * Can this station actually be placed on a map?
 *
 * The API cannot produce a station without coordinates — `latitude` and `longitude` are
 * `required` with min/max on the Mongoose schema, so every station created through the
 * platform is placeable. This is defence-in-depth against a row written directly to the
 * database, or by some future bulk-import path.
 *
 * It earns its place because the failure mode is disproportionate: `NaN` or an out-of-range
 * latitude handed to Leaflet THROWS, so one malformed row would blank the entire map rather
 * than just omitting its own marker.
 */
export function hasUsableCoordinates(station: AnyMapStation): boolean {
  const { latitude, longitude } = station;

  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}
