/**
 * Live gateway diagnostics — read-only.
 *
 * MODULE 7 EMPTIED THIS FILE OUT, ON PURPOSE.
 *
 * It used to hold `remoteStart` and `remoteStop`: a guarded doorway letting an admin command a
 * charger directly. That was correct for Module 6, when there was nothing to record. It became
 * a defect the moment ChargingSession existed, because an admin could start real charging with
 * no session row — energy the platform could not bill, display or explain.
 *
 * Both were deleted rather than kept "just for testing". Two ways to start a charger is one
 * way too many: the invariant "a charging connector always has exactly one session describing
 * it" only holds if there is a single path, and `chargingSession.service.ts` is now that path.
 *
 * What is left cannot change anything — it only reports what the in-memory registry believes
 * right now, which is the one thing the database mirror cannot answer.
 */

import { assertChargerInScope } from './charger.service';
import * as registry from '../ocpp/registry';
import type { AuthUser } from '../types/express';

/** Live connection state, for the admin UI. Scoped like everything else. */
export async function getConnectionState(actor: AuthUser, chargerId: string) {
  const charger = await assertChargerInScope(actor, chargerId);
  const connection = registry.get(charger.ocppId);

  return {
    ocppId: charger.ocppId,
    connected: Boolean(connection),
    connectedAt: connection ? connection.connectedAt.toISOString() : null,
    lastHeartbeatAt: connection ? connection.lastHeartbeatAt.toISOString() : null,
    /**
     * A LIST, not a single transaction.
     *
     * Module 6 reported one, which quietly misrepresented any charger with more than one plug
     * in use - the admin saw whichever transaction started most recently and no hint that
     * another was running. Module 8 puts this on a live dashboard, so the inaccuracy would
     * have become visible to users rather than just wrong in an API.
     */
    transactions: registry.listTransactions(charger.ocppId).map((transaction) => ({
      transactionId: transaction.transactionId,
      connectorNumber: transaction.connectorNumber,
      startedAt: transaction.startedAt.toISOString(),
    })),
  };
}
