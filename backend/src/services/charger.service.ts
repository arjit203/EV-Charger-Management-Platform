/**
 * Charger business logic — and the place the OWNERSHIP CHAIN is enforced.
 *
 * The chain is Company -> Station -> Charger -> Connector, and security must hold at every
 * hop, not just the last one. The technique is unchanged from Modules 2-4: fetch the parent
 * THROUGH the caller's company scope, so a parent belonging to another company is simply not
 * found. Never trust an id from the request to imply ownership.
 */

import { Types, type QueryFilter } from 'mongoose';

import { Charger, toPublicCharger, type ICharger, type PublicCharger, type ChargerDocument } from '../models/charger.model';
import { DC_ONLY_CONNECTOR_TYPES } from '../constants/connector';
import { Connector } from '../models/connector.model';
import { Station, type StationDocument } from '../models/station.model';
import { ROLES } from '../constants/roles';
import type { ChargerStatus } from '../constants/charger';
import { ApiError } from '../utils/ApiError';
import { applyCompanyScope } from '../utils/companyScope';
import { generateChargerToken, hashChargerToken } from '../utils/chargerToken';
import type { AuthUser } from '../types/express';
import type { Paginated } from '../types/pagination';
import type {
  CreateChargerInput,
  ListChargersQuery,
  UpdateChargerInput,
} from '../validators/charger.validator';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A company-scoped caller gets 403 even for ids that do not exist, so the endpoint cannot be
 * used to probe which chargers or stations are real platform-wide. Same rule as Modules 3-4.
 */
function notFoundOrForbidden(actor: AuthUser, what: string): ApiError {
  return actor.role === ROLES.SUPER_ADMIN
    ? ApiError.notFound(`${what} not found.`)
    : ApiError.forbidden(`You can only access ${what.toLowerCase()}s belonging to your own company.`);
}

/**
 * Resolve a station the caller is allowed to use — HOP 1 of the chain.
 *
 * SECURITY: the station is fetched through `applyCompanyScope`, so a station belonging to
 * another company is not found at all. This is what stops a cpo_admin creating a charger
 * inside a competitor's site by supplying its `stationId`.
 */
async function assertStationInScope(actor: AuthUser, stationId: string): Promise<StationDocument> {
  const station = await Station.findOne(applyCompanyScope(actor, { _id: stationId }));
  if (!station) throw notFoundOrForbidden(actor, 'Station');
  return station;
}

/**
 * Resolve a charger the caller is allowed to use — HOP 2 of the chain.
 *
 * Exported because `connector.service` needs the same verification before touching any
 * connector: the parent charger is checked once, and connector queries then filter on
 * `chargerId` alone.
 */
export async function assertChargerInScope(
  actor: AuthUser,
  chargerId: string,
): Promise<ChargerDocument> {
  const charger = await Charger.findOne(applyCompanyScope(actor, { _id: chargerId }));
  if (!charger) throw notFoundOrForbidden(actor, 'Charger');
  return charger;
}

/* -------------------------------------------------------------------------- */

/**
 * What a caller receives after creating a charger or regenerating its token.
 *
 * `authToken` is the PLAINTEXT connection secret, and this is the ONLY time it is ever
 * returned — the database stores a bcrypt hash. Same contract as an API key: shown once,
 * regenerate if lost.
 */
export interface ChargerWithToken {
  charger: PublicCharger;
  authToken: string;
}

/**
 * Create a charger.
 *
 * `companyId` is copied from the VERIFIED station, never from the request body — which is
 * why a charger cannot be planted inside another company even if its id were guessed.
 *
 * Module 6: also issues the OCPP connection token the charger needs to authenticate.
 */
export async function createCharger(
  actor: AuthUser,
  input: CreateChargerInput,
): Promise<ChargerWithToken> {
  const station = await assertStationInScope(actor, input.stationId);

  // Globally unique: Module 6's gateway resolves an incoming connection by this alone.
  const ocppClash = await Charger.findOne({ ocppId: input.ocppId }).select('_id');
  if (ocppClash) {
    throw ApiError.conflict('This OCPP identifier is already registered on the platform.');
  }

  // Unique per station, not per company — two sites may each have a charger "01".
  const codeClash = await Charger.findOne({
    stationId: station._id,
    chargerCode: input.chargerCode,
  }).select('_id');
  if (codeClash) {
    throw ApiError.conflict('A charger with this code already exists at this station.');
  }

  const { stationId: _ignored, ...chargerInput } = input;

  const authToken = generateChargerToken();

  const charger = await Charger.create({
    ...chargerInput,
    stationId: station._id,
    companyId: station.companyId, // <- from the station, not the caller
    authTokenHash: await hashChargerToken(authToken),
    createdBy: actor.id,
  });

  return { charger: toPublicCharger(charger), authToken };
}

/**
 * Issue a new OCPP connection token, invalidating the old one.
 *
 * Necessary precisely because the token is stored hashed and shown once: if it is lost there
 * is no way to recover it, only to replace it. Any charger still connected with the old token
 * keeps its current socket but cannot reconnect.
 */
export async function regenerateChargerToken(
  actor: AuthUser,
  chargerId: string,
): Promise<ChargerWithToken> {
  const charger = await assertChargerInScope(actor, chargerId);

  const authToken = generateChargerToken();
  charger.authTokenHash = await hashChargerToken(authToken);
  await charger.save();

  return { charger: toPublicCharger(charger), authToken };
}

export async function listChargers(
  actor: AuthUser,
  query: ListChargersQuery,
): Promise<Paginated<PublicCharger>> {
  const base: QueryFilter<ICharger> = {};

  if (query.stationId) base.stationId = new Types.ObjectId(query.stationId);
  if (query.status) base.status = query.status;
  if (query.chargerType) base.chargerType = query.chargerType;
  if (query.isOnline !== undefined) base.isOnline = query.isOnline;

  /*
   * "Chargers that have a CCS2 plug". The plug lives on the Connector, so this resolves the
   * matching charger ids first. Connectors are few per charger, and the list is company-scoped
   * again below, so this cannot widen what the caller sees.
   */
  if (query.connectorType) {
    const ids = await Connector.distinct('chargerId', { connectorType: query.connectorType });
    base._id = { $in: ids };
  }

  if (query.manufacturer) {
    base.manufacturer = { $regex: `^${escapeRegex(query.manufacturer)}$`, $options: 'i' };
  }

  if (query.search) {
    const pattern = { $regex: escapeRegex(query.search), $options: 'i' };
    base.$or = [{ name: pattern }, { chargerCode: pattern }, { ocppId: pattern }, { model: pattern }];
  }

  if (query.companyId) {
    if (actor.role === ROLES.SUPER_ADMIN) {
      base.companyId = new Types.ObjectId(query.companyId);
    } else if (query.companyId !== actor.companyId) {
      // Refused rather than silently reset, so the attempt stays visible in the logs.
      throw ApiError.forbidden('You can only view chargers belonging to your own company.');
    }
  }

  const filter = applyCompanyScope(actor, base);
  const skip = (query.page - 1) * query.limit;

  const [chargers, total] = await Promise.all([
    Charger.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    Charger.countDocuments(filter),
  ]);

  return {
    items: chargers.map(toPublicCharger),
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
  };
}

export async function getChargerById(actor: AuthUser, chargerId: string): Promise<PublicCharger> {
  return toPublicCharger(await assertChargerInScope(actor, chargerId));
}

/** Cannot change `stationId`, `companyId` or `status` — none exist in the update schema. */
export async function updateCharger(
  actor: AuthUser,
  chargerId: string,
  input: UpdateChargerInput,
): Promise<PublicCharger> {
  const charger = await assertChargerInScope(actor, chargerId);

  if (input.ocppId && input.ocppId !== charger.ocppId) {
    const clash = await Charger.findOne({ ocppId: input.ocppId, _id: { $ne: charger._id } }).select('_id');
    if (clash) {
      throw ApiError.conflict('This OCPP identifier is already registered on the platform.');
    }
  }

  if (input.chargerCode && input.chargerCode !== charger.chargerCode) {
    const clash = await Charger.findOne({
      stationId: charger.stationId,
      chargerCode: input.chargerCode,
      _id: { $ne: charger._id },
    }).select('_id');
    if (clash) {
      throw ApiError.conflict('A charger with this code already exists at this station.');
    }
  }

  // Switching a charger to AC must not strand DC-only plugs on it (see DC_ONLY_CONNECTOR_TYPES).
  if (input.chargerType === 'AC' && charger.chargerType !== 'AC') {
    const dcPlug = await Connector.findOne({
      chargerId: charger._id,
      connectorType: { $in: DC_ONLY_CONNECTOR_TYPES },
    }).select('connectorNumber connectorType');

    if (dcPlug) {
      throw ApiError.validation(
        `Connector ${dcPlug.connectorNumber} is ${dcPlug.connectorType}, a DC-only plug. Change or remove it before marking this charger AC.`,
        { field: 'chargerType' },
      );
    }
  }

  charger.set(input);
  await charger.save();

  return toPublicCharger(charger);
}

/**
 * Set charger status.
 *
 * Deliberately does NOT cascade to connectors. Real OCPP status arrives per connector from
 * the hardware in Module 6, so inventing cascade rules now would mean writing logic that has
 * to be removed, and which could then contradict the real data.
 */
export async function setChargerStatus(
  actor: AuthUser,
  chargerId: string,
  status: ChargerStatus,
): Promise<PublicCharger> {
  const charger = await assertChargerInScope(actor, chargerId);
  charger.status = status;
  await charger.save();
  return toPublicCharger(charger);
}
