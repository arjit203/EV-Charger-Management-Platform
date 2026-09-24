/**
 * Event publishing — the ONE place the application emits to browsers.
 *
 * DEPENDENCY DIRECTION, and why this file exists at all: services import the publisher; the
 * publisher imports nothing from services. That keeps the graph acyclic while letting the OCPP
 * handlers and the session services — which know nothing about Socket.IO — announce what they
 * just did.
 *
 * TWO RULES, both non-negotiable:
 *
 * 1. EMIT AFTER THE WRITE, NEVER BEFORE. The database is the source of truth and Socket.IO is
 *    only delivery. Emitting first would let a client receive an event, refetch, and see older
 *    data than the event it was just handed — and a failed write would leave the UI showing
 *    something that never happened.
 *
 * 2. AN EMIT MUST NEVER BREAK BUSINESS LOGIC. Every publish is wrapped. A browser problem, a
 *    dead socket, a serialisation failure — none of them may propagate into a charging session.
 *    If nobody is listening the event simply evaporates, which is correct: Socket.IO is a
 *    notification channel, not a queue.
 *
 * THE EVENTS. Each maps to exactly one real thing that already exists:
 *
 *   connector:statusChanged        Connector.status            (operational — the plug)
 *   charger:connectivityChanged    Charger.isOnline            (connectivity — the socket)
 *   charger:hardwareStatusChanged  Charger.hardwareStatus      (the machine's view of itself)
 *   session:statusChanged          ChargingSession.status      (the business transaction)
 *   session:meterUpdate            a stored MeterReading       (energy)
 *   notification:new               a stored Notification       (Module 12)
 *
 * `charger:statusChanged` is still deliberately absent: `Charger.status` is administrative, it
 * changes only when a human edits it, and the editor already has the response. What used to be
 * absent WITH it — a charge-point-level fault — is now `charger:hardwareStatusChanged`, because
 * it finally maps to a field that exists (`hardwareStatus`, added when the gateway learned to
 * read OCPP's connectorId 0). The rule did not bend: an event still needs one owning field.
 *
 * `session:started` and `session:completed` remain absent — they are values of a status the
 * payload already carries, not distinct occurrences. Every event has one owner.
 */

import type { Server } from 'socket.io';

import { logger } from '../utils/logger';
import { describeCompany, describeUser } from '../utils/logLabels';
import { companyAudience, sessionAudience, userRoom } from './rooms';
import type { PublicChargingSession } from '../models/chargingSession.model';
import { forgetSessionLabels, labelsForSession } from './sessionLabels';

const SCOPE = 'realtime';

/**
 * Set once at startup. Null until then — and everything below tolerates that, so the OCPP
 * gateway and the session services work exactly as before if real-time is not attached (a
 * script, a test harness, a future worker process).
 */
let io: Server | null = null;

export function setServer(server: Server | null): void {
  io = server;
}

/** Fire-and-forget. Never throws, never awaits — the caller has already done the real work. */
function publish(rooms: string[], event: string, payload: unknown): void {
  if (!io) return;

  try {
    io.to(rooms).emit(event, payload);
  } catch (error) {
    logger.error(SCOPE, `Couldn't push live update "${event}" to browsers`, error);
  }
}

/* -------------------------------------------------------------------------- */
/* Charger + connector                                                        */
/* -------------------------------------------------------------------------- */

export interface ConnectorStatusEvent {
  connectorId: string;
  chargerId: string;
  stationId: string;
  companyId: string;
  connectorNumber: number;
  status: string;
  errorCode: string | null;
  at: string;
}

/**
 * A plug changed operational state — available / preparing / charging / finishing / faulted.
 *
 * Company-scoped only. A driver does not receive these: the one plug they care about is the one
 * their own session is on, and `session:statusChanged` already tells them about that.
 */
export function emitConnectorStatus(event: Omit<ConnectorStatusEvent, 'at'>): void {
  publish(companyAudience(event.companyId), 'connector:statusChanged', {
    ...event,
    at: new Date().toISOString(),
  });
}

export interface ChargerConnectivityEvent {
  chargerId: string;
  stationId: string;
  companyId: string;
  ocppId: string;
  isOnline: boolean;
  lastHeartbeatAt: string | null;
  at: string;
}

/**
 * A charger connected or dropped off the gateway.
 *
 * TRANSITIONS ONLY. Heartbeats arrive every 30 seconds per charger and do not change anything
 * a dashboard displays — emitting on each one would flood every open dashboard with events
 * that say "still online", which is noise, not information.
 */
export function emitChargerConnectivity(event: Omit<ChargerConnectivityEvent, 'at'>): void {
  publish(companyAudience(event.companyId), 'charger:connectivityChanged', {
    ...event,
    at: new Date().toISOString(),
  });
}

export interface ChargerHardwareStatusEvent {
  chargerId: string;
  stationId: string;
  companyId: string;
  ocppId: string;
  hardwareStatus: string;
  faultCode: string | null;
  at: string;
}

/**
 * The MACHINE changed its mind about its own health — OCPP `StatusNotification` on connectorId
 * 0, which addresses the charge point itself rather than any one plug.
 *
 * TRANSITIONS ONLY, like connectivity above: hardware repeats its status on reconnect and on a
 * timer, and a dashboard learns nothing from "still faulted". Company-scoped — a driver never
 * sees this; what a driver needs is the charger simply not being offered to them, which
 * `assessStartability` already handles.
 */
export function emitChargerHardwareStatus(event: Omit<ChargerHardwareStatusEvent, 'at'>): void {
  publish(companyAudience(event.companyId), 'charger:hardwareStatusChanged', {
    ...event,
    at: new Date().toISOString(),
  });
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Any session transition: initiating → active → stopping → completed, or → failed.
 *
 * The payload is the same `PublicChargingSession` the REST endpoints return, so a client can
 * drop it straight into the state it already holds with no second shape to maintain — and a
 * refetch after reconnect yields something identical.
 *
 * Goes to the station's company AND the driver, because they are rarely the same audience: a
 * driver charging at another company's station is not in that company's room.
 */
export function emitSessionStatus(session: PublicChargingSession): void {
  // Attach the names resolved when the session started (see sessionLabels.ts), so a live row can
  // say which station and charger — synchronously, so emits cannot reorder.
  const labels = labelsForSession(session.id);
  publish(
    sessionAudience(session.companyId, session.userId),
    'session:statusChanged',
    { session: labels ? { ...labels, ...session } : session },
  );

  if (session.status === 'completed' || session.status === 'failed') {
    // A settlement re-emit may follow shortly; keep the entry a little longer than the session.
    setTimeout(() => forgetSessionLabels(session.id), 60_000).unref();
  }
}

export interface MeterUpdateEvent {
  sessionId: string;
  chargerId: string;
  connectorId: string;
  companyId: string;
  userId: string;
  energyConsumedWh: number;
  energyConsumedKwh: number;
  powerKw: number | null;
  socPercent: number | null;
  meterTimestamp: string;
}

/**
 * One stored energy reading.
 *
 * Emitted only when the reading was actually PERSISTED. A duplicate or stale reading that the
 * monotonicity check rejected must not produce an event — the UI would show a value the
 * database does not hold, which is the exact drift rule 1 above exists to prevent.
 *
 * Not throttled: the simulator reports every 5 seconds and real hardware is not much faster,
 * so a buffer would add latency and complexity with nothing to gain.
 */
export function emitMeterUpdate(event: MeterUpdateEvent): void {
  publish(sessionAudience(event.companyId, event.userId), 'session:meterUpdate', event);
}

/* -------------------------------------------------------------------------- */
/* Notifications (Module 12)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Deliver one notification to one person.
 *
 * REUSES THE `user:{id}` ROOM Module 8 already created — the one every socket auto-joins on
 * connection from its verified identity. No new room type, no new authentication, and the
 * security question is already answered: rooms are server-assigned and there is no join
 * listener, so a driver cannot subscribe to someone else's notifications because there is no
 * code path to ask.
 *
 * Best-effort, like every other emit here. The database ROW is the notification; this is
 * delivery. A client that was offline finds it waiting on next load.
 */
export function emitNotification(userId: string, notification: unknown): void {
  publish([userRoom(userId)], 'notification:new', { notification });
}

/* -------------------------------------------------------------------------- */
/* Forced disconnects                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Drop every socket belonging to a company.
 *
 * Module 2 built live suspension so a token issued before the suspension stops working on the
 * NEXT REST CALL. A socket makes no next call — it is already open, and would keep receiving
 * room broadcasts indefinitely. Without this, suspended staff lose REST access but keep a live
 * feed of their company's chargers through a side door.
 */
export function disconnectCompany(companyId: string): void {
  if (!io) return;

  try {
    const room = companyAudience(companyId)[0];
    io.in(room).disconnectSockets(true);
    void describeCompany(companyId).then((name) =>
      logger.info(SCOPE, `Cut off live updates for everyone at ${name} (company suspended)`),
    );
  } catch (error) {
    logger.error(SCOPE, `Couldn't cut off live updates for company ${companyId}`, error);
  }
}

/**
 * Drop every socket belonging to one user.
 *
 * The same hole as above, one level down: deactivating an account must not leave its open
 * socket streaming. `User.status` has existed since Module 1 and REST already honours it, so
 * fixing only the company case would have left the identical gap open for individuals.
 */
export function disconnectUser(userId: string): void {
  if (!io) return;

  try {
    io.in(`user:${userId}`).disconnectSockets(true);
    void describeUser(userId).then((email) =>
      logger.info(SCOPE, `Cut off live updates for ${email} (account deactivated)`),
    );
  } catch (error) {
    logger.error(SCOPE, `Couldn't cut off live updates for user ${userId}`, error);
  }
}

/**
 * A staff member's socket lives in their company room, not a personal one, so deactivating an
 * individual staff account needs a targeted sweep rather than a room broadcast.
 */
export function disconnectUserSockets(userId: string): void {
  if (!io) return;

  disconnectUser(userId);

  try {
    for (const socket of io.sockets.sockets.values()) {
      const data = socket.data as { user?: { id?: string } };
      if (data.user?.id === userId) socket.disconnect(true);
    }
  } catch (error) {
    logger.error(SCOPE, `Couldn't close the remaining live-update connections for user ${userId}`, error);
  }
}

/** Live socket count, for the health endpoint and for tests to assert against. */
export function connectionCount(): number {
  return io ? io.sockets.sockets.size : 0;
}
