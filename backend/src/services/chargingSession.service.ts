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
import { Company } from '../models/company.model';
import { Station } from '../models/station.model';
import { Vehicle } from '../models/vehicle.model';
import { User } from '../models/user.model';
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
import { describeSession, sessionRef } from '../utils/logLabels';
import { formatPaise } from '../utils/money';
import * as realtime from '../realtime/publisher';
import { rememberSessionLabels } from '../realtime/sessionLabels';
import { lastEvidenceOfCharging } from '../utils/sessionEnd';
import * as notify from './notification.service';
import { sendRemoteStart, sendRemoteStop } from '../ocpp/commands';
import * as registry from '../ocpp/registry';
import { findActiveTariffForCompany } from './tariff.service';
import { assessArrears } from './payment.service';
import type { Paginated } from '../types/pagination';
import type { AuthUser } from '../types/express';
import type { StartSessionInput, ListSessionsQuery } from '../validators/session.validator';

const SCOPE = 'session';

const DUPLICATE_KEY = 11000;

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(error) && (error as { code?: number }).code === DUPLICATE_KEY;
}

/** Which unique index refused the insert — the connector one and the driver one mean different things. */
function duplicateKeyField(error: unknown): string | null {
  const pattern = (error as { keyPattern?: Record<string, unknown> }).keyPattern;
  return pattern ? (Object.keys(pattern)[0] ?? null) : null;
}

/**
 * The refusal a driver gets when they already have a charge running.
 *
 * Carries the running session's id so the app can LINK to it. The old behaviour was a silent
 * redirect to the other session, which left the driver wondering what had just happened.
 */
async function alreadyChargingError(existing: ChargingSessionDocument): Promise<ApiError> {
  const [station, charger] = await Promise.all([
    Station.findById(existing.stationId).select('name').lean(),
    Charger.findById(existing.chargerId).select('name').lean(),
  ]);

  const where = [station?.name, charger && `${charger.name} connector ${existing.connectorNumber}`]
    .filter(Boolean)
    .join(', ');

  return ApiError.conflict(
    `You already have a charge in progress${where ? ` at ${where}` : ''}. ` +
      'Stop it or let it finish before starting another — one account charges one car at a time.',
    { activeSessionId: String(existing._id) },
  );
}

/* -------------------------------------------------------------------------- */
/* Display labels                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Attach the human names a session screen needs — operator, station, charger, and for staff the
 * driver — with ONE query per collection for the whole page, never one per row.
 *
 * Resolved at READ time, not snapshotted. The billing snapshots (rate, AC/DC, plug) are frozen
 * because they decide money; a station's display name decides nothing, and a renamed site should
 * read with its current name everywhere.
 *
 * The operator (company) NAME goes to drivers too. It is the brand on the charger — OCPI publishes
 * it as a Location's `operator` to every roaming app — and it is who a driver contacts when
 * something goes wrong. What stays internal is the company's id and records, not its name.
 */
async function withSessionLabels(
  actor: AuthUser,
  sessions: ChargingSessionDocument[],
  includeDriver = actor.role !== ROLES.DRIVER,
): Promise<PublicChargingSession[]> {
  if (sessions.length === 0) return [];

  const ids = (key: 'companyId' | 'stationId' | 'chargerId' | 'userId') => [
    ...new Set(sessions.map((s) => String(s[key]))),
  ];
  const isStaff = includeDriver;

  const [companies, stations, chargers, drivers] = await Promise.all([
    Company.find({ _id: { $in: ids('companyId') } }).select('name').lean(),
    Station.find({ _id: { $in: ids('stationId') } }).select('name address city').lean(),
    Charger.find({ _id: { $in: ids('chargerId') } }).select('name powerKw').lean(),
    isStaff ? User.find({ _id: { $in: ids('userId') } }).select('name email').lean() : [],
  ]);

  const companyById = new Map(companies.map((c) => [String(c._id), c]));
  const stationById = new Map(stations.map((s) => [String(s._id), s]));
  const chargerById = new Map(chargers.map((c) => [String(c._id), c]));
  const driverById = new Map(drivers.map((d) => [String(d._id), d]));

  return sessions.map((session) => {
    const station = stationById.get(String(session.stationId));
    const charger = chargerById.get(String(session.chargerId));
    const driver = driverById.get(String(session.userId));

    return {
      ...toPublicChargingSession(session),
      companyName: companyById.get(String(session.companyId))?.name ?? null,
      stationName: station?.name ?? null,
      stationAddress: station?.address ?? null,
      stationCity: station?.city ?? null,
      chargerName: charger?.name ?? null,
      powerKw: charger?.powerKw ?? null,
      ...(isStaff ? { driverName: driver?.name ?? null, driverEmail: driver?.email ?? null } : {}),
    };
  });
}

async function withSessionLabel(
  actor: AuthUser,
  session: ChargingSessionDocument,
): Promise<PublicChargingSession> {
  const [labelled] = await withSessionLabels(actor, [session]);
  return labelled;
}

interface StopAttribution {
  role: AuthUser['role'];
  note: string | null;
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
  /**
   * What the MACHINE says about itself, separate from the plug's own `status` above.
   *
   * Surfaced to the driver because the two disagree in exactly the case that matters: a plug
   * reading `available` on a charge point reporting a fault. Showing only the plug would put a
   * Start button under a machine that has already said it cannot charge anything.
   */
  chargerHardwareStatus: string;
  chargerFaultCode: string | null;
  stationName: string;
  stationAddress: string;
  /**
   * MODULE 9 — what this plug costs, in integer paise per kWh.
   *
   * Answered HERE rather than by a driver-facing tariff endpoint. This lookup already exists to
   * tell a driver whether they can start; the price is the other half of that same question, and
   * a second endpoint returning the same number would be duplicate surface.
   *
   * Null when the operator has published no price — in which case `canStart` is false too.
   */
  pricePerKwhPaise: number | null;
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

  const { canStart, reason } = assessStartability(
    connector.status,
    charger.status,
    charger.isOnline,
    charger.hardwareStatus,
    charger.faultCode,
  );

  // At most one can match — the partial unique index guarantees it.
  const tariff = await findActiveTariffForCompany(charger.companyId);

  // No published price means no charging, so the verdict has to account for it as well as the
  // four hardware states. Checked after them so a faulted plug reports the hardware fault,
  // which is what a driver standing in front of it actually needs to hear.
  const priced = Boolean(tariff);

  return {
    connectorId: String(connector._id),
    connectorNumber: connector.connectorNumber,
    connectorType: connector.connectorType,
    status: connector.status,
    chargerId: String(charger._id),
    chargerName: charger.name,
    powerKw: charger.powerKw,
    isOnline: charger.isOnline,
    chargerHardwareStatus: charger.hardwareStatus,
    chargerFaultCode: charger.faultCode ?? null,
    stationName: station.name,
    stationAddress: station.address,
    pricePerKwhPaise: tariff ? tariff.pricePerKwhPaise : null,
    canStart: canStart && priced,
    unavailableReason: reason ?? (priced ? null : 'This operator has not published a price yet.'),
  };
}

/**
 * The four independent reasons a plug cannot be used, checked in the order a driver would
 * care about them.
 *
 * ALL FOUR STATE MACHINES ARE CONSULTED, and that is the point. `Charger.status` is
 * administrative (a human put this machine into maintenance), `Charger.isOnline` is
 * connectivity, `Charger.hardwareStatus` is what the MACHINE says about itself, and
 * `Connector.status` is what it last reported about this particular plug.
 *
 * Every combination is real. A charger can be administratively fine but unreachable; reachable
 * with one faulted plug and one good one; or online, available and reporting a ground fault in
 * its own power stage while both plugs still read `available` — the last of these is exactly
 * the case that used to slip through, because the gateway had nowhere to put a fault the
 * machine reported about ITSELF. One boolean could never have expressed any of it, which is
 * why these four fields were kept apart, and this function is the only place all four are read
 * together.
 *
 * ORDER IS THE MESSAGE. The hardware fault is checked before the plug, because "this charger
 * has a fault" is more useful to someone standing in front of it than "this connector is
 * available" — which would be true, and useless.
 */
function assessStartability(
  connectorStatus: string,
  chargerStatus: string,
  isOnline: boolean,
  hardwareStatus: string,
  faultCode: string | null,
): { canStart: boolean; reason: string | null } {
  if (chargerStatus !== 'available') {
    return { canStart: false, reason: `This charger is ${chargerStatus}.` };
  }
  if (!isOnline) {
    return { canStart: false, reason: 'This charger is not currently connected.' };
  }
  if (hardwareStatus === 'faulted') {
    return {
      canStart: false,
      reason: `This charger has reported a fault${faultCode ? ` (${faultCode})` : ''}.`,
    };
  }
  if (hardwareStatus === 'unavailable') {
    return { canStart: false, reason: 'This charger has taken itself out of service.' };
  }
  if (connectorStatus === 'faulted' || connectorStatus === 'unavailable') {
    return { canStart: false, reason: `This connector is ${connectorStatus}.` };
  }
  if (connectorStatus === 'charging' || connectorStatus === 'occupied') {
    return { canStart: false, reason: 'This connector is already in use.' };
  }
  return { canStart: true, reason: null };
}

/**
 * Every plug at one station, in the same shape the QR-code lookup returns.
 *
 * WHY THIS EXISTS. Until now the only way to reach a connector was to already know its id —
 * fine for a QR code printed on the plug, useless for a driver looking at a map. The map
 * could say "3 of 6 available" but could not say WHICH three, so the last step of the journey
 * had no route: a driver who had found a station still had to be handed an id out of band.
 *
 * Same view model as `getConnectorForCharging` on purpose. A driver comparing plugs on a
 * screen and a driver standing in front of one are asking the same question, and two shapes
 * for one question is how they drift.
 *
 * NOT company-scoped, for the same reason the single lookup is not: public charging is
 * public. Authentication still applies.
 */
export async function listConnectorsForChargingAtStation(
  stationId: string,
): Promise<ConnectorChargingView[]> {
  const station = await Station.findById(stationId);
  if (!station) throw ApiError.notFound('Station not found.');

  const chargers = await Charger.find({ stationId: station._id });
  if (chargers.length === 0) return [];

  const connectors = await Connector.find({
    chargerId: { $in: chargers.map((c) => c._id) },
  });

  /*
   * One tariff lookup per COMPANY, not per connector. Every charger at a station belongs to
   * the same operator in practice, but resolving by company rather than assuming it keeps
   * this correct if that ever stops being true — and it is still one query either way.
   */
  const tariffByCompany = new Map<string, number | null>();
  for (const companyId of new Set(chargers.map((c) => String(c.companyId)))) {
    const tariff = await findActiveTariffForCompany(new Types.ObjectId(companyId));
    tariffByCompany.set(companyId, tariff ? tariff.pricePerKwhPaise : null);
  }

  const chargerById = new Map(chargers.map((c) => [String(c._id), c]));

  const views: ConnectorChargingView[] = [];

  for (const connector of connectors) {
    const charger = chargerById.get(String(connector.chargerId));
    if (!charger) continue;

    const { canStart, reason } = assessStartability(
      connector.status,
      charger.status,
      charger.isOnline,
      charger.hardwareStatus,
      charger.faultCode,
    );

    const pricePerKwhPaise = tariffByCompany.get(String(charger.companyId)) ?? null;
    const priced = pricePerKwhPaise !== null;

    views.push({
      connectorId: String(connector._id),
      connectorNumber: connector.connectorNumber,
      connectorType: connector.connectorType,
      status: connector.status,
      chargerId: String(charger._id),
      chargerName: charger.name,
      powerKw: charger.powerKw,
      isOnline: charger.isOnline,
      chargerHardwareStatus: charger.hardwareStatus,
      chargerFaultCode: charger.faultCode ?? null,
      stationName: station.name,
      stationAddress: station.address,
      pricePerKwhPaise,
      canStart: canStart && priced,
      unavailableReason: reason ?? (priced ? null : 'This operator has not published a price yet.'),
    });
  }

  /*
   * Startable plugs first, then by charger and plug number. A driver scanning this list wants
   * the ones they can actually use at the top; the rest still appear, because "why not" is
   * the next question and hiding them only prompts it.
   */
  return views.sort(
    (a, b) =>
      Number(b.canStart) - Number(a.canStart) ||
      a.chargerName.localeCompare(b.chargerName) ||
      a.connectorNumber - b.connectorNumber,
  );
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
  /*
   * ONE CHARGE PER DRIVER — checked FIRST, before anything about the plug.
   *
   * A driver already charging who taps Start on the free plug next to them is not asking "is
   * this plug usable?" — they are making a mistake the platform should name. A hardware verdict
   * first would be true and beside the point. The partial unique index
   * `one_open_session_per_driver` holds the line when two taps race past this check.
   */
  const running = await ChargingSession.findOne(
    applyOwnerScope(actor, { status: { $in: OPEN_SESSION_STATUSES } }),
  );
  if (running) throw await alreadyChargingError(running);

  const connector = await Connector.findById(input.connectorId);
  if (!connector) throw ApiError.notFound('Connector not found.');

  const charger = await Charger.findById(connector.chargerId);
  if (!charger) throw ApiError.notFound('Connector not found.');

  const { canStart, reason } = assessStartability(
    connector.status,
    charger.status,
    charger.isOnline,
    charger.hardwareStatus,
    charger.faultCode,
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

  /*
   * MODULE 9 PRECONDITION (flagged addition to Module 7's start flow).
   *
   * No price, no charge. If the station's company has no active tariff we refuse the start
   * outright rather than letting a car draw power that cannot be priced. Allowing it would
   * hand Module 10 a completed session with an undefined amount - a record it can neither
   * settle nor explain.
   *
   * With the partial unique index on Tariff this is the ONLY place "no tariff" can surface:
   * at most one active tariff can exist per company, so there is no ambiguity at completion
   * time, only this precondition at the start.
   */
  const tariff = await findActiveTariffForCompany(charger.companyId);

  if (!tariff) {
    throw ApiError.conflict(
      'Charging is unavailable at this station: its operator has not published a price.',
      { companyId: String(charger.companyId) },
    );
  }

  /*
   * MODULE 10 PRECONDITION — no credit. Checked LAST of the preconditions, and that ordering
   * is deliberate: "this connector is broken" and "this station has no price" are facts about
   * the world, while this one is a fact about the driver. Telling somebody they owe money for
   * a charger that was never going to work anyway is the wrong answer to the wrong question.
   *
   * WHY THE START PATH AND NOT THE STOP PATH. A session already running is never interrupted
   * over money — cutting power to a car mid-charge to collect a debt is both hostile and
   * pointless, since the energy already delivered is already owed. The gate belongs at the
   * only moment where refusing costs nothing.
   *
   * SELF-CLEARING. A top-up runs `settleOutstandingForUser`, which pays the debt down, which
   * drops this below the threshold. The driver is never stuck waiting for an operator.
   */
  const arrears = await assessArrears(actor.id);

  if (arrears.blocked) {
    logger.warn(
      SCOPE,
      `Start refused for ${actor.email}: ${arrears.unpaidSessions} unpaid session(s), ` +
        `${formatPaise(arrears.outstandingPaise)} outstanding`,
    );

    throw ApiError.conflict(arrears.reason ?? 'Settle your outstanding balance to start charging.', {
      outstandingPaise: arrears.outstandingPaise,
      unpaidSessions: arrears.unpaidSessions,
    });
  }

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
      // Snapshots of the hardware actually used — a session must still say "DC, CCS2" after
      // the charger is reconfigured, exactly like the price below.
      chargerType: charger.chargerType,
      connectorType: connector.connectorType,
      idTag,
      status: 'initiating',
      requestedAt: new Date(),

      /*
       * THE RATE IS SNAPSHOTTED HERE, at start, not read at completion.
       *
       * Copying the VALUE means an admin editing or deactivating this tariff while the car is
       * charging cannot reprice a session already in progress. A `tariffId` reference alone
       * would leave the price of a running charge at the mercy of whoever edits the price
       * sheet next.
       *
       * The id is kept beside it as PROVENANCE - "which price sheet said so" - for Module 11's
       * billing disputes. The snapshot prices the session; the id explains it. Neither one
       * replaces the other.
       */
      appliedTariffId: tariff._id,
      appliedPricePerKwhPaise: tariff.pricePerKwhPaise,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      if (duplicateKeyField(error) === 'userId') {
        // Two taps from the same driver raced past the check at the top.
        const existing = await ChargingSession.findOne(
          applyOwnerScope(actor, { status: { $in: OPEN_SESSION_STATUSES } }),
        );
        if (existing) throw await alreadyChargingError(existing);
      }
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
    logger.error(
      SCOPE,
      `Start request got no answer from ${await describeSession(session)} ${sessionRef(session)}`,
      error,
    );
    throw ApiError.conflict('The charger did not respond to the start request.');
  }

  logger.info(
    SCOPE,
    `Start requested on ${await describeSession(session)} — waiting for the charger to confirm ` +
      sessionRef(session),
  );

  // Resolve the names once, now, so every later push about this session can carry them.
  // Driver name included: these labels ride on pushes to the company's staff room too.
  const labelled = await withSessionLabels(actor, [session], true);
  const first = labelled[0];
  rememberSessionLabels(String(session._id), {
    companyName: first.companyName ?? null,
    stationName: first.stationName ?? null,
    stationAddress: first.stationAddress ?? null,
    stationCity: first.stationCity ?? null,
    chargerName: first.chargerName ?? null,
    powerKw: first.powerKw ?? null,
    driverName: first.driverName ?? null,
    driverEmail: first.driverEmail ?? null,
  });

  // The staff dashboard should see a session appear the moment it is requested, not only once
  // the charger confirms - an `initiating` row that never turns active is exactly the thing an
  // operator needs to notice.
  realtime.emitSessionStatus(toPublicChargingSession(session));

  // Still `initiating`: the charger said "Accepted", which means it will try — not that it has
  // begun. Only StartTransaction moves it to `active`, which is why the API answers 202.
  return withSessionLabel(actor, session);
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
  stoppedBy: StopAttribution | null = null,
): Promise<void> {
  session.status = 'failed';
  session.endedAt = new Date();
  session.stopReason = stopReason;
  session.failureReason = failureReason.slice(0, 200);
  if (stoppedBy) {
    session.stoppedByRole = stoppedBy.role;
    session.stopNote = stoppedBy.note;
  }
  await session.save();

  realtime.emitSessionStatus(toPublicChargingSession(session));
  void notify.sessionFailed(session);
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
  reason?: string,
): Promise<PublicChargingSession> {
  const session = await ChargingSession.findOne(
    applySessionReadScope(actor, { _id: sessionId }),
  );
  if (!session) throw sessionNotFound(actor);

  if (session.status === 'completed' || session.status === 'failed') {
    throw ApiError.conflict(`This session has already ended (${session.status}).`);
  }

  /*
   * A FORCE-STOP MUST SAY WHY. Ending someone else's charge is an intervention in their day —
   * they may be counting on that range — and "why did my charge stop?" is the first thing they
   * will ask. The reason goes on the session and into their notification. A driver stopping their
   * own charge owes nobody an explanation.
   */
  const isForceStop = actor.role !== ROLES.DRIVER;
  const note = reason?.trim() || null;

  if (isForceStop && !note) {
    throw ApiError.validation(
      "Give a reason for stopping this driver's charge — they are notified and will see it.",
    );
  }

  const attribution: StopAttribution = { role: actor.role, note: isForceStop ? note : null };

  if (session.status === 'initiating') {
    // Nothing to stop at the charger — it never confirmed a transaction to stop. Fail it here
    // rather than making the driver wait out the sweeper.
    await markFailed(
      session,
      'StartTimeout',
      isForceStop
        ? `Cancelled by the station operator: ${note}`
        : 'Cancelled before the charger confirmed the start.',
      attribution,
    );
    return withSessionLabel(actor, session);
  }

  if (session.status === 'stopping') {
    // Already asked. Repeating the command would be harmless but pointless.
    return withSessionLabel(actor, session);
  }

  const charger = await Charger.findById(session.chargerId).select('ocppId');
  const connection = charger ? registry.get(charger.ocppId) : undefined;

  if (!connection) {
    // The charger vanished mid-session. There is nothing to send a stop to, so close the
    // record out now with the energy we have rather than leaving it open forever.
    session.status = 'failed';
    session.endedAt = await lastEvidenceOfCharging(session);
    session.endMeterWh = session.lastMeterWh;
    session.energyConsumedWh = Math.max(
      0,
      Number(((session.lastMeterWh ?? 0) - (session.startMeterWh ?? 0)).toFixed(2)),
    );
    session.stopReason = 'ChargerDisconnected';
    session.failureReason = 'The charger was offline when the stop was requested.';
    session.stoppedByRole = attribution.role;
    session.stopNote = attribution.note;
    await session.save();

    realtime.emitSessionStatus(toPublicChargingSession(session));
    void notify.sessionFailed(session);

    return withSessionLabel(actor, session);
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
    logger.error(
      SCOPE,
      `Stop request got no answer from ${await describeSession(session)} ${sessionRef(session)}`,
      error,
    );
    throw ApiError.conflict('The charger did not respond to the stop request.');
  }

  session.status = 'stopping';
  // Recorded now, while we know who asked. StopTransaction arrives later carrying no actor at all.
  session.stoppedByRole = attribution.role;
  session.stopNote = attribution.note;
  await session.save();

  logger.info(
    SCOPE,
    `Stop requested by ${actor.email} (${actor.role}) on ${await describeSession(session)} ` +
      sessionRef(session),
  );

  realtime.emitSessionStatus(toPublicChargingSession(session));

  return withSessionLabel(actor, session);
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

  // "AC or DC" and "which plug" are separate questions, answered by separate snapshots.
  if (query.chargerType) filter.chargerType = query.chargerType;
  if (query.connectorType) filter.connectorType = query.connectorType;

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
    items: await withSessionLabels(actor, items),
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

  return withSessionLabel(actor, session);
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

  /*
   * SPREAD OVER THE WHOLE CHARGE, never cut off. `.limit(500)` on an ascending sort returned the
   * first 500 readings, so any charge longer than ~40 minutes at a 5s tick drew a curve that
   * stopped part-way. Above the limit we thin evenly and always keep the first and last reading,
   * so the chart spans start to finish and ends on the energy actually billed.
   */
  const filter = { sessionId: session._id };
  const total = await MeterReading.countDocuments(filter);
  if (total <= limit) {
    return (await MeterReading.find(filter).sort({ meterTimestamp: 1 })).map(toPublicMeterReading);
  }

  const all = await MeterReading.find(filter).sort({ meterTimestamp: 1 });
  if (limit === 1) return [toPublicMeterReading(all[all.length - 1])];
  const step = (all.length - 1) / (limit - 1);
  const picked = Array.from({ length: limit }, (_, i) => all[Math.round(i * step)]);
  return picked.map(toPublicMeterReading);
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

  return session ? withSessionLabel(actor, session) : null;
}
