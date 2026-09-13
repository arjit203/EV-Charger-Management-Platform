/**
 * Session lifecycle driven by the CHARGER.
 *
 * There are two ways a ChargingSession changes state, and they are kept in separate files on
 * purpose:
 *
 *   chargingSession.service.ts  a PERSON acted     -> has an actor, RBAC and company scoping
 *   sessionEvents.service.ts    the CHARGER spoke  -> no actor, no RBAC, no HTTP  <- this file
 *
 * Nothing here takes an `AuthUser`, because there is nobody to authorise: the caller is a
 * machine that already proved its identity during the WebSocket upgrade. Mixing the two would
 * mean either inventing a fake actor for the gateway, or leaving an unauthenticated path in a
 * file that is supposed to enforce permissions.
 *
 * The gateway calls into this module; this module never reaches back into the gateway.
 */

import {
  ChargingSession,
  toPublicChargingSession,
  type ChargingSessionDocument,
} from '../models/chargingSession.model';
import { MeterReading } from '../models/meterReading.model';
import {
  OPEN_SESSION_STATUSES,
  SESSION_SWEEP_INTERVAL_MS,
  START_CONFIRMATION_TIMEOUT_MS,
  type StopReason,
} from '../constants/session';
import { logger } from '../utils/logger';
import * as realtime from '../realtime/publisher';
import * as notify from './notification.service';
import { settleSession } from './payment.service';

const SCOPE = 'session';

/** MongoDB's duplicate-key error. Meaningful here, not an accident. */
const DUPLICATE_KEY = 11000;

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(error) && (error as { code?: number }).code === DUPLICATE_KEY;
}

/** Energy delivered is the difference between two readings of the same cumulative counter. */
function consumedWh(startWh: number | null, endWh: number | null): number {
  if (startWh === null || endWh === null) return 0;
  // Clamped at zero: a counter that appears to run backwards is bad data, never negative energy.
  return Math.max(0, Number((endWh - startWh).toFixed(2)));
}

/** Parse a charger-supplied timestamp, falling back to our clock if it is unusable. */
function parseChargerTime(value: unknown): Date {
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

/* -------------------------------------------------------------------------- */
/* Authorize                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Is this idTag allowed to draw power right now?
 *
 * Module 6 answered "yes" to anything that looked like a tag, because there was nothing to
 * check against. Now there is: a tag is valid only while a session is holding it open. That
 * turns Authorize from a formality into a real gate — a charger cannot start charging for a
 * credential no living session issued.
 */
export async function authorizeIdTag(idTag: string): Promise<boolean> {
  const session = await ChargingSession.findOne({
    idTag,
    status: { $in: OPEN_SESSION_STATUSES },
  }).select('_id');

  return Boolean(session);
}

/* -------------------------------------------------------------------------- */
/* StartTransaction                                                           */
/* -------------------------------------------------------------------------- */

export interface StartTransactionInput {
  chargerId: string;
  connectorNumber: number;
  idTag: string;
  meterStartWh: number;
  timestamp: unknown;
}

export interface StartTransactionOutcome {
  /** Null when refused — the caller still owes the charger a transactionId of some kind. */
  session: ChargingSessionDocument | null;
  accepted: boolean;
  reason?: string;
}

/**
 * The charger confirms it has begun charging: `initiating` -> `active`.
 *
 * CORRELATION is by idTag, not by connector. The tag was minted for exactly one session and
 * travels through RemoteStartTransaction -> Authorize -> StartTransaction untouched, so it
 * identifies the session precisely instead of guessing from "whatever is open on plug 2".
 *
 * A start we cannot correlate is REFUSED rather than recorded. That is the whole point of the
 * module: if energy can flow without a session row, the platform has charging it cannot bill,
 * cannot show the driver, and cannot explain later. Refusing keeps the invariant that every
 * charging connector has exactly one session describing it.
 */
export async function onStartTransaction(
  input: StartTransactionInput,
  allocateTransactionId: () => number,
): Promise<StartTransactionOutcome> {
  const session = await ChargingSession.findOne({ idTag: input.idTag });

  if (!session) {
    logger.warn(SCOPE, `StartTransaction with unknown idTag ${input.idTag} — refusing`);
    return { session: null, accepted: false, reason: 'Unknown idTag' };
  }

  // Already confirmed. A charger repeating StartTransaction after a lost CALLRESULT must get
  // the SAME transaction id back, not a second one — otherwise its MeterValues would quote an
  // id we no longer recognise.
  if (session.status === 'active' && session.transactionId !== null) {
    logger.info(SCOPE, `Duplicate StartTransaction for session ${String(session._id)} — replaying`);
    return { session, accepted: true };
  }

  if (session.status !== 'initiating') {
    logger.warn(
      SCOPE,
      `StartTransaction for session ${String(session._id)} in status ${session.status} — refusing`,
    );
    return { session: null, accepted: false, reason: `Session already ${session.status}` };
  }

  if (String(session.chargerId) !== input.chargerId) {
    // The tag is real but arrived from the wrong machine. Nothing legitimate does this.
    logger.warn(SCOPE, `StartTransaction idTag ${input.idTag} presented by the wrong charger`);
    return { session: null, accepted: false, reason: 'idTag does not belong to this charger' };
  }

  session.transactionId = allocateTransactionId();
  session.status = 'active';
  session.startedAt = parseChargerTime(input.timestamp);
  session.startMeterWh = input.meterStartWh;
  session.lastMeterWh = input.meterStartWh;
  await session.save();

  logger.info(
    SCOPE,
    `Session ${String(session._id)} active (transaction ${String(session.transactionId)})`,
  );

  // AFTER the save. This is the transition the driver has been waiting on since the 202.
  realtime.emitSessionStatus(toPublicChargingSession(session));
  void notify.sessionStarted(session);

  return { session, accepted: true };
}

/* -------------------------------------------------------------------------- */
/* MeterValues                                                                */
/* -------------------------------------------------------------------------- */

export interface MeterValuesInput {
  transactionId: number;
  energyWh: number;
  powerKw?: number | null;
  socPercent?: number | null;
  timestamp: unknown;
}

export interface MeterValuesOutcome {
  stored: boolean;
  reason?: string;
}

/**
 * Persist one energy sample.
 *
 * TWO layers of duplicate protection, for two different problems:
 *
 *   the monotonicity check   rejects a reading that carries no new energy, which covers
 *                            duplicates, out-of-order arrival and garbage in one comparison
 *   the unique index         is the backstop when two identical readings arrive close enough
 *                            together that both pass the check before either has written
 *
 * A rejected reading is NOT an error. Chargers resend, and a charger that buffered readings
 * while offline replays the whole backlog on reconnect. We swallow it and keep the socket
 * healthy rather than answering CALLERROR for expected traffic.
 *
 * Known consequence, accepted: a car that has finished charging keeps reporting the same
 * counter, and those samples are dropped. The session looks "quiet" rather than dead — which
 * is fine, because liveness is the heartbeat's job, not the meter's.
 */
export async function onMeterValues(input: MeterValuesInput): Promise<MeterValuesOutcome> {
  if (!Number.isFinite(input.energyWh) || input.energyWh < 0) {
    return { stored: false, reason: 'Invalid energy value' };
  }

  const session = await ChargingSession.findOne({
    transactionId: input.transactionId,
    status: { $in: OPEN_SESSION_STATUSES },
  });

  if (!session) {
    // Includes the deliberate case: a session already failed by the disconnect handler. Its
    // energy is frozen, so late readings against it are ignored rather than reviving it.
    return { stored: false, reason: 'No open session for this transaction' };
  }

  const previousWh = session.lastMeterWh ?? session.startMeterWh ?? 0;
  if (input.energyWh <= previousWh) {
    return { stored: false, reason: 'Reading is not newer than the last stored value' };
  }

  try {
    await MeterReading.create({
      sessionId: session._id,
      meterTimestamp: parseChargerTime(input.timestamp),
      energyWh: input.energyWh,
      powerKw: input.powerKw ?? null,
      socPercent: input.socPercent ?? null,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) return { stored: false, reason: 'Duplicate reading' };
    throw error;
  }

  // The running total is kept on the session too, so "how much so far?" is one document read
  // rather than a scan of every reading — and so a session that dies mid-charge still knows
  // how much energy to bill for.
  session.lastMeterWh = input.energyWh;
  session.energyConsumedWh = consumedWh(session.startMeterWh, input.energyWh);
  await session.save();

  // ONLY for a reading that was actually stored. A duplicate or stale reading the monotonicity
  // check rejected returns above without emitting - otherwise the UI would show a number the
  // database does not hold, which is precisely the drift the "write first" rule prevents.
  realtime.emitMeterUpdate({
    sessionId: String(session._id),
    chargerId: String(session.chargerId),
    connectorId: String(session.connectorId),
    companyId: String(session.companyId),
    userId: String(session.userId),
    energyConsumedWh: session.energyConsumedWh,
    energyConsumedKwh: Number((session.energyConsumedWh / 1000).toFixed(3)),
    powerKw: input.powerKw ?? null,
    socPercent: input.socPercent ?? null,
    meterTimestamp: parseChargerTime(input.timestamp).toISOString(),
  });

  return { stored: true };
}

/* -------------------------------------------------------------------------- */
/* StopTransaction                                                            */
/* -------------------------------------------------------------------------- */

export interface StopTransactionInput {
  transactionId: number;
  meterStopWh: number;
  reason: unknown;
  timestamp: unknown;
}

/**
 * The charger confirms charging has ended. This is where energy is FINALISED.
 *
 * `stopReason` records who ended it, and the session's own status is better evidence than
 * anything the charger says: if we had already moved it to `stopping`, the stop came from our
 * RemoteStop. Otherwise a human pressed the button on the machine.
 */
export async function onStopTransaction(
  input: StopTransactionInput,
): Promise<ChargingSessionDocument | null> {
  const session = await ChargingSession.findOne({
    transactionId: input.transactionId,
    status: { $in: OPEN_SESSION_STATUSES },
  });

  if (!session) {
    logger.warn(SCOPE, `StopTransaction for unknown transaction ${String(input.transactionId)}`);
    return null;
  }

  const stopReason: StopReason = session.status === 'stopping' ? 'Remote' : 'Local';

  session.status = 'completed';
  session.endedAt = parseChargerTime(input.timestamp);
  session.endMeterWh = input.meterStopWh;
  session.lastMeterWh = input.meterStopWh;
  session.energyConsumedWh = consumedWh(session.startMeterWh, input.meterStopWh);
  session.stopReason = stopReason;
  await session.save();

  logger.info(
    SCOPE,
    `Session ${String(session._id)} completed: ` +
      `${(session.energyConsumedWh / 1000).toFixed(3)} kWh (${stopReason})`,
  );

  realtime.emitSessionStatus(toPublicChargingSession(session));
  void notify.sessionCompleted(session);

  /*
   * MODULE 10 — settle the charge, inline and BEST-EFFORT.
   *
   * This is the fast path: the driver sees "paid" a moment after unplugging. It is deliberately
   * not load-bearing — the settlement sweeper picks up anything this misses (a session that
   * ended via the disconnect handler, a crash between pricing and settling), and the unique
   * index on `chargingSessionId` means a race between the two is harmless.
   *
   * Fire-and-forget on purpose: a payment problem must never fail the OCPP StopTransaction that
   * triggered it. The electricity has already flowed; refusing the charger's message would fix
   * nothing and would make a healthy charger look broken.
   */
  void settleSession(String(session._id))
    .then((result) => {
      if (result.status === 'paid') {
        // Re-emit so the driver's screen flips to paid without a refetch.
        void ChargingSession.findById(session._id).then((fresh) => {
          if (fresh) realtime.emitSessionStatus(toPublicChargingSession(fresh));
        });
      }
    })
    .catch((error: unknown) => logger.error(SCOPE, 'Inline settlement failed', error));

  return session;
}

/* -------------------------------------------------------------------------- */
/* Failure paths                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Close out every open session on a charger that has gone away.
 *
 * Called from the gateway's `close` handler and from its heartbeat sweep. Without this a
 * charger that loses signal mid-charge leaves a session `active` forever: the connector stays
 * reserved by the partial unique index, and the driver can never start another one.
 *
 * The energy is NOT discarded. `energyConsumedWh` already holds everything up to the last
 * reading that arrived, so the driver is charged for power they actually received, and the
 * record says plainly why it ended without a proper StopTransaction.
 */
export async function failOpenSessionsForCharger(
  chargerId: string,
  stopReason: StopReason,
  failureReason: string,
): Promise<number> {
  const open = await ChargingSession.find({
    chargerId,
    status: { $in: OPEN_SESSION_STATUSES },
  });

  for (const session of open) {
    session.status = 'failed';
    session.endedAt = new Date();
    session.endMeterWh = session.lastMeterWh;
    session.energyConsumedWh = consumedWh(session.startMeterWh, session.lastMeterWh);
    session.stopReason = stopReason;
    session.failureReason = failureReason;
    await session.save();

    logger.warn(
      SCOPE,
      `Session ${String(session._id)} failed: ${failureReason} ` +
        `(${(session.energyConsumedWh / 1000).toFixed(3)} kWh recorded)`,
    );

    // A driver watching a live session must be told it died, not left staring at a stale
    // "charging" screen until they refresh.
    realtime.emitSessionStatus(toPublicChargingSession(session));
    void notify.sessionFailed(session);
  }

  return open.length;
}

/**
 * Fail sessions the charger never confirmed.
 *
 * The gap this closes: RemoteStartTransaction was sent and the charger never answered with
 * StartTransaction — it rejected the start, or the link died during the handshake. The row was
 * written BEFORE the command went out (that is what makes the connector reservation atomic),
 * so something has to clean it up.
 *
 * It is transitioned to `failed`, never deleted. A driver who pressed start and got nothing
 * deserves a record saying so; a silently vanished row is indistinguishable from a bug.
 */
export async function sweepUnconfirmedSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - START_CONFIRMATION_TIMEOUT_MS);

  const stale = await ChargingSession.find({
    status: 'initiating',
    requestedAt: { $lt: cutoff },
  });

  for (const session of stale) {
    session.status = 'failed';
    session.endedAt = new Date();
    session.stopReason = 'StartTimeout';
    session.failureReason = 'The charger did not confirm the start in time.';
    await session.save();

    logger.warn(SCOPE, `Session ${String(session._id)} failed: start not confirmed`);

    realtime.emitSessionStatus(toPublicChargingSession(session));
    void notify.sessionFailed(session);
  }

  return stale.length;
}

let sweepTimer: NodeJS.Timeout | null = null;

/** ONE timer for every session, matching how the gateway sweeps connections. */
export function startSessionSweeper(): void {
  if (sweepTimer) return;

  sweepTimer = setInterval(() => {
    void sweepUnconfirmedSessions().catch((error: unknown) =>
      logger.error(SCOPE, 'Session sweep failed', error),
    );
  }, SESSION_SWEEP_INTERVAL_MS);

  // `unref` so a background sweep can never hold the process open during shutdown.
  sweepTimer.unref();
}

export function stopSessionSweeper(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}

/**
 * The highest transaction id ever issued, so a restart does not reuse one.
 *
 * Module 6 held this counter in memory starting at 1000, which was fine when nothing was
 * persisted. Now that sessions outlive the process, a restart would hand out 1001 again and
 * collide with the unique index on an old session — or worse, silently attach a charger's
 * MeterValues to someone else's completed charge.
 */
export async function highestTransactionId(): Promise<number> {
  const latest = await ChargingSession.findOne({ transactionId: { $ne: null } })
    .sort({ transactionId: -1 })
    .select('transactionId');

  return latest?.transactionId ?? 0;
}
