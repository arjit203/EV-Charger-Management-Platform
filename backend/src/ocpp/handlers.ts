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
import { CHARGE_POINT_STATUS_MAP } from '../constants/charger';
import type { ConnectorStatus } from '../constants/connector';
import { logger } from '../utils/logger';
import {
  OcppError,
  OcppErrorCode,
  ocppNow,
  type OcppPayload,
} from './messages';
import {
  allocateTransactionId,
  seedTransactionId,
  clearTransaction,
  findTransactionById,
  getTransactionByConnector,
  setTransaction,
  touchHeartbeat,
  type ChargerConnection,
} from './registry';
import * as sessionEvents from '../services/sessionEvents.service';
import * as notify from '../services/notification.service';
import * as realtime from '../realtime/publisher';

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
/**
 * OCPP 1.6 addresses the CHARGE POINT ITSELF with connectorId 0. There is no plug 0 — it is
 * how a machine reports something true of the whole box: ground failure, over-temperature, the
 * power module dead. Routed to `Charger.hardwareStatus`, never to a connector.
 */
const CHARGE_POINT_CONNECTOR_ID = 0;

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

  logger.info(
    SCOPE,
    `Charger ${connection.ocppId} started up and said hello — ${vendor} ${model} (BootNotification)`,
  );

  const charger = await Charger.findByIdAndUpdate(
    connection.chargerId,
    { $set: { isOnline: true, lastHeartbeatAt: new Date() } },
    { returnDocument: 'after' },
  );

  touchHeartbeat(connection.ocppId);

  // The online TRANSITION. BootNotification is the charger's first message after connecting,
  // so this is the moment `isOnline` actually flips - not every subsequent heartbeat.
  if (charger) {
    realtime.emitChargerConnectivity({
      chargerId: connection.chargerId,
      stationId: String(charger.stationId),
      companyId: connection.companyId,
      ocppId: connection.ocppId,
      isOnline: true,
      lastHeartbeatAt: charger.lastHeartbeatAt ? charger.lastHeartbeatAt.toISOString() : null,
    });
  }

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
 * StatusNotification — the hardware reporting operational state.
 *
 * TWO DESTINATIONS, chosen by `connectorId`, and getting this wrong is how a CPMS ends up
 * offering drivers a charger that has already announced it is broken:
 *
 *   connectorId >= 1   a PLUG        ->  Connector.status
 *   connectorId == 0   the MACHINE   ->  Charger.hardwareStatus
 *
 * Neither writes `Charger.status`. That field is administrative — what a human decided — and
 * the machine has no standing to overwrite a person's decision. Connectivity lives in
 * `isOnline`. Four fields, four owners; conflating them is the easiest way to corrupt this
 * model.
 */
export async function handleStatusNotification(
  connection: ChargerConnection,
  payload: OcppPayload,
): Promise<OcppPayload> {
  const connectorNumber = requireNumber(payload, 'connectorId');
  const ocppStatus = requireString(payload, 'status');

  // `NoError` is OCPP's way of saying "no error", so it is normalised to null here rather than
  // stored as a fault code that reads like one.
  const errorCode =
    typeof payload.errorCode === 'string' && payload.errorCode !== 'NoError' ? payload.errorCode : null;

  if (connectorNumber === CHARGE_POINT_CONNECTOR_ID) {
    return handleChargePointStatus(connection, ocppStatus, errorCode);
  }

  const mapped = STATUS_MAP[ocppStatus];
  if (!mapped) {
    throw new OcppError(OcppErrorCode.PROPERTY_CONSTRAINT_VIOLATION, `Unknown status "${ocppStatus}"`, {
      status: ocppStatus,
    });
  }

  /*
   * `before`, not `after`, and that one word carries real weight: the PREVIOUS status is what
   * tells a fresh fault apart from a charger repeating itself. Real hardware re-sends its
   * status on every reconnect and on a timer, and acting on each repeat would re-fail sessions
   * that are already dead and re-notify staff who already know.
   *
   * The new state is not read back because it is not in doubt — this write just set it.
   */
  const previous = await Connector.findOneAndUpdate(
    { chargerId: connection.chargerId, connectorNumber },
    { $set: { status: mapped, errorCode } },
    { returnDocument: 'before' },
  );

  if (!previous) {
    // The charger reported a connector we have no record of. Not fatal — log it and accept,
    // because refusing would leave real hardware retrying forever over a data-entry gap.
    logger.warn(
      SCOPE,
      `Charger ${connection.ocppId} reported a status for connector ${connectorNumber}, but that ` +
        `connector isn't set up in the system — add it on the charger page (StatusNotification)`,
    );
    return {};
  }

  logger.info(
    SCOPE,
    `${connection.ocppId} connector ${connectorNumber} is now "${ocppStatus}" (StatusNotification)`,
  );

  // AFTER the write, never before: the database is the truth and this is only delivery.
  const charger = await Charger.findById(connection.chargerId).select('stationId name chargerCode');

  realtime.emitConnectorStatus({
    connectorId: String(previous._id),
    chargerId: connection.chargerId,
    stationId: charger ? String(charger.stationId) : '',
    companyId: connection.companyId,
    connectorNumber,
    status: mapped,
    errorCode,
  });

  /*
   * A PLUG THAT FAULTS MID-CHARGE MUST KILL ITS SESSION.
   *
   * Writing the connector was never enough. The session on it stayed `active` — the driver's
   * screen kept animating over a meter that had stopped, and the partial unique index kept the
   * connector reserved — until the charger happened to disconnect. A charger with one bad plug
   * has no reason to disconnect, so in the case this is actually about, it never did.
   *
   * Scoped to this connector alone. The plug beside it may be charging perfectly well, and
   * ending that session too would invent an outage the hardware never reported.
   */
  if (mapped === 'faulted' && previous.status !== 'faulted') {
    const detectedAt = new Date();

    const failed = await sessionEvents.failOpenSessionsForConnector(
      String(previous._id),
      'HardwareFault',
      `Connector ${connectorNumber} reported a fault${errorCode ? ` (${errorCode})` : ''}.`,
    );

    logger.warn(
      SCOPE,
      `${connection.ocppId} connector ${connectorNumber} reported a fault` +
        `${errorCode ? ` (error code ${errorCode})` : ''}. ` +
        `${failed > 0 ? `${failed} charging session(s) on it were stopped.` : 'Nobody was charging on it.'}`,
    );

    if (charger) {
      // Fire-and-forget, like every other notification trigger: telling staff must never fail
      // an OCPP message. The charger's report is already safely written.
      void notify.chargerFault({
        _id: connection.chargerId,
        companyId: connection.companyId,
        name: charger.name,
        chargerCode: charger.chargerCode,
        connectorNumber,
        errorCode,
        detectedAt,
      });
    }
  }

  return {};
}

/**
 * StatusNotification with connectorId 0 — the machine talking about ITSELF.
 *
 * THIS IS THE CASE THE GATEWAY USED TO DROP. It looked connectorId 0 up as a connector, found
 * nothing (plug numbers start at 1), logged "unknown connector 0" and answered OK. A charger
 * could announce a ground fault and still be offered to drivers, every plug reading
 * `available`, because nothing in the system had a field for "the box is broken".
 *
 * Writes `hardwareStatus`, NEVER `status`. An admin who marked this machine for maintenance
 * still sees `maintenance`; the fault sits alongside it. Both are true, both are kept, and
 * `assessStartability` refuses the charger if either one says no.
 */
async function handleChargePointStatus(
  connection: ChargerConnection,
  ocppStatus: string,
  errorCode: string | null,
): Promise<OcppPayload> {
  const mapped = CHARGE_POINT_STATUS_MAP[ocppStatus];

  if (!mapped) {
    // `Charging`, `Preparing`, `Finishing` and friends describe a plug with a car attached and
    // cannot be true of the machine as a whole. Logged and dropped rather than mapped onto
    // something adjacent — a fiction in the database is worse than a gap in it. Not an
    // OcppError: a CALLERROR would make a charger retry a message we will never accept.
    logger.warn(
      SCOPE,
      `Ignored a whole-charger status "${ocppStatus}" from ${connection.ocppId}: only ` +
        `Available, Faulted and Unavailable make sense for the charger as a whole`,
    );
    return {};
  }

  const detectedAt = new Date();
  const isFault = mapped !== 'operative';

  /*
   * THE FILTER IS THE TRANSITION DETECTOR. `hardwareStatus: { $ne: mapped }` means the write
   * lands only when something actually changed, atomically, in one round trip — no
   * read-then-compare race between two messages from a chatty charger. A null result means
   * "no change", which is the common case and deserves no action at all.
   *
   * `faultReportedAt` therefore keeps the time the fault STARTED, not the time of the latest
   * repeat — the number an engineer asking "how long has this been down?" actually needs.
   */
  const previous = await Charger.findOneAndUpdate(
    { _id: connection.chargerId, hardwareStatus: { $ne: mapped } },
    {
      $set: {
        hardwareStatus: mapped,
        faultCode: isFault ? errorCode : null,
        faultReportedAt: isFault ? detectedAt : null,
      },
    },
    { returnDocument: 'before' },
  );

  if (!previous) {
    logger.info(SCOPE, `Charger ${connection.ocppId} repeated its status "${ocppStatus}" — nothing changed`);
    return {};
  }

  logger.warn(
    SCOPE,
    `Charger ${connection.ocppId} changed from ${previous.hardwareStatus} to ${mapped}` +
      `${errorCode ? ` (error code ${errorCode})` : ''}`,
  );

  realtime.emitChargerHardwareStatus({
    chargerId: connection.chargerId,
    stationId: String(previous.stationId),
    companyId: connection.companyId,
    ocppId: connection.ocppId,
    hardwareStatus: mapped,
    faultCode: isFault ? errorCode : null,
  });

  if (mapped === 'faulted') {
    /*
     * The whole machine is down, so EVERY session on it ends — the opposite scope to a single
     * faulted plug, and correct for the same reason: match what the hardware actually said.
     *
     * `unavailable` deliberately does NOT do this. A charge point goes Unavailable in normal
     * operation, typically after a ChangeAvailability, and ending a live charge over a planned
     * withdrawal would cut power to a car that is charging perfectly well.
     */
    const failed = await sessionEvents.failOpenSessionsForCharger(
      connection.chargerId,
      'HardwareFault',
      `The charger reported a hardware fault${errorCode ? ` (${errorCode})` : ''}.`,
    );

    if (failed > 0) {
      logger.warn(
        SCOPE,
        `${failed} charging session(s) stopped because charger ${connection.ocppId} has a fault`,
      );
    }

    void notify.chargerFault({
      _id: connection.chargerId,
      companyId: connection.companyId,
      name: previous.name,
      chargerCode: previous.chargerCode,
      // null means "the machine", not "a plug" — the notification wording depends on it.
      connectorNumber: null,
      errorCode,
      detectedAt,
    });
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
  const status = await sessionEvents.authorizeIdTag(idTag);

  logger.info(
    SCOPE,
    `Charger ${connection.ocppId} asked whether it may start charging: ${status} (Authorize, tag ${idTag})`,
  );

  // Passed through verbatim. The decision belongs to the service; this handler's job is to
  // put it on the wire in the shape OCPP 1.6 expects, not to reinterpret it.
  return { idTagInfo: { status } };
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
    seedTransactionId,
  );

  if (!outcome.accepted || !outcome.session || outcome.session.transactionId === null) {
    logger.warn(
      SCOPE,
      `Told ${connection.ocppId} not to start charging: ${outcome.reason ?? 'no matching session'} (StartTransaction)`,
    );

    // The protocol still wants a number. Allocating a throwaway one is safer than returning 0,
    // which some charge points treat as a valid id.
    return { transactionId: allocateTransactionId(), idTagInfo: { status: 'Invalid' } };
  }

  const transactionId = outcome.session.transactionId;

  // The registry copy is the gateway's own bookkeeping, keyed by CONNECTOR so a charger with
  // several plugs can run several transactions at once. The database row is the record of
  // truth; this is scratch state used only when a charger omits `transactionId`.
  setTransaction(connection.ocppId, {
    transactionId,
    connectorNumber,
    idTag,
    meterStartWh,
    startedAt: new Date(),
  });

  logger.info(
    SCOPE,
    `${connection.ocppId} connector ${connectorNumber} began charging — assigned OCPP transaction ` +
      `${transactionId} (StartTransaction)`,
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

  // `transactionId` is OPTIONAL on MeterValues in OCPP 1.6, so a fallback is genuinely needed.
  // It resolves by CONNECTOR, because that is the one thing the payload always carries that
  // identifies which charge this reading belongs to. Falling back to "whatever this charger is
  // doing" would credit a two-plug charger's energy to the wrong driver.
  const connectorNumber =
    typeof payload.connectorId === 'number' ? payload.connectorId : null;

  const transactionId =
    typeof payload.transactionId === 'number'
      ? payload.transactionId
      : connectorNumber !== null
        ? getTransactionByConnector(connection.ocppId, connectorNumber)?.transactionId ?? null
        : null;

  if (transactionId === null) {
    logger.warn(
      SCOPE,
      `Ignored a meter reading from ${connection.ocppId}: it didn't say which charging session it belongs to`,
    );
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
    // DEBUG, not INFO: one line per reading per connector (every 5-60s while charging) buried
    // every other log line. Start, stop and faults still log at INFO.
    logger.debug(
      SCOPE,
      `Meter reading from ${connection.ocppId} (transaction ${transactionId}): ` +
        `${(energyWh / 1000).toFixed(3)} kWh on the meter`,
    );
  } else {
    logger.warn(
      SCOPE,
      `Discarded a meter reading from ${connection.ocppId} (transaction ${transactionId}): ` +
        `${outcome.reason ?? 'unknown reason'}`,
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

  // OCPP 1.6 makes `transactionId` REQUIRED here, but the connector fallback costs nothing and
  // keeps this handler consistent with MeterValues above.
  const payloadConnector =
    typeof payload.connectorId === 'number' ? payload.connectorId : null;

  const transactionId =
    typeof payload.transactionId === 'number'
      ? payload.transactionId
      : payloadConnector !== null
        ? getTransactionByConnector(connection.ocppId, payloadConnector)?.transactionId ?? null
        : null;

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
        `${connection.ocppId} reported charging ended (transaction ${transactionId}): ` +
          `${(session.energyConsumedWh / 1000).toFixed(3)} kWh delivered (StopTransaction)`,
      );
    }
  } else {
    logger.warn(
      SCOPE,
      `${connection.ocppId} said charging ended but didn't say which session — ignored (StopTransaction)`,
    );
  }

  // Forget ONLY the connector that stopped. Clearing the whole charger here is exactly the bug
  // this patch fixes: on a two-plug charger it would lose track of the session still running.
  const stoppedConnector =
    (transactionId !== null
      ? findTransactionById(connection.ocppId, transactionId)?.connectorNumber
      : null) ?? payloadConnector;

  if (stoppedConnector !== null) clearTransaction(connection.ocppId, stoppedConnector);

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
