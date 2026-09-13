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
  /** The one in-flight transaction, if charging. Simplified: one per charger. */
  transaction: ActiveTransaction | null;
}

const connections = new Map<string, ChargerConnection>();

/** Monotonic transaction ids for the life of the process. Module 7 replaces these. */
let nextTransactionId = 1000;

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

export function setTransaction(ocppId: string, transaction: ActiveTransaction | null): void {
  const connection = connections.get(ocppId);
  if (connection) connection.transaction = transaction;
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
