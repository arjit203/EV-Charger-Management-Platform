/**
 * Notification constants.
 *
 * THE TEST FOR WHETHER SOMETHING DESERVES A NOTIFICATION AT ALL:
 *
 *   Does someone need a PERSISTENT, PERSONAL record that a live dashboard does not already
 *   provide?
 *
 * A driver has no screen watching their charge — they need the record. Staff watching
 * `/monitor` already see charger connectivity pushed live by Module 8, so a notification row
 * there would duplicate a channel that already works. That is why the list below is all
 * driver-facing except one, and why `charger_fault` / `charger_offline` are absent.
 */

export const NOTIFICATION_TYPES = [
  /* ------------------------------- driver ------------------------------- */
  /** The charger confirmed the start — energy is actually flowing. */
  'charging_started',
  /** StopTransaction processed, energy finalised. */
  'charging_completed',
  /** Never started, or the charger vanished mid-charge. Energy may still have been billed. */
  'charging_failed',
  /** The wallet was debited for a completed charge. */
  'payment_success',
  /** The charge could not be collected — the balance was short. */
  'payment_pending',
  /** A verified Razorpay payment credited the wallet. */
  'wallet_recharged',
  /** A complaint the driver filed changed status. */
  'complaint_updated',

  /* -------------------------------- staff ------------------------------- */
  /**
   * A driver filed a complaint about this company's hardware.
   *
   * The only staff-facing type, and the only one that FANS OUT: one row per cpo_admin and
   * operator of that company. There is no shared/broadcast row anywhere in this module — see
   * the note on `dedupeKey` below.
   */
  'complaint_created',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * What the notification points at, so the UI knows where to navigate.
 *
 * Only routes that actually exist. There is no `charger` reference type because nothing
 * currently produces a charger-scoped notification.
 */
export const REFERENCE_TYPES = ['charging_session', 'complaint', 'payment'] as const;
export type ReferenceType = (typeof REFERENCE_TYPES)[number];

/**
 * DEDUPE KEYS — how "the same event twice" is recognised.
 *
 * A unique index on `{ userId, dedupeKey }` is what stops a repeated business event producing a
 * repeated notification. Same mechanism as Module 7's connector index, Module 9's tariff index
 * and Module 10's payment index: if a rule must hold under retry, the database enforces it.
 *
 * WHY A KEY RATHER THAN `{ userId, referenceType, referenceId, type }`: that looks equivalent
 * and is not. `complaint_updated` fires on every status change — in_progress, resolved, closed
 * are three distinct, individually useful events sharing one reference and one type. Indexing
 * on the ids alone would silently swallow the second and third.
 *
 * "The same event" is a business concept the CALLER knows and an index cannot infer, so the
 * caller states it:
 *
 *   session:<id>:started        complaint:<id>:resolved
 *   session:<id>:completed      complaint:<id>:closed
 *   session:<id>:paid           payment:<id>:recharged
 *   session:<id>:pending        complaint:<id>:created   (one per staff member)
 *
 * THE CASE THAT MAKES THIS ESSENTIAL, not theoretical: Module 10's settlement sweeper retries an
 * unpaid session every 15 seconds, indefinitely. Without this index a driver who cannot afford a
 * charge would be told "payment pending" four times a minute until they topped up.
 */
export const dedupeKeys = {
  session: (sessionId: string, event: string) => `session:${sessionId}:${event}`,
  complaint: (complaintId: string, event: string) => `complaint:${complaintId}:${event}`,
  payment: (paymentId: string, event: string) => `payment:${paymentId}:${event}`,
} as const;
