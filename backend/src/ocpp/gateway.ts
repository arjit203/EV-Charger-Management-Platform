/**
 * OCPP Gateway — accepts charger WebSocket connections and owns their lifecycle.
 *
 * It attaches to the SAME `http.Server` Express runs on, which is exactly why `server.ts`
 * has always used `http.createServer(app)` instead of `app.listen()`. The upgrade handler
 * only claims paths under `/ocpp/`, so Socket.IO (Module 8) can attach to the same server on
 * `/socket.io` without either interfering with the other.
 *
 * THE TWO REAL-TIME SYSTEMS ARE SEPARATE AND MUST STAY SO:
 *   charger  <-> raw ws, OCPP frames   <- this file
 *   browser  <-> Socket.IO, app events <- Module 8
 *
 * Responsibilities kept here and nowhere else: upgrade authentication, socket lifecycle,
 * routing frames to handlers, the heartbeat sweep. Message parsing lives in `messages.ts`,
 * per-action meaning in `handlers.ts`, outbound calls in `commands.ts`.
 */

import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, type WebSocket } from 'ws';

import { Charger } from '../models/charger.model';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { verifyChargerToken } from '../utils/chargerToken';
import { cancelPending, handleResponse } from './commands';
import { HANDLERS } from './handlers';
import {
  buildCallError,
  buildCallResult,
  MessageType,
  OcppError,
  OcppErrorCode,
  parseMessage,
} from './messages';
import * as registry from './registry';
import * as sessionEvents from '../services/sessionEvents.service';
import * as realtime from '../realtime/publisher';

const SCOPE = 'ocpp';

/** The path prefix this gateway claims. Everything else is left for other listeners. */
const OCPP_PATH_PREFIX = '/ocpp/';

/**
 * 3 missed heartbeats before a charger is considered offline — one lost packet is not enough.
 * Configurable via OCPP_OFFLINE_AFTER_SECONDS so tests need not wait 90 real seconds.
 */
const OFFLINE_AFTER_MS = env.ocppOfflineAfterSeconds * 1000;

/**
 * How often the sweep runs. ONE timer for ALL chargers, not one per charger — simpler, and
 * it cannot leak a timer when a socket dies. Never sweeps less often than the threshold.
 */
const SWEEP_INTERVAL_MS = Math.max(1_000, Math.min(15_000, OFFLINE_AFTER_MS / 2));

/** Close code used when a reconnect supersedes an older socket. */
const CLOSE_SUPERSEDED = 4000;

/** Plain-English meaning of a WebSocket close code, for logs. The number stays for searching. */
function describeCloseCode(code: number): string {
  switch (code) {
    case 1000:
      return 'closed normally';
    case 1001:
      return 'the charger is shutting down or restarting';
    case 1006:
      return 'connection lost without a goodbye — usually network or power loss';
    case 1011:
      return 'the charger hit an internal error';
    case CLOSE_SUPERSEDED:
      return 'replaced by a newer connection from the same charger';
    default:
      return 'unexpected close';
  }
}

let wss: WebSocketServer | null = null;
let sweepTimer: NodeJS.Timeout | null = null;

/* -------------------------------------------------------------------------- */
/* Authentication                                                             */
/* -------------------------------------------------------------------------- */

interface AuthenticatedCharger {
  ocppId: string;
  chargerId: string;
  companyId: string;
}

/**
 * Authenticate the upgrade request, mirroring how real OCPP 1.6J charge points connect:
 *
 *   ws://host/ocpp/<ocppId>
 *   Authorization: Basic base64("<ocppId>:<token>")
 *
 * Three checks, in this order, all before any socket is accepted:
 *   1. a Charger with that ocppId exists  — the gateway NEVER creates one, because
 *      auto-registering from an inbound connection would let anyone add hardware and would
 *      bypass company ownership entirely
 *   2. the Basic username equals the path identity — stops presenting charger B's
 *      credentials on charger A's path
 *   3. the token matches the stored bcrypt hash
 *
 * Any failure returns 401 and destroys the socket. `ocppId` alone is a CLAIM, not a
 * credential; without the token anything able to open a WebSocket could impersonate real
 * hardware, report false status, and receive commands meant for it.
 */
async function authenticate(request: IncomingMessage): Promise<AuthenticatedCharger | null> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const ocppId = decodeURIComponent(url.pathname.slice(OCPP_PATH_PREFIX.length)).trim();

  if (!ocppId) return null;

  const header = request.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  } catch {
    return null;
  }

  const separator = decoded.indexOf(':');
  if (separator < 1) return null;

  const username = decoded.slice(0, separator);
  const token = decoded.slice(separator + 1);

  // Check 2 first: it needs no database round trip.
  if (username !== ocppId) {
    logger.warn(
      SCOPE,
      `Refused connection: a charger connecting as "${ocppId}" logged in with the credentials of "${username}"`,
    );
    return null;
  }

  const charger = await Charger.findOne({ ocppId }).select('_id companyId ocppId +authTokenHash');
  if (!charger) {
    logger.warn(SCOPE, `Refused connection from "${ocppId}": no charger with that OCPP id is registered`);
    return null;
  }

  if (!(await verifyChargerToken(token, charger.authTokenHash))) {
    logger.warn(
      SCOPE,
      `Refused connection from ${ocppId}: wrong password (auth token) — regenerate it on the charger page if it was lost`,
    );
    return null;
  }

  return {
    ocppId: charger.ocppId,
    chargerId: String(charger._id),
    companyId: String(charger.companyId),
  };
}

function rejectUpgrade(socket: Duplex, reason: string): void {
  socket.write(
    `HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\nX-Reject-Reason: ${reason}\r\n\r\n`,
  );
  socket.destroy();
}

/* -------------------------------------------------------------------------- */
/* Frame handling                                                             */
/* -------------------------------------------------------------------------- */

async function onFrame(connection: registry.ChargerConnection, raw: string): Promise<void> {
  const message = parseMessage(raw);

  if (!message) {
    // Malformed frame. Answer with a CALLERROR and KEEP THE SOCKET OPEN — one bad message
    // from one charger must never take down the backend or disconnect that charger.
    logger.warn(SCOPE, `Charger ${connection.ocppId} sent a message that isn't valid OCPP — rejected it`);
    connection.socket.send(
      buildCallError('0', OcppErrorCode.FORMATION_VIOLATION, 'Could not parse message'),
    );
    return;
  }

  // A reply to something WE sent (RemoteStart/RemoteStop).
  if (message.type === MessageType.CALLRESULT || message.type === MessageType.CALLERROR) {
    if (!handleResponse(message)) {
      logger.warn(
        SCOPE,
        `Charger ${connection.ocppId} answered a command we are no longer waiting for (probably timed out) — ignored`,
      );
    }
    return;
  }

  const handler = HANDLERS[message.action];

  if (!handler) {
    logger.warn(
      SCOPE,
      `Charger ${connection.ocppId} sent "${message.action}", which this system doesn't support yet — replied NotSupported`,
    );
    connection.socket.send(
      buildCallError(
        message.uniqueId,
        OcppErrorCode.NOT_SUPPORTED,
        `Action "${message.action}" is not supported`,
      ),
    );
    return;
  }

  try {
    const payload = await handler(connection, message.payload);
    connection.socket.send(buildCallResult(message.uniqueId, payload));
  } catch (error) {
    if (error instanceof OcppError) {
      connection.socket.send(
        buildCallError(message.uniqueId, error.code, error.message, error.details),
      );
      return;
    }

    // An unexpected failure in a handler is our bug, not the charger's. Report it as an
    // internal error and stay connected.
    logger.error(
      SCOPE,
      `Something went wrong on our side handling "${message.action}" from ${connection.ocppId}`,
      error,
    );
    connection.socket.send(
      buildCallError(message.uniqueId, OcppErrorCode.INTERNAL_ERROR, 'Internal gateway error'),
    );
  }
}

/**
 * Announce a connectivity TRANSITION to the browsers watching this company.
 *
 * Only transitions. A heartbeat arrives every 30 seconds per charger and changes nothing a
 * dashboard renders, so emitting on each one would flood every open dashboard with "still
 * online" - noise that would also make the genuine connect/disconnect events harder to see.
 */
async function announceConnectivity(
  chargerId: string,
  companyId: string,
  ocppId: string,
  isOnline: boolean,
): Promise<void> {
  try {
    const charger = await Charger.findById(chargerId).select('stationId lastHeartbeatAt');
    if (!charger) return;

    realtime.emitChargerConnectivity({
      chargerId,
      stationId: String(charger.stationId),
      companyId,
      ocppId,
      isOnline,
      lastHeartbeatAt: charger.lastHeartbeatAt ? charger.lastHeartbeatAt.toISOString() : null,
    });
  } catch (error) {
    logger.error(SCOPE, `Couldn't tell the dashboards that ${ocppId} went online/offline`, error);
  }
}

/* -------------------------------------------------------------------------- */
/* Heartbeat sweep                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Mark chargers offline when their heartbeats stop.
 *
 * A socket can die without a `close` event — a mobile connection dropping mid-frame looks
 * like silence, not a disconnect. The heartbeat is what turns that silence into a detectable
 * state change.
 *
 * NOTE: this marks `isOnline: false` and deliberately leaves connector statuses ALONE. The
 * hardware never told us the plugs changed; we simply cannot reach it. Forcing them to
 * "unavailable" would be inventing state the charger never reported.
 */
async function sweepStaleConnections(): Promise<void> {
  const cutoff = Date.now() - OFFLINE_AFTER_MS;

  for (const connection of registry.all()) {
    if (connection.lastHeartbeatAt.getTime() >= cutoff) continue;

    logger.warn(
      SCOPE,
      `Charger ${connection.ocppId} has been silent for over ${OFFLINE_AFTER_MS / 1000}s ` +
        '(no heartbeat) — marking it offline',
    );

    try {
      await Charger.updateOne({ _id: connection.chargerId }, { $set: { isOnline: false } });

      // A charger that went silent mid-charge must not leave its session ACTIVE forever. The
      // partial unique index would keep the connector reserved, and no driver could ever start
      // there again. Energy recorded up to the last reading is kept, not discarded.
      await sessionEvents.failOpenSessionsForCharger(
        connection.chargerId,
        'ChargerDisconnected',
        'The charger stopped sending heartbeats.',
      );

      await announceConnectivity(connection.chargerId, connection.companyId, connection.ocppId, false);
    } catch (error) {
      logger.error(SCOPE, `Couldn't mark silent charger ${connection.ocppId} offline`, error);
    }

    registry.remove(connection.ocppId, connection.socket);
    connection.socket.terminate();
  }
}

/**
 * Reconcile `isOnline` with reality at boot.
 *
 * THE GAP THIS CLOSES. `sweepStaleConnections` only ever looks at `registry.all()` — sockets
 * this process is holding. The registry is in-memory, so it starts EMPTY, which means a
 * charger the previous process had marked online is invisible to the sweep forever. Its
 * `isOnline: true` is never revisited by anything.
 *
 * The result is a lie with a long half-life. A charger last heard from eight days ago still
 * advertises itself to drivers as `ready`, with a plug type, a power rating and a price. The
 * driver only finds out it is gone after tapping Start, because the start path checks the live
 * registry while every listing reads the database mirror.
 *
 * The fix is a statement of fact rather than a heuristic: at the moment the gateway attaches,
 * this process holds no sockets, so NO charger is connected. Anything claiming otherwise is a
 * leftover from a process that no longer exists. There is no timeout to tune and no race — a
 * charger that reconnects a second later sets `isOnline: true` again through the normal path.
 *
 * Open sessions and in-flight connectors are released through the same helper the disconnect
 * paths use, because the situation is identical: the charger is gone, so a plug still reading
 * `charging` is asserting a charge that nothing is delivering.
 */
async function reconcileOnlineStateAtBoot(): Promise<void> {
  const stale = await Charger.find({ isOnline: true }).select('_id ocppId').lean();
  if (stale.length === 0) return;

  logger.warn(
    SCOPE,
    `${stale.length} charger(s) were marked online before the backend restarted ` +
      `(${stale.map((c) => c.ocppId).join(', ')}). Their connections were lost in the restart, ` +
      'so they are now offline until they reconnect.',
  );

  await Charger.updateMany({ isOnline: true }, { $set: { isOnline: false } });

  for (const charger of stale) {
    try {
      await sessionEvents.failOpenSessionsForCharger(
        String(charger._id),
        'ChargerDisconnected',
        'The backend restarted while this charger was connected.',
      );
    } catch (error) {
      logger.error(SCOPE, `Couldn't clean up charger ${charger.ocppId} after the restart`, error);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

export function attachOcppGateway(httpServer: HttpServer): void {
  wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;

    // Only claim our own paths. Anything else is left untouched so Module 8's Socket.IO can
    // attach to this same server without conflict.
    if (!path.startsWith(OCPP_PATH_PREFIX)) return;

    void authenticate(request)
      .then((identity) => {
        if (!identity) {
          rejectUpgrade(socket, 'unauthorized');
          return;
        }

        wss?.handleUpgrade(request, socket, head, (ws) => {
          onConnection(ws, identity);
        });
      })
      .catch((error) => {
        logger.error(SCOPE, 'A charger tried to connect but the connection setup crashed', error);
        rejectUpgrade(socket, 'error');
      });
  });

  // Before anything else: nothing can be online, because this process holds no sockets yet.
  void reconcileOnlineStateAtBoot().catch((error: unknown) =>
    logger.error(SCOPE, 'Startup check of which chargers are online failed', error),
  );

  sweepTimer = setInterval(() => void sweepStaleConnections(), SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  // Module 7: resume transaction ids where the last process left off, so a restart cannot
  // reissue an id that a persisted session already owns.
  void sessionEvents
    .highestTransactionId()
    .then((highest) => {
      registry.seedTransactionId(highest);
      if (highest > 0) {
        logger.info(
          SCOPE,
          `Next OCPP transaction id will be ${highest + 1} (continuing from before the restart)`,
        );
      }
    })
    .catch((error: unknown) => logger.error(SCOPE, "Couldn't find the last used OCPP transaction id", error));

  // Module 7: fails sessions the charger never confirmed, releasing the connector reservation.
  sessionEvents.startSessionSweeper();

  logger.info(SCOPE, `Chargers can now connect at ws://<host>${OCPP_PATH_PREFIX}<ocppId>`);
}

function onConnection(socket: WebSocket, identity: AuthenticatedCharger): void {
  const connection: registry.ChargerConnection = {
    ...identity,
    socket,
    connectedAt: new Date(),
    lastHeartbeatAt: new Date(),
    transactions: new Map(),
  };

  // Replace rather than reject: a charger reconnecting after a network blip is
  // indistinguishable from a duplicate, and rejecting would lock real hardware out behind a
  // stale socket the backend believes is alive.
  const superseded = registry.register(connection);
  if (superseded) {
    logger.warn(SCOPE, `Charger ${identity.ocppId} reconnected — dropping its old connection`);
    try {
      superseded.socket.close(CLOSE_SUPERSEDED, 'Superseded by a new connection');
    } catch {
      /* already gone */
    }
  } else {
    logger.info(SCOPE, `Charger ${identity.ocppId} connected`);
  }

  socket.on('message', (data) => {
    void onFrame(connection, data.toString());
  });

  socket.on('close', (code) => {
    // Guarded: when a reconnect replaced this socket, the OLD socket's close fires afterwards
    // and must not evict the NEW connection from the registry.
    const removed = registry.remove(identity.ocppId, socket);
    if (!removed) return;

    logger.info(SCOPE, `Charger ${identity.ocppId} disconnected: ${describeCloseCode(code)} (code ${code})`);
    void Charger.updateOne({ _id: identity.chargerId }, { $set: { isOnline: false } }).catch(
      (error: unknown) =>
        logger.error(SCOPE, `Couldn't mark disconnected charger ${identity.ocppId} offline`, error),
    );

    // The socket died. Anything still open on this charger is finished here rather than left
    // hanging — the mirror of the heartbeat sweep above, for the case where we DO get a close
    // event. Both paths are needed: a mobile link dropping mid-frame produces silence, not a
    // close, and a tidy shutdown produces a close without any silence.
    void sessionEvents
      .failOpenSessionsForCharger(
        identity.chargerId,
        'ChargerDisconnected',
        `The charger disconnected: ${describeCloseCode(code)}.`,
      )
      .catch((error: unknown) =>
        logger.error(SCOPE, `Couldn't stop the open sessions on disconnected charger ${identity.ocppId}`, error),
      );

    void announceConnectivity(identity.chargerId, identity.companyId, identity.ocppId, false);
  });

  socket.on('error', (error) => {
    logger.error(SCOPE, `Connection problem with charger ${identity.ocppId}`, error);
  });
}

/** Close every charger connection cleanly. Called during shutdown. */
export async function shutdownOcppGateway(): Promise<void> {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }

  sessionEvents.stopSessionSweeper();

  cancelPending('Gateway shutting down');

  for (const connection of registry.all()) {
    try {
      connection.socket.close(1001, 'Server shutting down');
    } catch {
      /* ignore */
    }
  }

  registry.clear();

  await new Promise<void>((resolve) => {
    if (!wss) return resolve();
    wss.close(() => resolve());
  });

  wss = null;
}
