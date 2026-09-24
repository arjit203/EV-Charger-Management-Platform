/**
 * Station map reads — Module 14.
 *
 * ============================================================================
 * READ THIS BEFORE CHANGING ANYTHING IN THIS FILE.
 *
 * `listPublicStations` is THE FIRST DELIBERATELY CROSS-COMPANY READ IN THIS
 * PROJECT. Every query since Module 2 has been narrowed by `applyCompanyScope`.
 * This one is not, and that is correct: a driver looking for somewhere to charge
 * needs to see every operator's sites, not one company's.
 *
 * That is exactly why it lives in its own file with its own route and its own
 * tests, instead of as a role branch inside `station.service.ts`. A function that
 * usually scopes by company but skips it for one caller is a function someone
 * will later edit without noticing the exception.
 * ============================================================================
 *
 * Two endpoints, two different authorisation shapes:
 *
 *   listStationsForMap    staff. Company-scoped exactly like Module 4's list.
 *   listPublicStations    driver discovery. NOT company-scoped, and therefore
 *                         hard-filtered to active stations of active companies,
 *                         with every company-identifying field stripped.
 *
 * Neither endpoint paginates. A map wants every visible marker at once, so both
 * return a flat capped array instead — see MAX_MAP_STATIONS.
 *
 * NO GEOSPATIAL QUERY LIVES HERE, and that is a decision rather than an omission.
 * Module 4 recorded that "Module 14's map needs $near queries", and that
 * prediction was wrong: DRAWING a marker needs two numbers, while SELECTING rows
 * by proximity needs GeoJSON and a 2dsphere index. This module only draws, and
 * nearby-search is explicitly out of its scope, so Module 4's deferred migration
 * stays deferred. The trigger that would finally cash it in is precise: the first
 * `$near` query — a radius filter, or "stations near me" sorted by distance.
 */

import { Types, type QueryFilter } from 'mongoose';

import { Charger } from '../models/charger.model';
import { Company } from '../models/company.model';
import { Connector } from '../models/connector.model';
import { Station, type IStation } from '../models/station.model';

import { ROLES } from '../constants/roles';
import { ApiError } from '../utils/ApiError';
import { applyCompanyScope } from '../utils/companyScope';
import type { AuthUser } from '../types/express';
import {
  DEFAULT_NEAR_RADIUS_KM,
  MAX_MAP_STATIONS,
  type StationStatus,
} from '../constants/station';
import type {
  MapStationsQuery,
  PublicStationsQuery,
} from '../validators/station.validator';


/** Never interpolate raw user input into a RegExp — same rule as Module 2 onward. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* -------------------------------------------------------------------------- */
/* Public shapes                                                              */
/* -------------------------------------------------------------------------- */

/** Availability, counted from what Modules 5 and 6 already maintain. */
interface Availability {
  chargers: number;
  chargersOnline: number;
  totalConnectors: number;
  availableConnectors: number;
}

/** Staff marker. Carries operational and company fields. */
export interface MapStation extends Availability {
  id: string;
  name: string;
  stationCode: string;
  address: string;
  city: string;
  state: string;
  latitude: number;
  longitude: number;
  status: StationStatus;
  companyId: string;
}

/**
 * Driver marker. A DELIBERATELY NARROWER TYPE, not the staff one with fields blanked.
 *
 * There is no `companyId`, no `stationCode`, no `createdBy`, no `contactPhone` and no
 * timestamps — the compiler will not let a company id reach a driver through this shape,
 * which is a stronger guarantee than remembering to delete it before responding.
 *
 * On `contactPhone` specifically: Module 4's model describes it as "someone a driver can
 * call when a site is blocked". That is true, and it still does not belong HERE — a bulk
 * cross-company marker list does not need a phone number for every site on the map. It
 * belongs on a driver-facing station DETAIL view, which does not exist yet. Left out on
 * purpose rather than by oversight.
 */
export interface PublicMapStation extends Availability {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  latitude: number;
  longitude: number;
  status: StationStatus;
  /** Straight-line distance from the driver. Present only on a "near me" search. */
  distanceKm?: number;
}

export interface MapStationsResult<T> {
  stations: T[];
  /** True when the cap clipped the result, so the UI can say so rather than mislead. */
  truncated: boolean;
}

/* -------------------------------------------------------------------------- */
/* Availability                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Connector availability per station, in ONE aggregation for the whole marker set.
 *
 * The pipeline STARTS at Charger because `Connector` carries no `stationId` — a connector
 * is part of a machine, not of a site (Module 5's decision). Same shape as Module 13's
 * fleet snapshot, for the same reason.
 *
 * WHAT "AVAILABLE" MEANS HERE, stated exactly:
 *
 *   available = connectors whose status is 'available',
 *               on chargers whose status is 'available'
 *               and whose hardwareStatus is 'operative'
 *
 * Charger `status` is in the gate because a charger marked for maintenance genuinely has
 * no usable plugs, and `hardwareStatus` for the sharper version of the same thing: a machine
 * that has reported a fault about ITSELF has no usable plugs either, however healthy each
 * individual connector still claims to be. Leaving it out would send drivers to a charger the
 * hardware had already written off.
 *
 * `isOnline` is NOT in the gate: connectivity flips second to second, and folding it in would
 * make the number flicker while HIDING the more useful fact. It is returned separately as
 * `chargersOnline` so the UI can show both. A fault is different in kind — it persists until
 * someone fixes the machine, so it does not flicker.
 *
 * HONEST LIMIT: this is a database snapshot at request time, not a reservation. A driver
 * who sees "3 available" may arrive to find two. Closing that gap is a reservation system,
 * which this project does not have and this module does not add.
 */
async function availabilityByStation(
  stationIds: Types.ObjectId[],
): Promise<Map<string, Availability>> {
  const empty = new Map<string, Availability>();
  if (stationIds.length === 0) return empty;

  const rows = await Charger.aggregate<{ _id: Types.ObjectId } & Availability>([
    { $match: { stationId: { $in: stationIds } } },
    {
      $lookup: {
        from: Connector.collection.name,
        localField: '_id',
        foreignField: 'chargerId',
        as: 'connectors',
      },
    },
    {
      $group: {
        _id: '$stationId',
        chargers: { $sum: 1 },
        chargersOnline: { $sum: { $cond: ['$isOnline', 1, 0] } },
        totalConnectors: { $sum: { $size: '$connectors' } },
        availableConnectors: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$status', 'available'] },
                  // `$ne` rather than `$eq: 'operative'` so a charger row written before this
                  // field existed — where it is missing, not 'operative' — still counts.
                  { $ne: ['$hardwareStatus', 'faulted'] },
                  { $ne: ['$hardwareStatus', 'unavailable'] },
                ],
              },
              {
                $size: {
                  $filter: {
                    input: '$connectors',
                    as: 'connector',
                    cond: { $eq: ['$$connector.status', 'available'] },
                  },
                },
              },
              0,
            ],
          },
        },
      },
    },
  ]);

  for (const row of rows) {
    empty.set(String(row._id), {
      chargers: row.chargers,
      chargersOnline: row.chargersOnline,
      totalConnectors: row.totalConnectors,
      availableConnectors: row.availableConnectors,
    });
  }

  return empty;
}

/**
 * A station with no chargers at all produces NO aggregation row — `$group` returns nothing
 * rather than a zero, the same trap Module 13 documented. Defaulted here so a brand-new
 * station reads "0 of 0" instead of rendering `undefined` on a marker.
 */
const NO_CHARGERS: Availability = {
  chargers: 0,
  chargersOnline: 0,
  totalConnectors: 0,
  availableConnectors: 0,
};

/* -------------------------------------------------------------------------- */
/* Staff map                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * GET /stations/map — staff markers, company-scoped.
 *
 * Filtering reuses Module 4's semantics EXACTLY, including the detail that `search` matches
 * name, stationCode and address while `city` is a separate exact match. Re-implementing
 * search differently here would be a second way to answer one question, which is the thing
 * this project has refused since Module 9.
 */
export async function listStationsForMap(
  actor: AuthUser,
  query: MapStationsQuery,
): Promise<MapStationsResult<MapStation>> {
  const base: QueryFilter<IStation> = {};

  if (query.status) base.status = query.status;
  if (query.city) base.city = { $regex: `^${escapeRegex(query.city)}$`, $options: 'i' };

  if (query.search) {
    const pattern = { $regex: escapeRegex(query.search), $options: 'i' };
    base.$or = [{ name: pattern }, { stationCode: pattern }, { address: pattern }];
  }

  if (query.companyId) {
    if (actor.role === ROLES.SUPER_ADMIN) {
      base.companyId = new Types.ObjectId(query.companyId);
    } else if (query.companyId !== actor.companyId) {
      // Refused rather than silently reset, so the attempt is visible — Module 4's rule.
      throw ApiError.forbidden('You can only view stations belonging to your own company.');
    }
  }

  const limit = query.limit ?? MAX_MAP_STATIONS;

  // One extra row asked for, purely to detect truncation without a second count query.
  const found = await Station.find(applyCompanyScope(actor, base))
    .sort({ name: 1 })
    .limit(limit + 1)
    .select('name stationCode address city state latitude longitude status companyId')
    .lean();

  const truncated = found.length > limit;
  const stations = truncated ? found.slice(0, limit) : found;

  const availability = await availabilityByStation(stations.map((station) => station._id));

  return {
    truncated,
    stations: stations.map((station) => ({
      id: String(station._id),
      name: station.name,
      stationCode: station.stationCode,
      address: station.address,
      city: station.city,
      state: station.state,
      latitude: station.latitude,
      longitude: station.longitude,
      status: station.status,
      companyId: String(station.companyId),
      ...(availability.get(String(station._id)) ?? NO_CHARGERS),
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Driver discovery — the cross-company read                                  */
/* -------------------------------------------------------------------------- */

/**
 * GET /stations/public — every ACTIVE station of every ACTIVE company.
 *
 * THE TWO-LEVEL FILTER IS THE WHOLE POINT OF THIS FUNCTION.
 *
 * Filtering on `station.status === 'active'` alone is NOT enough. When Module 2 suspends a
 * company, its stations keep whatever status they individually had — so a suspended CPO's
 * sites would carry on advertising themselves to drivers through the one endpoint in the
 * project that does not check company scope. That would undo company suspension through a
 * side door, on the single route where nobody would think to look.
 *
 * So:  station is active  AND  the company that owns it is active.
 *
 * There is no `companyId` parameter on this endpoint, and that is deliberate too: letting a
 * driver filter by company would hand back the company identity the response shape exists to
 * remove. `.strict()` turns an attempt into a 400.
 *
 * No `actor` parameter. This function CANNOT be made to scope by company, because it has
 * nothing to scope by — the narrowest possible way to say "this read is the same for
 * everyone who can reach it".
 */
export async function listPublicStations(
  query: PublicStationsQuery,
): Promise<MapStationsResult<PublicMapStation>> {
  // Level two of the filter. Resolved first so the station query stays a simple indexed
  // $in rather than a $lookup, and so "which companies are active" is one obvious line.
  const activeCompanies = await Company.find({ status: 'active' }).select('_id').lean();

  if (activeCompanies.length === 0) {
    return { stations: [], truncated: false };
  }

  const base: QueryFilter<IStation> = {
    status: 'active',
    companyId: { $in: activeCompanies.map((company) => company._id) },
  };

  if (query.city) base.city = { $regex: `^${escapeRegex(query.city)}$`, $options: 'i' };

  if (query.search) {
    const pattern = { $regex: escapeRegex(query.search), $options: 'i' };
    // Note: no stationCode here. It is an internal operational label, and matching on it
    // would let a driver confirm a code exists even though the response never returns one.
    base.$or = [{ name: pattern }, { address: pattern }, { city: pattern }];
  }

  const limit = query.limit ?? MAX_MAP_STATIONS;

  type Found = Pick<IStation, 'name' | 'address' | 'city' | 'state' | 'latitude' | 'longitude' | 'status'> & {
    _id: Types.ObjectId;
    distanceM?: number;
  };

  let found: Found[];

  if (query.lat !== undefined && query.lng !== undefined) {
    /*
     * NEAR ME — nearest first, within a radius.
     *
     * Done in the DATABASE with `$geoNear`, not by sorting in the browser. Browser-side sorting
     * only works while every station fits in one response; past MAX_MAP_STATIONS the nearest
     * charger could simply be missing from the page. `$geoNear` walks the 2dsphere index
     * outward from the driver, so the answer stays right at any size — which is how real
     * charging apps do it.
     *
     * The same two-level "who may appear" filter applies, via `query`.
     */
    const radiusKm = query.radiusKm ?? DEFAULT_NEAR_RADIUS_KM;

    found = await Station.aggregate<Found>([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [query.lng, query.lat] },
          distanceField: 'distanceM',
          maxDistance: radiusKm * 1000,
          spherical: true,
          query: base,
        },
      },
      { $limit: limit + 1 },
      {
        $project: {
          name: 1, address: 1, city: 1, state: 1, latitude: 1, longitude: 1, status: 1, distanceM: 1,
        },
      },
    ]);
  } else {
    found = await Station.find(base)
      .sort({ name: 1 })
      .limit(limit + 1)
      .select('name address city state latitude longitude status')
      .lean<Found[]>();
  }

  const truncated = found.length > limit;
  const stations = truncated ? found.slice(0, limit) : found;

  const availability = await availabilityByStation(stations.map((station) => station._id));

  return {
    truncated,
    stations: stations.map((station) => ({
      id: String(station._id),
      name: station.name,
      address: station.address,
      city: station.city,
      state: station.state,
      latitude: station.latitude,
      longitude: station.longitude,
      status: station.status,
      ...(station.distanceM !== undefined
        ? { distanceKm: Math.round(station.distanceM / 100) / 10 }
        : {}),
      ...(availability.get(String(station._id)) ?? NO_CHARGERS),
    })),
  };
}
