/**
 * Inbound OCPP message handlers — one function per action.
 *
 * This is the ONLY place where protocol vocabulary is translated into our domain. OCPP sends
 * PascalCase status values like `Charging`; our database stores lowercase `charging`. Keeping
 * that mapping here is the whole reason the domain model never adopted OCPP's names: the
 * protocol is an integration detail, and the gateway is the boundary.
 *
 * Each handler returns the payload for a CALLRESULT, or throws `OcppError` to produce a
 * CALLERROR. Neither outcome ever closes the socket — a charger that sends one bad message
 * stays connected.
 */

import { Charger } from '../models/charger.model';
import { Connector } from '../models/connector.model';
import type { ConnectorStatus } from '../constants/connector';
import { logger } from '../utils/logger';
import {
  OcppError,
  OcppErrorCode,
  ocppNow,
  type OcppPayload,
} from './messages';
import { allocateTransactionId, setTransaction, touchHeartbeat, type ChargerConnection } from './registry';
import * as sessionEvents from '../services/sessionEvents.service';

const SCOPE = 'ocpp';

/** How often the charger should send a Heartbeat, in seconds. Told to it at boot. */
export const HEARTBEAT_INTERVAL_SECONDS = 30;

/**
 * OCPP 1.6 connector status -> our domain status.
 *
 * `SuspendedEV`, `SuspendedEVSE` and `Reserved` all collapse to `occupied`: a car is present
 * and the plug is not free, which is what our model actually cares about. Preserving the
 * distinction would mean domain values with no consumer.
 */
const STATUS_MAP: Record<string, ConnectorStatus> = {
  Available: 'available',
  Preparing: 'preparing',
  Charging: 'charging',
  Finishing: 'finishing',
  Faulted: 'faulted',
  Unavailable: 'unavailable',
  SuspendedEV: 'occupied',
  SuspendedEVSE: 'occupied',
  Reserved: 'occupied',
};

function requireString(payload: OcppPayload, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new OcppError(
      OcppErrorCode.PROPERTY_CONSTRAINT_VIOLATION,
      `Missing or invalid "${field}"`,
      { field },
    );
  }
  return value;
}

function requireNumber(payload: OcppPayload, field: string): number {
  const value = payload[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new OcppError(
      OcppErrorCode.PROPERTY_CONSTRAINT_VIOLATION,
      `Missing or invalid "${field}"`,
      { field },
    );
  }
  return value;
}

/* -------------------------------------------------------------------------- */

/**
 * BootNotification — the charger's "hello, I'm here".
 *
 * Note what this does NOT do: it never creates a Charger record. The charger was already
 * verified to exist during the WebSocket upgrade, because auto-creating from an inbound
 * connection would let anyone register arbitrary hardware — and bypass company ownership
 * entirely.
 *
 * The response carries `interval` (how often to send Heartbeat) and, as a convenience for
 * our simulator, the charger's configured `powerKw` so it can generate realistic meter
 * values without duplicating configuration.
 */
export async function handleBootNotification(
  connection: ChargerConnection,
  payload: OcppPayload,
): Promise<OcppPayload> {
  const vendor = typeof payload.chargePointVendor === 'string' ? payload.chargePointVendor : 'unknown';
  const model = typeof payload.chargePointModel === 'string' ? payload.chargePointModel : 'unknown';

  logger.info(SCOPE, `BootNotification from ${connection.ocppId} (${vendor} ${model})`);

  const charger = await Charger.findByIdAndUpdate(
    connection.chargerId,
    { $set: { isOnline: true, lastHeartbeatAt: new Date() } },
    { new: true },
  );

  touchHeartbeat(connection.ocppId);

  return {
    status: 'Accepted',
    currentTime: ocppNow(),
    interval: HEARTBEAT_INTERVAL_SECONDS,
    // Simulation convenience, not part of real OCPP's BootNotification response.
    powerKw: charger?.powerKw ?? 0,
  };
}

/** Heartbeat — "still alive". Its ABSENCE is what detects a charger that vanished. */
export async function handleHeartbeat(connection: ChargerConnection): Promise<OcppPayload> {
  touchHeartbeat(connection.ocppId);

  await Charger.updateOne(
    { _id: connection.chargerId },
    { $set: { isOnline: true, lastHeartbeatAt: new Date() } },
  );

  return { currentTime: ocppNow() };
}

/**
 * StatusNotification — reported PER CONNECTOR by the hardware.
 *
 * This writes to Connector.status and NEVER to Charger.status. Those are different concerns:
 * Charger.status is administrative (a human put this machine in maintenance), Charger.isOnline
 * is connectivity, and Connector.status is operational. Conflating them is the easiest way to
 * corrupt this model.
 */
export async function handleStatusNotification(
  connection: ChargerConnection,
  payload: OcppPayload,
): Promise<OcppPayload> {
  const connectorNumber = requireNumber(payload, 'connectorId');
  const ocppStatus = requireString(payload, 'status');

  const mapped = STATUS_MAP[ocppStatus];
  if (!mapped) {
    throw new OcppError(OcppErrorCode.PROPERTY_CONSTRAINT_VIOLATION, `Unknown status "${ocppStatus}"`, {
      status: ocppStatus,
    });
  }

  const errorCode = typeof payload.errorCode === 'string' ? payload.errorCode : null;

  const result = await Connector.updateOne(
    { chargerId: connection.chargerId, connectorNumber },
    { $set: { status: mapped, errorCode: errorCode === 'NoError' ? null : errorCode } },
  );

  if (result.matchedCount === 0) {
    // The charger reported a connector we have no record of. Not fatal — log it and accept,
    // because refusing would leave real hardware retrying forever over a data-entry gap.
    logger.warn(
      SCOPE,
      `StatusNotification for unknown connector ${connectorNumber} on ${connection.ocppId}`,
    );
  } else {
    logger.info(SCOPE, `StatusNotification ${connection.ocppId} connector ${connectorNumber}: ${ocppStatus}`);
  }

  return {};
}

/**
 * Authorize - "may this token draw power from this charger?"
 *
 * This is NOT user login. It is the hardware asking, on behalf of whoever tapped an RFID card
 * or was named in a RemoteStartTransaction, whether that credential is allowed. No session, no
 * password, and the driver never types anything.
 *
 * MODULE 7 MADE THIS REAL. Module 6 accepted any well-formed tag, because there was nothing to
 * check a tag against. Now every tag is minted by a specific ChargingSession and is valid only
 * while that session is open - so a charger cannot authorise a charge nobody requested, and a
 * tag captured from the wire is worthless once the session it belonged to has ended.
 */
export async function handleAuthorize(
  connection: ChargerConnection,
  payload: OcppPayload,
): Promise<OcppPayload> {
  const idTag = requireString(payload, 'idTag');
  const isValid = await sessionEvents.authorizeIdTag(idTag);

  logger.info(SCOPE, `Authorize ${connection.ocppId} idTag=${idTag} -> ${isValid ? 'Accepted' : 'Invalid'}`);

  return { idTagInfo: { status: isValid ? 'Accepted' : 'Invalid' } };
}

/**
 * StartTransaction - "I have begun charging".
 *
 * THE INVARIANT THIS PROTECTS: no energy flows without a session describing it.
 *
 * A start we cannot match to an `initiating` session is REFUSED - we still answer with a
 * transactionId, because OCPP 1.6 requires the field, but `idTagInfo.status` is `Invalid`,
 * which tells the charge point it is not authorised and that it should stop. That covers
 * somebody walking up and starting a charge locally with an RFID card we never issued.
 *
 * Refusing rather than quietly creating a session is the deliberate choice. A session needs an
 * owner to bill, and there is nobody to attribute a walk-up charge to.
 */
export async function handleStartTransaction(
  connection: ChargerConnection,
  payload: OcppPayload,
): Promise<OcppPayload> {
  const connectorNumber = requireNumber(payload, 'connectorId');
  const idTag = requireString(payload, 'idTag');
  const meterStartWh = requireNumber(payload, 'meterStart');

  const outcome = await sessionEvents.onStartTransaction(
    {
      chargerId: connection.chargerId,
      connectorNumber,
      idTag,
      meterStartWh,
      timestamp: payload.timestamp,
    },
    allocateTransactionId,
  );

  if (!outcome.accepted || !outcome.session || outcome.session.transactionId === null) {
    logger.warn(
      SCOPE,
      `StartTransaction refused on ${connection.ocppId}: ${outcome.reason ?? 'no matching session'}`,
    );

    // The protocol still wants a number. Allocating a throwaway one is safer than returning 0,
    // which some charge points treat as a valid id.
    return { transactionId: allocateTransactionId(), idTagInfo: { status: 'Invalid' } };
  }

  const transactionId = outcome.session.transactionId;

  // The registry copy is the gateway own bookkeeping, used to match a later StopTransaction on
  // this socket. The database row is the record of truth; this is scratch state.
  setTransaction(connection.ocppId, {
    transactionId,
    connectorNumber,
    idTag,
    meterStartWh,
    startedAt: new Date(),
  });

  logger.info(
    SCOPE,
    `StartTransaction ${connection.ocppId} connector ${connectorNumber} -> transaction ${transactionId}`,
  );

  return { transactionId, idTagInfo: { status: 'Accepted' } };
}

/**
 * MeterValues - periodic energy readings during charging.
 *
 * Module 6 logged these and threw them away. Module 7 persists every one, because the readings
 * ARE the evidence: the live graph in Module 8, the bill in Module 10 and the answer to a
 * billing dispute in Module 11 all come from this stream, not from one final number.
 *
 * A reading that is rejected - duplicate, stale, or against a session that has already ended -
 * still gets an empty CALLRESULT rather than a CALLERROR. Chargers resend, and a charger that
 * buffered readings while offline replays its whole backlog on reconnect. Answering with an
 * error for expected traffic would make a healthy charger look broken.
 */
export async function handleMeterValues(
  connection: ChargerConnection,
  payload: OcppPayload,
): Promise<OcppPayload> {
  const energyWh = requireNumber(payload, 'energyWh');

  const transactionId =
    typeof payload.transactionId === 'number'
      ? payload.transactionId
      : connection.transaction?.transactionId ?? null;

  if (transactionId === null) {
    logger.warn(SCOPE, `MeterValues from ${connection.ocppId} with no transaction - ignored`);
    return {};
  }

  const outcome = await sessionEvents.onMeterValues({
    transactionId,
    energyWh,
    powerKw: typeof payload.powerKw === 'number' ? payload.powerKw : null,
    socPercent: typeof payload.socPercent === 'number' ? payload.socPercent : null,
    timestamp: payload.timestamp,
  });

  if (outcome.stored) {
    logger.info(
      SCOPE,
      `MeterValues ${connection.ocppId} transaction ${transactionId}: ${(energyWh / 1000).toFixed(3)} kWh`,
    );
  } else {
    logger.warn(
      SCOPE,
      `MeterValues ${connection.ocppId} transaction ${transactionId} dropped: ${outcome.reason ?? 'unknown'}`,
    );
  }

  return {};
}

/**
 * StopTransaction - the mirror of StartTransaction, carrying the final meter reading.
 *
 * This is where energy is FINALISED, and it is the only thing that can mark a session
 * `completed`. Not the driver pressing stop, not the operator force-stopping: those only ask.
 * Until the charger reports the closing counter value, nobody knows how much was delivered.
 */
export async function handleStopTransaction(
  connection: ChargerConnection,
  payload: OcppPayload,
): Promise<OcppPayload> {
  const meterStopWh = requireNumber(payload, 'meterStop');

  const transactionId =
    typeof payload.transactionId === 'number'
      ? payload.transactionId
      : connection.transaction?.transactionId ?? null;

  if (transactionId !== null) {
    const session = await sessionEvents.onStopTransaction({
      transactionId,
      meterStopWh,
      reason: payload.reason,
      timestamp: payload.timestamp,
    });

    if (session) {
      logger.info(
        SCOPE,
        `StopTransaction ${connection.ocppId} transaction ${transactionId}: ` +
          `${(session.energyConsumedWh / 1000).toFixed(3)} kWh consumed`,
      );
    }
  } else {
    logger.warn(SCOPE, `StopTransaction from ${connection.ocppId} with no transaction id`);
  }

  setTransaction(connection.ocppId, null);

  return { idTagInfo: { status: 'Accepted' } };
}

/* -------------------------------------------------------------------------- */

type Handler = (connection: ChargerConnection, payload: OcppPayload) => Promise<OcppPayload>;

/**
 * The supported action set. Anything else gets a CALLERROR `NotSupported` — which is the
 * correct OCPP response, and far better than closing the connection over an action we simply
 * chose not to implement.
 */
export const HANDLERS: Record<string, Handler> = {
  BootNotification: handleBootNotification,
  Heartbeat: handleHeartbeat,
  StatusNotification: handleStatusNotification,
  Authorize: handleAuthorize,
  StartTransaction: handleStartTransaction,
  MeterValues: handleMeterValues,
  StopTransaction: handleStopTransaction,
};
