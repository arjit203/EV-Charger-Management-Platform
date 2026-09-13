/**
 * Outbound OCPP commands — backend to charger.
 *
 * This is the direction REST cannot do. A charger sits behind a mobile SIM with no public IP
 * and no inbound port; you cannot make an HTTP request *to* it. The charger opens a WebSocket
 * outward, and this module writes down that already-open socket.
 *
 * Because both sides can have messages in flight simultaneously, every CALL we send is
 * tracked by its `uniqueId` until the matching CALLRESULT or CALLERROR comes back. Without
 * that correlation we could not tell whether a reply belongs to our RemoteStop or to
 * something else entirely.
 */

import crypto from 'crypto';

import { logger } from '../utils/logger';
import {
  buildCall,
  MessageType,
  OcppError,
  OcppErrorCode,
  type OcppCallError,
  type OcppCallResult,
  type OcppPayload,
} from './messages';
import type { ChargerConnection } from './registry';

const SCOPE = 'ocpp';

/** A charger that does not answer within this window is treated as unresponsive. */
const RESPONSE_TIMEOUT_MS = 10_000;

interface PendingCall {
  resolve: (payload: OcppPayload) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  action: string;
}

const pending = new Map<string, PendingCall>();

/**
 * Route an incoming CALLRESULT/CALLERROR to whoever is awaiting it.
 *
 * Returns false if nothing was waiting — which happens for a late reply after a timeout, and
 * is logged rather than treated as an error.
 */
export function handleResponse(message: OcppCallResult | OcppCallError): boolean {
  const call = pending.get(message.uniqueId);
  if (!call) return false;

  clearTimeout(call.timer);
  pending.delete(message.uniqueId);

  if (message.type === MessageType.CALLERROR) {
    call.reject(new OcppError(message.errorCode, message.errorDescription, message.errorDetails));
  } else {
    call.resolve(message.payload);
  }

  return true;
}

/** Send a CALL and await the charger's reply. */
export function sendCall(
  connection: ChargerConnection,
  action: string,
  payload: OcppPayload,
): Promise<OcppPayload> {
  const uniqueId = crypto.randomUUID();

  return new Promise<OcppPayload>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(uniqueId);
      reject(new OcppError(OcppErrorCode.INTERNAL_ERROR, `Charger did not respond to ${action}`));
    }, RESPONSE_TIMEOUT_MS);

    // `unref` so a pending command can never hold the process open during shutdown.
    timer.unref();

    pending.set(uniqueId, { resolve, reject, timer, action });

    try {
      connection.socket.send(buildCall(uniqueId, action, payload));
      logger.info(SCOPE, `${action} sent to ${connection.ocppId}`);
    } catch (error) {
      clearTimeout(timer);
      pending.delete(uniqueId);
      reject(
        new OcppError(
          OcppErrorCode.INTERNAL_ERROR,
          `Failed to send ${action}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  });
}

/** RemoteStartTransaction — "begin charging on this connector for this token". */
export function sendRemoteStart(
  connection: ChargerConnection,
  connectorNumber: number,
  idTag: string,
): Promise<OcppPayload> {
  return sendCall(connection, 'RemoteStartTransaction', { connectorId: connectorNumber, idTag });
}

/** RemoteStopTransaction — addressed by transaction id, not connector. */
export function sendRemoteStop(
  connection: ChargerConnection,
  transactionId: number,
): Promise<OcppPayload> {
  return sendCall(connection, 'RemoteStopTransaction', { transactionId });
}

/** Drop everything awaiting a reply — used on shutdown and when a socket dies. */
export function cancelPending(reason: string): void {
  for (const [uniqueId, call] of pending) {
    clearTimeout(call.timer);
    call.reject(new OcppError(OcppErrorCode.INTERNAL_ERROR, reason));
    pending.delete(uniqueId);
  }
}

export function pendingCount(): number {
  return pending.size;
}
