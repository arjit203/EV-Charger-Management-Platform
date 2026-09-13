/**
 * Charger command business logic — the guarded doorway to the OCPP gateway.
 *
 * The gateway knows how to send a frame down a socket. It does NOT know who is allowed to.
 * That decision lives here, and it reuses Module 5's `assertChargerInScope`, so an operator
 * cannot remote-start a charger belonging to another company even though the gateway itself
 * has no concept of companies.
 *
 * SCOPE NOTE: these endpoints are the Module 6 TEST SURFACE. Module 7 owns the real
 * driver-facing start/stop, which will also create a ChargingSession, charge a wallet and
 * persist meter readings. None of that happens here.
 */

import { assertChargerInScope } from './charger.service';
import { Connector } from '../models/connector.model';
import { ApiError } from '../utils/ApiError';
import { sendRemoteStart, sendRemoteStop } from '../ocpp/commands';
import * as registry from '../ocpp/registry';
import type { AuthUser } from '../types/express';

export interface CommandResult {
  chargerId: string;
  ocppId: string;
  accepted: boolean;
  /** Whatever the charger answered, for visibility during testing. */
  response: Record<string, unknown>;
}

/**
 * Resolve a charger the caller may command AND that is actually reachable.
 *
 * Two separate failures worth distinguishing:
 *   403/404 — you may not touch this charger (ownership)
 *   409     — you may, but it is not connected (state)
 */
async function requireConnectedCharger(actor: AuthUser, chargerId: string) {
  const charger = await assertChargerInScope(actor, chargerId); // 403 for another company

  const connection = registry.get(charger.ocppId);
  if (!connection) {
    throw ApiError.conflict(
      'This charger is not currently connected to the OCPP gateway.',
      { ocppId: charger.ocppId },
    );
  }

  return { charger, connection };
}

/**
 * RemoteStartTransaction.
 *
 * Checked before sending: the connector exists, and is not already charging. Sending a start
 * to a busy connector would be a protocol error the charger would reject anyway — refusing
 * early gives a clearer message and avoids a pointless round trip.
 */
export async function remoteStart(
  actor: AuthUser,
  chargerId: string,
  connectorNumber: number,
  idTag: string,
): Promise<CommandResult> {
  const { charger, connection } = await requireConnectedCharger(actor, chargerId);

  const connector = await Connector.findOne({ chargerId: charger._id, connectorNumber });
  if (!connector) {
    throw ApiError.notFound(`This charger has no connector numbered ${connectorNumber}.`);
  }

  if (connector.status === 'charging' || connection.transaction) {
    throw ApiError.conflict('A charging transaction is already in progress on this charger.');
  }

  if (connector.status === 'faulted' || connector.status === 'unavailable') {
    throw ApiError.conflict(`Connector ${connectorNumber} is ${connector.status}.`);
  }

  const response = await sendRemoteStart(connection, connectorNumber, idTag);

  return {
    chargerId: String(charger._id),
    ocppId: charger.ocppId,
    accepted: response.status === 'Accepted',
    response,
  };
}

/** RemoteStopTransaction — addressed by transaction id, which only the gateway knows. */
export async function remoteStop(actor: AuthUser, chargerId: string): Promise<CommandResult> {
  const { charger, connection } = await requireConnectedCharger(actor, chargerId);

  if (!connection.transaction) {
    throw ApiError.conflict('This charger has no transaction in progress.');
  }

  const response = await sendRemoteStop(connection, connection.transaction.transactionId);

  return {
    chargerId: String(charger._id),
    ocppId: charger.ocppId,
    accepted: response.status === 'Accepted',
    response,
  };
}

/** Live connection state, for the admin UI. Scoped like everything else. */
export async function getConnectionState(actor: AuthUser, chargerId: string) {
  const charger = await assertChargerInScope(actor, chargerId);
  const connection = registry.get(charger.ocppId);

  return {
    ocppId: charger.ocppId,
    connected: Boolean(connection),
    connectedAt: connection ? connection.connectedAt.toISOString() : null,
    lastHeartbeatAt: connection ? connection.lastHeartbeatAt.toISOString() : null,
    transaction: connection?.transaction
      ? {
          transactionId: connection.transaction.transactionId,
          connectorNumber: connection.transaction.connectorNumber,
          startedAt: connection.transaction.startedAt.toISOString(),
        }
      : null,
  };
}
