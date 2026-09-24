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
 * Priority — an INTERNAL triage field. The driver never sets it and never sees it.
 *
 * Help desks (Zendesk, Freshdesk, ServiceNow) keep priority on the agent side for the reason
 * anyone would guess: ask a customer how urgent their problem is and nearly everyone answers
 * "high", which makes the field worthless for ordering a queue. ITIL frames priority as IMPACT
 * × URGENCY — how many people are affected and how badly — and that is something the support
 * side judges, not the reporter.
 *
 * So the system sets a STARTING priority from facts it already has (the category, and whether
 * the charge actually failed), and any staff member can re-triage it. The driver's own sense
 * of urgency still reaches staff — in the words they write.
 *
 * No `critical`: a fourth tier with no distinct behaviour is a tier with no consumer.
 */
export const COMPLAINT_PRIORITIES = ['low', 'medium', 'high'] as const;
export type ComplaintPriority = (typeof COMPLAINT_PRIORITIES)[number];

/**
 * The starting priority for each category — impact first.
 *
 *   charger_issue  high    a broken charger blocks EVERY driver who arrives after this one,
 *                          and the CPO loses revenue for as long as it stays down
 *   session_issue  medium  one driver, one charge — raised to high when the session actually
 *                          FAILED (see complaint.service), because that driver may be stranded
 *   payment_issue  medium  money matters, but a disputed amount can be corrected later
 *   station_issue  medium  blocked bay, lighting, access
 *   account_issue  medium  one person, usually no hardware involved
 *   other          low     staff re-triage once they have read it
 */
export const DEFAULT_PRIORITY_BY_CATEGORY: Record<ComplaintCategory, ComplaintPriority> = {
  charger_issue: 'high',
  session_issue: 'medium',
  payment_issue: 'medium',
  station_issue: 'medium',
  account_issue: 'medium',
  other: 'low',
};

/* -------------------------------------------------------------------------- */

/**
 * Lifecycle — the shape Zendesk, Freshdesk and Jira Service Management all share.
 *
 *              ┌─────────── reopen (driver, with a reason) ───────────┐
 *              ▼                                                      │
 *   open ◀──▶ in_progress ──▶ resolved ──▶ closed                     │
 *     │            │             └────────────────────────────────────┘
 *     └────────────┴──▶ closed   (admin only, with a note: duplicate / invalid / spam)
 *
 * RESOLVED IS NOT CLOSED. `resolved` means "staff believe it is fixed" — a claim the driver can
 * still dispute. `closed` means "finished, no more changes" and is TERMINAL. The gap between them
 * is the driver's window to say "no, it is still broken":
 *
 *   - the driver CONFIRMS          -> closed
 *   - the driver REOPENS (reason)  -> open, back in the staff queue
 *   - nobody does anything         -> closed automatically after AUTO_CLOSE_AFTER_MS
 *
 * `closed` stays terminal. A driver whose problem comes back after closure files a NEW complaint
 * linked with `followUpOf` — mutating a closed ticket back open would destroy the record of what
 * was concluded and when, which is the whole point of keeping one.
 *
 * No `rejected` state: an invalid complaint is closed directly with a note saying why.
 */
export const COMPLAINT_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

/**
 * THE TRANSITION TABLE for STAFF. A table, not prose. Anything not listed is a 409 naming the
 * current status. The driver's two moves (confirm, reopen) have their own endpoints and are not
 * in this table, because they are a different actor making a different claim.
 *
 * `in_progress -> open` is a legitimate backward move: work pauses while a ticket waits on the
 * driver or goes back to the queue for someone else to pick up.
 *
 * `resolved -> open` lets an ADMIN take back a resolution they got wrong, before the driver has
 * to reopen it themselves.
 */
export const ALLOWED_TRANSITIONS: Record<ComplaintStatus, ComplaintStatus[]> = {
  open: ['in_progress', 'closed'],
  in_progress: ['open', 'resolved', 'closed'],
  resolved: ['open', 'closed'],
  closed: [],
};

/**
 * What an OPERATOR may conclude — by CATEGORY, not across the board.
 *
 * THE EARLIER RULE WAS WRONG FOR THE JOB. Operators are the field / NOC staff who actually fix
 * chargers: they read the fault, reset or release the plug, attend the site, and confirm it
 * works. Forbidding them to resolve a ticket they fixed meant every hardware ticket waited for an
 * admin to type "fixed" on their behalf — which is not how a CPO's support desk runs.
 *
 * The line that IS real is money. A payment dispute ends in a decision about a driver's balance,
 * and that stays with an administrator; so do account problems (they belong to no company's
 * hardware, and only reach the platform admin anyway). Operators can still work those tickets,
 * add notes and pass them up — they just cannot conclude them.
 */
export const OPERATOR_RESOLVABLE_CATEGORIES: readonly ComplaintCategory[] = [
  'charger_issue',
  'session_issue',
  'station_issue',
  'other',
];

/**
 * Transitions an operator may NOT make, whatever the category.
 *
 * Closing — with or without a resolution — skips or shortens the driver's chance to dispute (and
 * closing unresolved is the duplicate / invalid / spam call), while overturning a resolution
 * overrides a colleague's conclusion. Both are administrative calls.
 */
export const ADMIN_ONLY_TRANSITIONS: { from: ComplaintStatus | '*'; to: ComplaintStatus }[] = [
  { from: 'open', to: 'closed' },
  { from: 'in_progress', to: 'closed' },
  // "Close now" on a resolved ticket cuts short the driver's window to dispute it.
  { from: 'resolved', to: 'closed' },
  { from: 'resolved', to: 'open' },
];

/**
 * How long a resolved complaint waits for the driver before closing itself.
 *
 * Seven days is a common help-desk default (Zendesk's is four, Freshdesk's is configurable). Long
 * enough for a driver to return to the same charger and find out whether it really was fixed;
 * short enough that the queue does not fill with tickets nobody will ever touch again.
 */
export const AUTO_CLOSE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** How often the auto-close sweep runs. Hourly is plenty for a seven-day window. */
export const COMPLAINT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Who made a change, as recorded in a complaint's history. `system` is the auto-close sweep. */
export const COMPLAINT_ACTORS = ['driver', 'operator', 'cpo_admin', 'super_admin', 'system'] as const;
export type ComplaintActor = (typeof COMPLAINT_ACTORS)[number];
