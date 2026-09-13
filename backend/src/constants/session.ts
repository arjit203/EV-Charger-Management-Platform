/**
 * Charging session constants.
 *
 * THIS IS A FOURTH, SEPARATE STATE MACHINE. The project now has four status concepts and
 * none of them may be conflated:
 *
 *   Charger.status      administrative — a human marked this machine for maintenance
 *   Charger.isOnline    connectivity   — is the OCPP WebSocket up
 *   Connector.status    operational    — is THIS plug free / charging / faulted
 *   ChargingSession     transactional  — the lifecycle of one car's visit  <- this file
 *
 * Lifecycle:
 *
 *   initiating ──StartTransaction──▶ active ──stop requested──▶ stopping ──StopTransaction──▶ completed
 *        │                             │                            │
 *        └──── timeout / rejected ─────┴──── charger disconnect ─────┴──▶ failed
 *
 * `cancelled` is deliberately absent: no actor in this system cancels a session. A start the
 * charger rejects is `failed`. Adding a state with no producer would be inventing a branch
 * nobody walks.
 */

import { env } from '../config/env';

export const SESSION_STATUSES = [
  /** Created and RemoteStart sent — WAITING for the charger to confirm. Not yet charging. */
  'initiating',
  /** StartTransaction received. Energy is flowing. */
  'active',
  /** RemoteStop sent, waiting for StopTransaction. */
  'stopping',
  /** StopTransaction processed and energy finalised. The normal end. */
  'completed',
  /** Never confirmed, or the charger vanished mid-session. Energy may still be recorded. */
  'failed',
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * Statuses that occupy a connector.
 *
 * Used by the partial unique index that guarantees ONE open session per connector — the
 * concurrency protection lives in the database, not in an application `if`.
 */
export const OPEN_SESSION_STATUSES: SessionStatus[] = ['initiating', 'active', 'stopping'];

/** Why a session ended. */
export const STOP_REASONS = [
  'Remote', // a stop request from the app
  'Local', // stopped at the charger itself
  'ChargerDisconnected', // the charger vanished mid-session
  'StartTimeout', // never confirmed the start
  'Rejected', // the charger refused the start
] as const;

export type StopReason = (typeof STOP_REASONS)[number];

/**
 * How long a session may sit in `initiating` before the sweeper fails it.
 *
 * Sized against the two real numbers around it: `commands.ts` gives up on an unanswered CALL
 * after 10s, and a charger that accepted a RemoteStart still needs a moment to lock the cable
 * and run Authorize before StartTransaction arrives. The 20s default covers that and nothing
 * more — an over-generous bound would leave the connector reserved long after the attempt was
 * dead, which is worse for the driver than a clear failure.
 */
export const START_CONFIRMATION_TIMEOUT_MS = env.sessionStartTimeoutSeconds * 1000;

/** How often the sweeper looks for expired `initiating` sessions. One timer for all of them. */
export const SESSION_SWEEP_INTERVAL_MS = 5_000;

/**
 * The idTag we issue per session.
 *
 * OCPP 1.6 caps idTag at 20 characters, so an ObjectId (24 hex) cannot be used directly.
 * A random per-session tag is better anyway: it is the credential the charger quotes back in
 * Authorize, and a random one cannot be guessed from a user id.
 */
export const SESSION_ID_TAG_PREFIX = 'EV';
export const SESSION_ID_TAG_RANDOM_HEX = 18;
