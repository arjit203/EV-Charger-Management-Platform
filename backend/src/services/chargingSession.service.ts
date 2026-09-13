/**
 * Charging session business logic — the PERSON-driven half of Module 7.
 *
 * THIS IS NOW THE ONLY PATH THAT CAN PUT A CONNECTOR INTO A CHARGING STATE.
 *
 * Module 6 exposed raw `POST /chargers/:id/commands/remote-start`, which could tell a charger
 * to deliver power without any record of who asked or what was delivered. Those endpoints are
 * gone (see the Module 7 design doc, D12). `ocpp/commands.ts` survives as the low-level way to
 * write a frame to a socket, but its only caller is this file — so a charger cannot start
 * without a ChargingSession row existing first.
 *
 * The rule that follows from that: NO ENERGY WITHOUT A SESSION. It is enforced twice, once
 * here (nothing else may send RemoteStart) and once in the gateway (a StartTransaction that
 * matches no session is refused).
 */

import { Types } from 'mongoose';
import crypto from 'crypto';

import {
  ChargingSession,
  toPublicChargingSession,
  type ChargingSessionDocument,
  type PublicChargingSession,
} from '../models/chargingSession.model';
import { MeterReading, toPublicMeterReading, type PublicMeterReading } from '../models/meterReading.model';
import { Charger } from '../models/charger.model';
import { Connector } from '../models/connector.model';
import { Station } from '../models/station.model';
import { Vehicle } from '../models/vehicle.model';
import { ROLES } from '../constants/roles';
import {
  OPEN_SESSION_STATUSES,
  SESSION_ID_TAG_PREFIX,
  SESSION_ID_TAG_RANDOM_HEX,
  type SessionStatus,
} from '../constants/session';
import { ApiError } from '../utils/ApiError';
import { applyCompanyScope } from '../utils/companyScope';
import { applyOwnerScope } from '../utils/ownerScope';
import { logger } from '../utils/logger';
import { sendRemoteStart, sendRemoteStop } from '../ocpp/commands';
import * as registry from '../ocpp/registry';
import type { Paginated } from '../types/pagination';
import type { AuthUser } from '../types/express';
import type { StartSessionInput, ListSessionsQuery } from '../validators/session.validator';

const SCOPE = 'session';

const DUPLICATE_KEY = 11000;

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(error) && (error as { code?: number }).code === DUPLICATE_KEY;
}

/**
 * Mint the credential the charger will quote back at us.
 *
 * 20 characters exactly, because OCPP 1.6 caps idTag there — which is also why a raw ObjectId
 * (24 hex characters) cannot be used. Random rather than derived from the user id: this tag
 * travels over the wire to hardware, and a guessable one would let anyone forge an Authorize.
 */
function mintIdTag(): string {
  return (
    SESSION_ID_TAG_PREFIX + crypto.randomBytes(SESSION_ID_TAG_RANDOM_HEX).toString('hex').slice(0, SESSION_ID_TAG_RANDOM_HEX)
  ).toUpperCase();
}

/* -------------------------------------------------------------------------- */
/* Read scoping                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Who may see which sessions.
 *
 * This is the first resource in the project where BOTH scoping primitives apply, depending on
 * who is asking — and that is exactly right, because a session genuinely has two owners:
 *
 *   the DRIVER  who charged        -> applyOwnerScope
 *   the COMPANY whose plug it was  -> applyCompanyScope
 *
 * A driver sees their charge at someone else's station. A CPO sees every charge at their own
 * stations, including ones by drivers they have no other relationship with. Neither of those
 * is a widening of the other, so the role picks the scope rather than combining them.
 */
function applySessionReadScope(
  actor: AuthUser,
  filter: Record<string, unknown>,
): Record<string, unknown> {
  if (actor.role === ROLES.DRIVER) return applyOwnerScope(actor, filter);
  return applyCompanyScope(actor, filter);
}

function sessionNotFound(actor: AuthUser): ApiError {
  if (actor.role === ROLES.SUPER_ADMIN || actor.role === ROLES.DRIVER) {
    return ApiError.notFound('Charging session not found.');
  }

  // Company-scoped callers get 403 even for ids that do not exist, so the endpoint cannot be
  // used to probe which session ids are real. Same rule as Modules 2, 4 and 5.
  return ApiError.forbidden('You can only access charging sessions at your own stations.');
}

/* -------------------------------------------------------------------------- */
/* Connector lookup (the QR-code endpoint)                                    */
/* -------------------------------------------------------------------------- */

export interface ConnectorChargingView {
  connectorId: string;
  connectorNumber: number;
  connectorType: string;
  status: string;
  chargerId: string;
  chargerName: string;
  powerKw: number;
  isOnline: boolean;
  stationName: string;
  stationAddress: string;
  /** The single answer the app actually needs before showing a Start button. */
  canStart: boolean;
  unavailableReason: string | null;
}

/**
 * What a driver sees after scanning the QR code on a plug.
 *
 * NOT company-scoped, deliberately, and this is the first endpoint in the project where that
 * is true. A driver belongs to no company, and public charging infrastructure is public: the
 * whole business model is that anyone can charge at anyone's station. Scoping this would mean
 * a driver could only use plugs owned by a company they are a member of, which is not a thing.
 *
 * It is still authenticated, and it still returns only the fields needed to start a charge.
 */
export async function getConnectorForCharging(
  connectorId: string,
): Promise<ConnectorChargingView> {
  const connector = await Connector.findById(connectorId);
  if (!connector) throw ApiError.notFound('Connector not found.');

  const charger = await Charger.findById(connector.chargerId);
  if (!charger) throw ApiError.notFound('Connector not found.');

  const station = await Station.findById(charger.stationId);
  if (!station) throw ApiError.notFound('Connector not found.');

  const { canStart, reason } = assessStartability(connector.status, charger.status, charger.isOnline);

  return {
    connectorId: String(connector._id),
    connectorNumber: connector.connectorNumber,
    connectorType: connector.connectorType,
    status: connector.status,
    chargerId: String(charger._id),
    chargerName: charger.name,
    powerKw: charger.powerKw,
    isOnline: charger.isOnline,
    stationName: station.name,
    stationAddress: station.address,
    canStart,
    unavailableReason: reason,
  };
}

/**
 * The three independent reasons a plug cannot be used, checked in the order a driver would
 * care about them.
 *
 * ALL THREE STATE MACHINES ARE CONSULTED, and that is the point. `Charger.status` is
 * administrative (a human put this machine into maintenance), `Charger.isOnline` is
 * connectivity, and `Connector.status` is what the hardware last reported about this
 * particular plug. A charger can be administratively fine but unreachable, or reachable with a
 * faulted plug. One boolean could never have expressed that, which is why Modules 5 and 6 kept
 * them apart — this function is the first place all three are read together.
 */
function assessStartability(
  connectorStatus: string,
  chargerStatus: string,
  isOnline: boolean,
): { canStart: boolean; reason: string | null } {
  if (chargerStatus !== 'available') {
    return { canStart: false, reason: `This charger is ${chargerStatus}.` };
  }
  if (!isOnline) {
    return { canStart: false, reason: 'This charger is not currently connected.' };
  }
  if (connectorStatus === 'faulted' || connectorStatus === 'unavailable') {
    return { canStart: false, reason: `This connector is ${connectorStatus}.` };
  }
  if (connectorStatus === 'charging' || connectorStatus === 'occupied') {
    return { canStart: false, reason: 'This connector is already in use.' };
  }
  return { canStart: true, reason: null };
}

/* -------------------------------------------------------------------------- */
/* Start                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Start a charging session.
 *
 * THE ORDER OF OPERATIONS IS THE DESIGN. The session row is written BEFORE the OCPP command
 * goes out, not after:
 *
 *   1. resolve and validate the connector, charger and station
 *   2. INSERT the session as `initiating`  <- the partial unique index reserves the connector
 *   3. send RemoteStartTransaction
 *   4. charger rejects or times out -> transition to `failed`
 *
 * Writing first is what makes the reservation atomic. If we sent the command first and wrote
 * afterwards, two simultaneous requests would both send a RemoteStart before either had
 * written anything — the classic check-then-act race, with real power as the side effect.
 *
 * Step 4 transitions rather than deletes. A driver who pressed start and got nothing deserves
 * a record that says so; a row that quietly disappears looks identical to a bug.
 */
export async function startSession(
  actor: AuthUser,
  input: StartSessionInput,
): Promise<PublicChargingSession> {
  const connector = await Connector.findById(input.connectorId);
  if (!connector) throw ApiError.notFound('Connector not found.');

  const charger = await Charger.findById(connector.chargerId);
  if (!charger) throw ApiError.notFound('Connector not found.');

  const { canStart, reason } = assessStartability(
    connector.status,
    charger.status,
    charger.isOnline,
  );
  if (!canStart) throw ApiError.conflict(reason ?? 'This connector cannot be used right now.');

  // The socket has to exist before we promise the driver anything. `isOnline` is a database
  // mirror updated by heartbeats; the registry is the live truth.
  const connection = registry.get(charger.ocppId);
  if (!connection) {
    throw ApiError.conflict('This charger is not currently connected to the OCPP gateway.', {
      ocppId: charger.ocppId,
    });
  }

  const vehicleId = await resolveVehicle(actor, input.vehicleId ?? null, connector.connectorType);

  const idTag = mintIdTag();

  let session: ChargingSessionDocument;
  try {
    session = await ChargingSession.create({
      userId: new Types.ObjectId(actor.id),
      vehicleId,
      // Copied from the VERIFIED charger, never from the request body — the same rule that
      // built the Station -> Charger -> Connector chain in Module 5.
      companyId: charger.companyId,
      stationId: charger.stationId,
      chargerId: charger._id,
      connectorId: connector._id,
      connectorNumber: connector.connectorNumber,
      idTag,
      status: 'initiating',
      requestedAt: new Date(),
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      // The partial unique index refused a second open session on this connector. This is the
      // race actually being caught, not a hypothetical.
      throw ApiError.conflict('A charging session is already in progress on this connector.');
    }
    throw error;
  }

  try {
    const response = await sendRemoteStart(connection, connector.connectorNumber, idTag);

    if (response.status !== 'Accepted') {
      await markFailed(session, 'Rejected', `The charger rejected the start (${String(response.status)}).`);
      throw ApiError.conflict('The charger rejected the start request.');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;

    // A timeout or socket failure. The sweeper would catch this eventually; failing it now
    // releases the connector immediately instead of holding it for the full timeout.
    const message = error instanceof Error ? error.message : String(error);
    await markFailed(session, 'StartTimeout', `The charger did not respond: ${message}`);
    logger.error(SCOPE, `RemoteStart failed for session ${String(session._id)}`, error);
    throw ApiError.conflict('The charger did not respond to the start request.');
  }

  logger.info(SCOPE, `Session ${String(session._id)} initiating on ${charger.ocppId}`);

  // Still `initiating`: the charger said "Accepted", which means it will try — not that it has
  // begun. Only StartTransaction moves it to `active`, which is why the API answers 202.
  return toPublicChargingSession(session);
}

/**
 * Resolve the optional vehicle, and refuse one that physically cannot use the plug.
 *
 * 422 rather than 409: the request is well-formed and the connector is free, but a CHAdeMO car
 * at a CCS2 plug is a semantic impossibility. This is the first use of the shared
 * CONNECTOR_TYPES enum that Module 5 created for exactly this comparison.
 */
async function resolveVehicle(
  actor: AuthUser,
  vehicleId: string | null,
  connectorType: string,
): Promise<Types.ObjectId | null> {
  if (!vehicleId) return null;

  // Owner-scoped: a driver may only attach their OWN car to a session.
  const vehicle = await Vehicle.findOne(applyOwnerScope(actor, { _id: vehicleId }));
  if (!vehicle) throw ApiError.notFound('Vehicle not found.');

  if (vehicle.connectorType !== connectorType) {
    throw ApiError.validation('This vehicle cannot use this connector type.', {
      vehicleConnectorType: vehicle.connectorType,
      connectorType,
    });
  }

  return vehicle._id;
}

async function markFailed(
  session: ChargingSessionDocument,
  stopReason: 'Rejected' | 'StartTimeout',
  failureReason: string,
): Promise<void> {
  session.status = 'failed';
  session.endedAt = new Date();
  session.stopReason = stopReason;
  session.failureReason = failureReason.slice(0, 200);
  await session.save();
}

/* -------------------------------------------------------------------------- */
/* Stop                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Stop a charging session.
 *
 * ONE endpoint serves two audiences, because they are the same operation with different
 * scopes — not two features:
 *
 *   driver            stops their OWN session          (owner scope)
 *   operator / CPO    force-stops one at THEIR station (company scope)
 *
 * The operator case is what replaced Module 6's raw remote-stop command, and it is strictly
 * better: it is session-aware, so stopping updates the record instead of silently ending a
 * charge the database still believes is running. It is also the operator's second write in the
 * project, and it follows Module 6's reasoning exactly — dealing with a stuck charge at a
 * station is literally the job.
 *
 * Note what this does NOT do: it does not mark the session completed. Only the charger's
 * StopTransaction can do that, because only the charger knows the final meter reading. This
 * moves it to `stopping` and waits.
 */
export async function stopSession(
  actor: AuthUser,
  sessionId: string,
): Promise<PublicChargingSession> {
  const session = await ChargingSession.findOne(
    applySessionReadScope(actor, { _id: sessionId }),
  );
  if (!session) throw sessionNotFound(actor);

  if (session.status === 'completed' || session.status === 'failed') {
    throw ApiError.conflict(`This session has already ended (${session.status}).`);
  }

  if (session.status === 'initiating') {
    // Nothing to stop at the charger — it never confirmed a transaction to stop. Fail it here
    // rather than making the driver wait out the sweeper.
    await markFailed(session, 'StartTimeout', 'Cancelled before the charger confirmed the start.');
    return toPublicChargingSession(session);
  }

  if (session.status === 'stopping') {
    // Already asked. Repeating the command would be harmless but pointless.
    return toPublicChargingSession(session);
  }

  const charger = await Charger.findById(session.chargerId).select('ocppId');
  const connection = charger ? registry.get(charger.ocppId) : undefined;

  if (!connection) {
    // The charger vanished mid-session. There is nothing to send a stop to, so close the
    // record out now with the energy we have rather than leaving it open forever.
    session.status = 'failed';
    session.endedAt = new Date();
    session.endMeterWh = session.lastMeterWh;
    session.energyConsumedWh = Math.max(
      0,
      Number(((session.lastMeterWh ?? 0) - (session.startMeterWh ?? 0)).toFixed(2)),
    );
    session.stopReason = 'ChargerDisconnected';
    session.failureReason = 'The charger was offline when the stop was requested.';
    await session.save();

    return toPublicChargingSession(session);
  }

  if (session.transactionId === null) {
    throw ApiError.conflict('This session has no confirmed transaction to stop.');
  }

  try {
    const response = await sendRemoteStop(connection, session.transactionId);
    if (response.status !== 'Accepted') {
      throw ApiError.conflict('The charger rejected the stop request.');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error(SCOPE, `RemoteStop failed for session ${String(session._id)}`, error);
    throw ApiError.conflict('The charger did not respond to the stop request.');
  }

  session.status = 'stopping';
  await session.save();

  logger.info(SCOPE, `Session ${String(session._id)} stopping (requested by ${actor.role})`);

  return toPublicChargingSession(session);
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export async function listSessions(
  actor: AuthUser,
  query: ListSessionsQuery,
): Promise<Paginated<PublicChargingSession>> {
  const filter: Record<string, unknown> = {};

  if (query.status) filter.status = query.status as SessionStatus;
  if (query.stationId) filter.stationId = new Types.ObjectId(query.stationId);
  if (query.chargerId) filter.chargerId = new Types.ObjectId(query.chargerId);

  // super_admin only: everyone else already has their company pinned by the scope below, and
  // a companyId filter from a scoped caller would be silently overridden anyway.
  if (query.companyId && actor.role === ROLES.SUPER_ADMIN) {
    filter.companyId = new Types.ObjectId(query.companyId);
  }

  if (query.active === true) filter.status = { $in: OPEN_SESSION_STATUSES };

  const scoped = applySessionReadScope(actor, filter);

  const page = query.page ?? 1;
  const limit = query.limit ?? 20;

  const [items, total] = await Promise.all([
    ChargingSession.find(scoped)
      // requestedAt rather than startedAt: an `initiating` session has no startedAt yet, and
      // sorting on a null would bury the one the driver is waiting on at the bottom.
      .sort({ requestedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    ChargingSession.countDocuments(scoped),
  ]);

  return {
    items: items.map(toPublicChargingSession),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

export async function getSessionById(
  actor: AuthUser,
  sessionId: string,
): Promise<PublicChargingSession> {
  const session = await ChargingSession.findOne(applySessionReadScope(actor, { _id: sessionId }));
  if (!session) throw sessionNotFound(actor);

  return toPublicChargingSession(session);
}

/**
 * The energy curve for one session.
 *
 * Scoped through the SESSION, not the readings. A MeterReading has no owner of its own — it is
 * reachable only by proving access to its parent first, the same nested-ownership rule that
 * put connectors under `/chargers/:chargerId/connectors` in Module 5.
 */
export async function listSessionReadings(
  actor: AuthUser,
  sessionId: string,
  limit = 500,
): Promise<PublicMeterReading[]> {
  const session = await ChargingSession.findOne(
    applySessionReadScope(actor, { _id: sessionId }),
  ).select('_id');
  if (!session) throw sessionNotFound(actor);

  const readings = await MeterReading.find({ sessionId: session._id })
    .sort({ meterTimestamp: 1 })
    .limit(limit);

  return readings.map(toPublicMeterReading);
}

/**
 * The driver's one open session, if any.
 *
 * Exists because the app's home screen needs exactly this question answered on every load, and
 * making it fetch a list and filter client-side would send it sessions it does not need.
 */
export async function getActiveSessionForDriver(
  actor: AuthUser,
): Promise<PublicChargingSession | null> {
  const session = await ChargingSession.findOne(
    applyOwnerScope(actor, { status: { $in: OPEN_SESSION_STATUSES } }),
  ).sort({ requestedAt: -1 });

  return session ? toPublicChargingSession(session) : null;
}
