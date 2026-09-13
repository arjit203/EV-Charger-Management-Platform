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
 * THE FOUR EVENTS. Each maps to exactly one real field that already exists:
 *
 *   connector:statusChanged        Connector.status            (operational — the plug)
 *   charger:connectivityChanged    Charger.isOnline            (connectivity — the socket)
 *   session:statusChanged          ChargingSession.status      (the business transaction)
 *   session:meterUpdate            a stored MeterReading       (energy)
 *
 * `charger:statusChanged` is deliberately absent. Module 6's D2 put operational state on the
 * CONNECTOR and left the charger holding only connectivity; an event by that name would either
 * duplicate connector status or invent a field that does not exist. `session:started` and
 * `session:completed` are absent for the same reason `charger:faulted` is — they are values of
 * a status the payload already carries, not distinct occurrences. Four events, four owners.
 */

import type { Server } from 'socket.io';

import { logger } from '../utils/logger';
import { companyAudience, sessionAudience } from './rooms';
import type { PublicChargingSession } from '../models/chargingSession.model';

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
    logger.error(SCOPE, `Failed to emit ${event}`, error);
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
  publish(
    sessionAudience(session.companyId, session.userId),
    'session:statusChanged',
    { session },
  );
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
    logger.info(SCOPE, `Disconnected live sockets for company ${companyId}`);
  } catch (error) {
    logger.error(SCOPE, `Failed to disconnect sockets for company ${companyId}`, error);
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
    logger.info(SCOPE, `Disconnected live sockets for user ${userId}`);
  } catch (error) {
    logger.error(SCOPE, `Failed to disconnect sockets for user ${userId}`, error);
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
    logger.error(SCOPE, `Failed to sweep sockets for user ${userId}`, error);
  }
}

/** Live socket count, for the health endpoint and for tests to assert against. */
export function connectionCount(): number {
  return io ? io.sockets.sockets.size : 0;
}
