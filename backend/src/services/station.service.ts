/**
 * Station business logic.
 *
 * This is the first module where `applyCompanyScope` is used on an ordinary owned resource,
 * which is what it was built for in Module 2.
 *
 * Worth understanding the difference from Company: there, the resource WAS the tenant, so
 * the filter was on `_id` and a `/companies/me` endpoint existed. A Station is a normal
 * resource that merely HAS a `companyId`, so the standard pattern applies —
 * `Station.find(applyCompanyScope(user, {}))` — and no `/me` variant is needed.
 */

import { Types, type QueryFilter } from 'mongoose';

import { Station, toPublicStation, type IStation, type PublicStation } from '../models/station.model';
import { Company } from '../models/company.model';
import { ROLES } from '../constants/roles';
import { CPO_SETTABLE_STATION_STATUSES, type StationStatus } from '../constants/station';
import { ApiError } from '../utils/ApiError';
import { applyCompanyScope, resolveCompanyScope } from '../utils/companyScope';
import type { AuthUser } from '../types/express';
import type { Paginated } from '../types/pagination';
import type {
  CreateStationInput,
  ListStationsQuery,
  UpdateStationInput,
} from '../validators/station.validator';

/** Never interpolate raw user input into a RegExp — see company.service for the reasoning. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Choose the error when a scoped query returns nothing.
 *
 * A company-scoped caller gets 403 even for an id that does not exist. Distinguishing 404
 * from 403 would let them probe which station ids are real across the whole platform —
 * the same reasoning as Module 3's user lookup.
 */
function notFoundOrForbidden(actor: AuthUser): ApiError {
  return actor.role === ROLES.SUPER_ADMIN
    ? ApiError.notFound('Station not found.')
    : ApiError.forbidden('You can only access stations belonging to your own company.');
}

/**
 * Work out which company a new station belongs to.
 *
 * SECURITY: for a company-scoped caller the company comes from their token, never the body.
 * Without this, a cpo_admin could plant a station inside a competitor's network — and then
 * read it back, because by the ownership filter it would be "theirs".
 */
async function resolveTargetCompany(actor: AuthUser, requested?: string): Promise<Types.ObjectId> {
  let companyId: string;

  if (actor.role === ROLES.SUPER_ADMIN) {
    if (!requested) {
      throw ApiError.validation('Validation failed', [
        { field: 'companyId', message: 'Required when creating a station as a platform administrator.' },
      ]);
    }
    companyId = requested;
  } else {
    const scope = resolveCompanyScope(actor); // throws 403 if a scoped role has no company

    if (requested && requested !== scope.companyId) {
      throw ApiError.forbidden('You can only create stations for your own company.');
    }

    companyId = scope.companyId as string;
  }

  const company = await Company.findById(companyId).select('_id');
  if (!company) throw ApiError.notFound('Company not found.');

  return company._id as Types.ObjectId;
}

/* -------------------------------------------------------------------------- */

/** super_admin (any company) or cpo_admin (their own). Operators cannot create. */
export async function createStation(
  actor: AuthUser,
  input: CreateStationInput,
): Promise<PublicStation> {
  const { companyId: requestedCompanyId, ...stationInput } = input;
  const companyId = await resolveTargetCompany(actor, requestedCompanyId);

  // Unique per company. The compound index enforces this too; checking first produces a
  // clearer message than a raw duplicate-key error.
  const clash = await Station.findOne({
    companyId,
    stationCode: stationInput.stationCode,
  }).select('_id');

  if (clash) {
    throw ApiError.conflict('A station with this code already exists in this company.');
  }

  const station = await Station.create({ ...stationInput, companyId, createdBy: actor.id });
  return toPublicStation(station);
}

/**
 * List stations, scoped to what this caller may see.
 *
 * `applyCompanyScope` returns the filter untouched for super_admin and adds
 * `{ companyId: theirs }` for everyone else — so a company-scoped caller cannot widen it.
 */
export async function listStations(
  actor: AuthUser,
  query: ListStationsQuery,
): Promise<Paginated<PublicStation>> {
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
      // Refused, not silently reset to their own company, so the attempt stays visible.
      // The scope below would have constrained the query regardless.
      throw ApiError.forbidden('You can only view stations belonging to your own company.');
    }
  }

  const filter = applyCompanyScope(actor, base);
  const skip = (query.page - 1) * query.limit;

  const [stations, total] = await Promise.all([
    Station.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    Station.countDocuments(filter),
  ]);

  return {
    items: stations.map(toPublicStation),
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
  };
}

/** Fetch one station. The scoped filter is the guarantee — not a comparison afterwards. */
export async function getStationById(actor: AuthUser, stationId: string): Promise<PublicStation> {
  const station = await Station.findOne(applyCompanyScope(actor, { _id: stationId }));
  if (!station) throw notFoundOrForbidden(actor);
  return toPublicStation(station);
}

/** Cannot change `status` or `companyId` — neither field exists in the update schema. */
export async function updateStation(
  actor: AuthUser,
  stationId: string,
  input: UpdateStationInput,
): Promise<PublicStation> {
  const station = await Station.findOne(applyCompanyScope(actor, { _id: stationId }));
  if (!station) throw notFoundOrForbidden(actor);

  if (input.stationCode && input.stationCode !== station.stationCode) {
    const clash = await Station.findOne({
      companyId: station.companyId,
      stationCode: input.stationCode,
      _id: { $ne: station._id },
    }).select('_id');

    if (clash) {
      throw ApiError.conflict('A station with this code already exists in this company.');
    }
  }

  station.set(input);
  await station.save();

  return toPublicStation(station);
}

/**
 * Activate, deactivate or suspend a station.
 *
 * Two guards, both about keeping a platform sanction meaningful:
 *   1. Only a super_admin may SET `suspended`.
 *   2. Only a super_admin may move a station AWAY from `suspended`.
 *
 * Without the second, a cpo_admin could simply clear a suspension the platform applied.
 * They still control `active`/`inactive`, which is what they actually need to take a broken
 * site offline without waiting on the platform.
 */
export async function setStationStatus(
  actor: AuthUser,
  stationId: string,
  status: StationStatus,
): Promise<PublicStation> {
  const station = await Station.findOne(applyCompanyScope(actor, { _id: stationId }));
  if (!station) throw notFoundOrForbidden(actor);

  const isPlatformAdmin = actor.role === ROLES.SUPER_ADMIN;

  if (!isPlatformAdmin && !CPO_SETTABLE_STATION_STATUSES.includes(status)) {
    throw ApiError.forbidden('Only a platform administrator can suspend a station.');
  }

  if (!isPlatformAdmin && station.status === 'suspended') {
    throw ApiError.forbidden(
      'This station has been suspended by a platform administrator and cannot be changed.',
    );
  }

  station.status = status;
  await station.save();

  return toPublicStation(station);
}
