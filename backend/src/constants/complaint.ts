/**
 * Complaint constants.
 *
 * A complaint is a support ticket: a driver reporting that something went wrong, and the record
 * of what staff did about it. It is an AUDIT RECORD first and a workflow second — which is why
 * the subject and description are immutable after creation, and why `closed` is terminal.
 */

export const COMPLAINT_CATEGORIES = [
  /** The machine itself — dead screen, cable locked, will not start. */
  'charger_issue',
  /** A charge that started: stopped early, wrong energy, never confirmed. */
  'session_issue',
  /** Money — a wrong amount, a recharge that did not arrive, a disputed debit. */
  'payment_issue',
  /** The site — blocked bay, no access, lighting, signage. */
  'station_issue',
  /** Login, profile, vehicles. Nothing to do with any company's hardware. */
  'account_issue',
  'other',
] as const;

export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number];

/**
 * Deliberately absent: `connector_issue`.
 *
 * From a driver's side a faulty plug IS a charger problem — they do not think in terms of the
 * connector record. And the connector id is already derived from the anchor, so staff can see
 * exactly which plug it was without a category saying so.
 */

/* -------------------------------------------------------------------------- */

/**
 * Priority.
 *
 * Set by the DRIVER at creation and adjustable by staff afterwards. That is safe because
 * NOTHING HAPPENS FASTER when someone picks `high` — there is no SLA, no escalation, no routing
 * attached to it. It is signal, not a commitment, so there is nothing to win by exaggerating.
 *
 * No `critical`: a fourth tier with no distinct behaviour is a tier with no consumer.
 */
export const COMPLAINT_PRIORITIES = ['low', 'medium', 'high'] as const;
export type ComplaintPriority = (typeof COMPLAINT_PRIORITIES)[number];

/* -------------------------------------------------------------------------- */

/**
 * Lifecycle.
 *
 *   open ──▶ in_progress ──▶ resolved ──▶ closed
 *     ▲            │
 *     └────────────┘
 *
 * `closed` is TERMINAL. A driver who says "it is still broken" files a NEW complaint that may
 * reference the old one — mutating a closed ticket back open destroys the record of what was
 * concluded and when, which is the whole point of keeping one.
 *
 * No `rejected`: an invalid complaint moves to `closed` with a resolution note explaining why.
 * A parallel terminal state with no distinct behaviour is the same thing `cancelled` would have
 * been in Module 7 — a branch nobody walks.
 */
export const COMPLAINT_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

/**
 * THE TRANSITION TABLE. A table, not prose — the same discipline as Module 9's activation
 * ordering. Anything not listed here is a 409 naming the current status.
 *
 * `in_progress -> open` is the one permitted backward move: work legitimately pauses while a
 * ticket waits on the driver or gets reassigned. Everything else moves forward or not at all.
 */
export const ALLOWED_TRANSITIONS: Record<ComplaintStatus, ComplaintStatus[]> = {
  open: ['in_progress'],
  in_progress: ['open', 'resolved'],
  resolved: ['closed'],
  closed: [],
};

/**
 * Transitions that CONCLUDE a support interaction, restricted to cpo_admin and super_admin.
 *
 * An operator is field staff: acknowledging and working a ticket is the job, formally closing
 * one is an administrative act — especially one that may touch a payment dispute, where the
 * resolution note is the only record of what was decided.
 */
export const CONCLUDING_TRANSITIONS: ComplaintStatus[] = ['resolved', 'closed'];
