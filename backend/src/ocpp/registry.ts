/**
 * In-memory registry of live charger connections.
 *
 * This is the thing that makes "send a command to charger X" possible at all: a WebSocket is
 * an open socket object, not something you can look up in MongoDB. The registry maps an
 * `ocppId` to the actual socket so `commands.ts` can write to it.
 *
 * IN MEMORY, DELIBERATELY — and this is the honest scaling limit of the current design:
 * with two backend instances behind a load balancer, a charger connected to instance A is
 * invisible to instance B, so a command issued on B cannot reach it. The real fix is a
 * pub/sub layer (Redis) or sticky routing by charger id. That is a Module 17 / scale
 * conversation, not something to bolt on now — but it is the first thing to say if an
 * interviewer asks how this scales.
 *
 * Transaction state also lives here, not in MongoDB. Module 7 owns persistent
 * ChargingSession records; a transaction here is just the in-flight bookkeeping the gateway
 * needs to match a StopTransaction to its StartTransaction.
 */

import type { WebSocket } from 'ws';

export interface ActiveTransaction {
  transactionId: number;
  connectorNumber: number;
  idTag: string;
  meterStartWh: number;
  startedAt: Date;
}

export interface ChargerConnection {
  ocppId: string;
  chargerId: string;
  companyId: string;
  socket: WebSocket;
  connectedAt: Date;
  lastHeartbeatAt: Date;
  /**
   * In-flight transactions, KEYED BY CONNECTOR NUMBER.
   *
   * MODULE 6 PATCH (applied during Module 8). This was a single
   * `transaction: ActiveTransaction | null` field, on the assumption that a charger runs one
   * transaction at a time. That assumption is wrong for any charger with more than one plug,
   * and a probe proved three distinct failures:
   *
   *   1. OVERWRITE      the second StartTransaction clobbered the first's bookkeeping, so
   *                     GET /chargers/:id/connection reported only the most recent one
   *   2. MISROUTING     OCPP 1.6 makes `transactionId` OPTIONAL on MeterValues. Without it we
   *                     fell back to the single slot and credited energy to whichever session
   *                     happened to be sitting there - i.e. to the wrong driver
   *   3. PREMATURE CLEAR  any StopTransaction nulled the slot, so the SURVIVING session's
   *                     later readings were dropped entirely
   *
   * Module 7's database layer was never affected: the partial unique index is per connector,
   * and anything carrying an explicit transactionId is resolved by a query. This map fixes the
   * gateway's own bookkeeping, which is what the fallback and the diagnostics read.
   *
   * Still scratch state, not truth - the ChargingSession record remains authoritative.
   */
  transactions: Map<number, ActiveTransaction>;
}

const connections = new Map<string, ChargerConnection>();

/**
 * Monotonic OCPP transaction ids.
 *
 * MODULE 7 MADE THE STARTING POINT MATTER. While nothing was persisted, beginning at 1000 on
 * every boot was harmless. Now sessions outlive the process, and a restart that handed out
 * 1001 again would either collide with the unique index on an old session, or — far worse —
 * silently attach a live charger's MeterValues to a completed charge belonging to someone
 * else. `seedTransactionId` is called once at gateway start with the highest id ever issued.
 *
 * Still in memory rather than a database counter: ids only need to be unique, not gapless, and
 * a round trip to Mongo on every StartTransaction would buy nothing.
 */
let nextTransactionId = 1000;

export function seedTransactionId(highestIssued: number): void {
  if (highestIssued > nextTransactionId) nextTransactionId = highestIssued;
}

export function allocateTransactionId(): number {
  nextTransactionId += 1;
  return nextTransactionId;
}

/**
 * Register a connection, returning any previous one it replaced.
 *
 * Replacing rather than rejecting is deliberate: a charger reconnecting after a network blip
 * is indistinguishable from a duplicate, and rejecting would leave real hardware permanently
 * locked out behind a stale socket the backend thinks is alive.
 */
export function register(connection: ChargerConnection): ChargerConnection | null {
  const previous = connections.get(connection.ocppId) ?? null;
  connections.set(connection.ocppId, connection);
  return previous;
}

export function get(ocppId: string): ChargerConnection | undefined {
  return connections.get(ocppId);
}

export function isConnected(ocppId: string): boolean {
  return connections.has(ocppId);
}

/**
 * Remove a connection, but only if the stored socket is the one given.
 *
 * The guard matters: when a reconnect replaces an old socket, the OLD socket's `close` event
 * fires afterwards. Without this check it would delete the NEW connection's registry entry
 * and silently orphan a live charger.
 */
export function remove(ocppId: string, socket?: WebSocket): boolean {
  const existing = connections.get(ocppId);
  if (!existing) return false;
  if (socket && existing.socket !== socket) return false;
  connections.delete(ocppId);
  return true;
}

export function touchHeartbeat(ocppId: string): void {
  const connection = connections.get(ocppId);
  if (connection) connection.lastHeartbeatAt = new Date();
}

/** Record a transaction against the connector it is actually running on. */
export function setTransaction(ocppId: string, transaction: ActiveTransaction): void {
  const connection = connections.get(ocppId);
  if (connection) connection.transactions.set(transaction.connectorNumber, transaction);
}

/**
 * Forget ONE connector's transaction.
 *
 * Deliberately narrow: clearing everything on a StopTransaction is precisely the bug this
 * patch fixes, because a two-plug charger stopping one session would lose track of the other.
 */
export function clearTransaction(ocppId: string, connectorNumber: number): void {
  connections.get(ocppId)?.transactions.delete(connectorNumber);
}

/** The transaction running on a given plug, used when a charger omits `transactionId`. */
export function getTransactionByConnector(
  ocppId: string,
  connectorNumber: number,
): ActiveTransaction | undefined {
  return connections.get(ocppId)?.transactions.get(connectorNumber);
}

/** Reverse lookup, for a StopTransaction that names a transaction but not a connector. */
export function findTransactionById(
  ocppId: string,
  transactionId: number,
): ActiveTransaction | undefined {
  const connection = connections.get(ocppId);
  if (!connection) return undefined;

  for (const transaction of connection.transactions.values()) {
    if (transaction.transactionId === transactionId) return transaction;
  }
  return undefined;
}

/** Everything this charger currently believes it is running. For diagnostics. */
export function listTransactions(ocppId: string): ActiveTransaction[] {
  return [...(connections.get(ocppId)?.transactions.values() ?? [])];
}

export function all(): ChargerConnection[] {
  return [...connections.values()];
}

export function count(): number {
  return connections.size;
}

/** Used on shutdown so the process can exit cleanly. */
export function clear(): void {
  connections.clear();
}
