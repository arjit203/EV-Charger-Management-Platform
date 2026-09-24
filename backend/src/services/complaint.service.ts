/**
 * Complaint business logic.
 *
 * Two rules do all the work here, and both are reused rather than invented:
 *
 *   1. THE ANCHOR IS RESOLVED THROUGH THE CALLER'S OWN SCOPE, and every other resource id is
 *      derived from it. Module 5's ownership chain and Module 9's tariff resolution, applied a
 *      third time.
 *   2. THE ROLE PICKS THE SCOPE. A driver reads by ownership, staff read by company. Module 7's
 *      sessions and Module 10's payments already work this way.
 */

import { Types } from 'mongoose';

import { Complaint, toPublicComplaint, type ComplaintDocument, type PublicComplaint } from '../models/complaint.model';
import { ChargingSession } from '../models/chargingSession.model';
import { Charger } from '../models/charger.model';
import {
  ADMIN_ONLY_TRANSITIONS,
  ALLOWED_TRANSITIONS,
  AUTO_CLOSE_AFTER_MS,
  COMPLAINT_SWEEP_INTERVAL_MS,
  DEFAULT_PRIORITY_BY_CATEGORY,
  type ComplaintActor,
  type ComplaintCategory,
  type ComplaintPriority,
  type ComplaintStatus,
} from '../constants/complaint';
import { ROLES } from '../constants/roles';
import { ApiError } from '../utils/ApiError';
import { applyCompanyScope } from '../utils/companyScope';
import { applyOwnerScope } from '../utils/ownerScope';
import { logger } from '../utils/logger';
import * as notify from './notification.service';
import type { Paginated } from '../types/pagination';
import type { AuthUser } from '../types/express';
import type {
  CreateComplaintInput,
  ListComplaintsQuery,
  UpdateComplaintInput,
} from '../validators/complaint.validator';

const SCOPE = 'complaint';

/* -------------------------------------------------------------------------- */
/* Scoping                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Who may see which complaints.
 *
 * A complaint has two legitimate audiences — the driver who reported it, and the company whose
 * hardware it concerns — so the role picks, rather than the two being combined.
 *
 * NOTE what falls out of this for a company-scoped caller: `applyCompanyScope` adds
 * `companyId: <theirs>`, and a platform-level complaint has `companyId: null`, so it simply
 * never matches. An account problem from a driver who has never used their stations is
 * invisible to a CPO without any special case.
 */
function applyReadScope(actor: AuthUser, filter: Record<string, unknown>): Record<string, unknown> {
  if (actor.role === ROLES.DRIVER) return applyOwnerScope(actor, filter);
  return applyCompanyScope(actor, filter);
}

function notFoundOrForbidden(actor: AuthUser): ApiError {
  // Drivers and super_admin get 404; company-scoped callers get 403 even for ids that do not
  // exist, so the endpoint cannot be used to probe which complaint ids are real.
  return actor.role === ROLES.SUPER_ADMIN || actor.role === ROLES.DRIVER
    ? ApiError.notFound('Complaint not found.')
    : ApiError.forbidden('You can only access complaints for your own company.');
}

async function assertComplaintInScope(
  actor: AuthUser,
  complaintId: string,
): Promise<ComplaintDocument> {
  const complaint = await Complaint.findOne(applyReadScope(actor, { _id: complaintId }));
  if (!complaint) throw notFoundOrForbidden(actor);
  return complaint;
}

/* -------------------------------------------------------------------------- */
/* Anchor resolution                                                          */
/* -------------------------------------------------------------------------- */

interface ResolvedAnchor {
  companyId: Types.ObjectId | null;
  chargingSessionId: Types.ObjectId | null;
  chargerId: Types.ObjectId | null;
  stationId: Types.ObjectId | null;
  connectorId: Types.ObjectId | null;
}

const NO_ANCHOR: ResolvedAnchor = {
  companyId: null,
  chargingSessionId: null,
  chargerId: null,
  stationId: null,
  connectorId: null,
};

/**
 * Turn ONE client-supplied id into the full set of related ids.
 *
 * THIS IS WHY THE MISMATCH ATTACK IS UNREPRESENTABLE. The prompt's example — a session from
 * company B submitted alongside a charger from company A — cannot be expressed, because the
 * request has no field for the second id. The client sends an anchor; everything else comes
 * from the database.
 *
 * The anchor itself is resolved THROUGH THE CALLER'S SCOPE, so a driver referencing someone
 * else's session gets a 404 rather than a complaint that leaks which sessions exist.
 *
 * No anchor is a legitimate case: "I cannot log in" concerns no company's hardware, and the
 * resulting complaint is platform-level.
 */
async function resolveAnchor(
  actor: AuthUser,
  input: CreateComplaintInput,
): Promise<ResolvedAnchor> {
  if (input.chargingSessionId) {
    /*
     * Owner-scoped for a driver: `applyOwnerScope` puts `userId` INSIDE the query, so another
     * driver's session cannot be returned at all. Company-scoped for staff, in the rare case
     * they file on someone's behalf.
     */
    const session = await ChargingSession.findOne(
      applyReadScope(actor, { _id: input.chargingSessionId }),
    );

    if (!session) throw ApiError.notFound('Charging session not found.');

    // All four already live on the session, denormalised by Module 7 — one fetch, no joins.
    return {
      companyId: session.companyId,
      chargingSessionId: session._id,
      chargerId: session.chargerId,
      stationId: session.stationId,
      connectorId: session.connectorId,
    };
  }

  if (input.chargerId) {
    /*
     * The second anchor exists for a real case the session anchor cannot cover: "I arrived and
     * it was broken, I never started a charge." There is no session to point at.
     *
     * NOT scoped to the caller: a charger is public infrastructure, and a driver belongs to no
     * company. Anyone who can stand in front of it can complain about it. Nothing sensitive is
     * exposed — the complaint stores ids, and reading the charger itself still requires the
     * Module 5 permissions.
     */
    const charger = await Charger.findById(input.chargerId).select('_id stationId companyId');

    if (!charger) throw ApiError.notFound('Charger not found.');

    return {
      companyId: charger.companyId,
      chargingSessionId: null,
      chargerId: charger._id,
      stationId: charger.stationId,
      connectorId: null,
    };
  }

  return NO_ANCHOR;
}

/* -------------------------------------------------------------------------- */
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The starting priority, from facts the platform already has — never from the reporter.
 *
 * Two facts can raise it above the category default:
 *   - the anchored charge actually FAILED: this driver may be stuck at the charger now
 *   - it is a FOLLOW-UP: the problem came back after support said it was fixed
 *
 * Staff can change it either way. This is a sensible first guess, not a verdict.
 */
async function initialPriority(
  category: ComplaintCategory,
  chargingSessionId: Types.ObjectId | null,
  isFollowUp: boolean,
): Promise<ComplaintPriority> {
  if (isFollowUp) return 'high';

  if (category === 'session_issue' && chargingSessionId) {
    const session = await ChargingSession.findById(chargingSessionId).select('status').lean();
    if (session?.status === 'failed') return 'high';
  }

  return DEFAULT_PRIORITY_BY_CATEGORY[category];
}

/**
 * File a complaint.
 *
 * `userId` comes from the verified token. `companyId` and the resource ids come from the anchor.
 * The only things the client actually decides are the category and the words. Priority is
 * triaged by the system — see `initialPriority`.
 */
export async function createComplaint(
  actor: AuthUser,
  input: CreateComplaintInput,
): Promise<PublicComplaint> {
  let anchor: ResolvedAnchor;
  let followUpOf: Types.ObjectId | null = null;

  if (input.followUpOf) {
    /*
     * A FOLLOW-UP to a closed complaint — "it broke again". The standard help-desk answer to a
     * problem that returns after closure: a new ticket linked to the old one, so the closed
     * record stays exactly as concluded while staff can still see the history.
     *
     * Owner-scoped like every driver read, so a driver cannot link to someone else's ticket. The
     * anchor is INHERITED from the original — same session or charger, derived server-side, never
     * resubmitted — which keeps Module 11's "at most one anchor, never trusted" rule intact.
     */
    const original = await assertComplaintInScope(actor, input.followUpOf);

    if (original.status !== 'closed') {
      throw ApiError.conflict(
        original.status === 'resolved'
          ? 'That complaint is resolved but not closed yet — reopen it instead of filing a new one.'
          : 'That complaint is still open. Add to it instead of filing a new one.',
      );
    }

    anchor = {
      companyId: original.companyId,
      chargingSessionId: original.chargingSessionId,
      chargerId: original.chargerId,
      stationId: original.stationId,
      connectorId: original.connectorId,
    };
    followUpOf = original._id;
  } else {
    anchor = await resolveAnchor(actor, input);
  }

  const complaint = await Complaint.create({
    userId: new Types.ObjectId(actor.id),
    ...anchor,
    followUpOf,
    category: input.category,
    subject: input.subject,
    description: input.description,
    priority: await initialPriority(input.category, anchor.chargingSessionId, followUpOf !== null),
    status: 'open',
  });

  logger.info(
    SCOPE,
    `${actor.email} opened a ${input.category} complaint: "${input.subject}" [complaint ${String(complaint._id)}]`,
  );

  void notify.complaintCreated(complaint);

  return toPublicComplaint(complaint);
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export async function listComplaints(
  actor: AuthUser,
  query: ListComplaintsQuery,
): Promise<Paginated<PublicComplaint>> {
  const filter: Record<string, unknown> = {};

  if (query.status) filter.status = query.status;
  if (query.category) filter.category = query.category;
  if (query.priority) filter.priority = query.priority;
  if (query.stationId) filter.stationId = new Types.ObjectId(query.stationId);
  if (query.chargerId) filter.chargerId = new Types.ObjectId(query.chargerId);

  const scoped = applyReadScope(actor, filter);

  const page = query.page ?? 1;
  const limit = query.limit ?? 20;

  const [items, total] = await Promise.all([
    Complaint.find(scoped).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Complaint.countDocuments(scoped),
  ]);

  return {
    items: items.map(toPublicComplaint),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

/**
 * The live state of a session a complaint is disputing.
 *
 * DERIVED AT READ TIME, never copied onto the complaint. Staff resolving a payment dispute need
 * to know whether the charge is still outstanding RIGHT NOW — a snapshot taken when the ticket
 * was filed would be stale the moment the driver topped up.
 *
 * Read-only, and that is the whole boundary of this module's relationship with money: a
 * complaint can SEE payment state, and can do nothing to it. Resolving a dispute writes a note,
 * not a ledger row — see the design doc's D1.
 */
export interface DisputedSessionView {
  sessionId: string;
  status: string;
  paymentStatus: string;
  energyConsumedKwh: number;
  amountPaise: number | null;
  appliedPricePerKwhPaise: number | null;
  startedAt: string | null;
  endedAt: string | null;
}

export async function getComplaintContext(
  complaint: ComplaintDocument,
): Promise<DisputedSessionView | null> {
  if (!complaint.chargingSessionId) return null;

  const session = await ChargingSession.findById(complaint.chargingSessionId);
  if (!session) return null;

  return {
    sessionId: String(session._id),
    status: session.status,
    paymentStatus: session.paymentStatus,
    energyConsumedKwh: Number((session.energyConsumedWh / 1000).toFixed(3)),
    amountPaise: session.amountPaise,
    appliedPricePerKwhPaise: session.appliedPricePerKwhPaise,
    startedAt: session.startedAt ? session.startedAt.toISOString() : null,
    endedAt: session.endedAt ? session.endedAt.toISOString() : null,
  };
}

export async function getComplaintById(
  actor: AuthUser,
  complaintId: string,
): Promise<{ complaint: PublicComplaint; session: DisputedSessionView | null }> {
  const complaint = await assertComplaintInScope(actor, complaintId);

  return {
    complaint: toPublicComplaint(complaint),
    session: await getComplaintContext(complaint),
  };
}

/* -------------------------------------------------------------------------- */
/* Staff updates                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Update the staff-owned fields.
 *
 * `subject` and `description` are NOT here, and the validator rejects them outright. A support
 * ticket is an audit record — letting the reporter retroactively rewrite what they reported
 * would destroy the only reason to keep it after it closes.
 *
 * `priority` is internal triage. The system sets the starting value; ANY staff member can
 * change it, because triage is exactly what frontline support does — in every help desk it is
 * the first thing the agent who picks a ticket up adjusts.
 */
export async function updateComplaint(
  actor: AuthUser,
  complaintId: string,
  input: UpdateComplaintInput,
): Promise<PublicComplaint> {
  const complaint = await assertComplaintInScope(actor, complaintId);

  if (complaint.status === 'closed') {
    throw ApiError.conflict('This complaint is closed and can no longer be edited.');
  }

  if (input.priority !== undefined) complaint.priority = input.priority;

  // Interim notes. An operator can record what they found without concluding the ticket.
  if (input.resolution !== undefined) complaint.resolution = input.resolution;

  await complaint.save();

  return toPublicComplaint(complaint);
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Apply one status change and append it to the history. The ONLY place `status` is written after
 * creation, so no path can move a complaint without leaving a timeline entry.
 */
function applyTransition(
  complaint: ComplaintDocument,
  to: ComplaintStatus,
  by: { role: ComplaintActor; userId: string | null },
  note: string | null,
): ComplaintStatus {
  const from = complaint.status;

  if (to === 'resolved') {
    complaint.resolvedBy = by.userId ? new Types.ObjectId(by.userId) : null;
    complaint.resolvedAt = new Date();
  }

  if (from === 'resolved' && to === 'open') {
    // The resolution was disputed. It is no longer "the" resolution — the history keeps it.
    complaint.resolvedBy = null;
    complaint.resolvedAt = null;
    complaint.reopenCount += 1;
  }

  complaint.status = to;
  complaint.history.push({
    from,
    to,
    byRole: by.role,
    byUserId: by.userId ? new Types.ObjectId(by.userId) : null,
    note,
    at: new Date(),
  });

  return from;
}

function isAdminOnly(from: ComplaintStatus, to: ComplaintStatus): boolean {
  return ADMIN_ONLY_TRANSITIONS.some((rule) => rule.to === to && (rule.from === '*' || rule.from === from));
}

/**
 * Move a complaint through its lifecycle. STAFF.
 *
 * THREE GATES, checked separately so the error names the rule that was hit:
 *
 *   1. Is the transition legal at all?  -> 409, the table in constants/complaint.ts
 *   2. Is THIS ROLE allowed to make it? -> 403, concluding / overturning is admin-only
 *   3. Is it explained?                 -> 422, resolving or closing early needs a note
 */
export async function setComplaintStatus(
  actor: AuthUser,
  complaintId: string,
  status: ComplaintStatus,
  resolution?: string,
): Promise<PublicComplaint> {
  const complaint = await assertComplaintInScope(actor, complaintId);

  if (complaint.status === status) return toPublicComplaint(complaint);

  const allowed = ALLOWED_TRANSITIONS[complaint.status];

  if (!allowed.includes(status)) {
    throw ApiError.conflict(
      complaint.status === 'closed'
        ? 'This complaint is closed. Closed complaints cannot be reopened — the driver can file a follow-up linked to it.'
        : `A complaint cannot move from ${complaint.status} to ${status}.`,
      { from: complaint.status, to: status, allowed },
    );
  }

  if (actor.role === ROLES.OPERATOR && isAdminOnly(complaint.status, status)) {
    throw ApiError.forbidden(
      'Only an administrator can resolve, close or reopen a resolved complaint. You can move it between open and in progress and add notes.',
    );
  }

  let note: string | null = resolution?.trim() || null;

  if (status === 'resolved') {
    const text = note ?? complaint.resolution;

    // You cannot conclude that something is fixed without saying what was done. Especially when
    // the ticket is a payment dispute and this note is the only record of the decision.
    if (!text || text.trim().length === 0) {
      throw ApiError.validation('A resolution is required before a complaint can be resolved.');
    }

    complaint.resolution = text;
    note = text;
  } else if (status === 'closed' && complaint.status !== 'resolved') {
    // Closing WITHOUT resolving skips the driver's chance to dispute it, so it must say why:
    // duplicate, invalid, spam. This is the "no `rejected` state" rule made enforceable.
    if (!note) {
      throw ApiError.validation(
        'Say why you are closing this without resolving it (for example: duplicate, invalid, or spam).',
      );
    }
    complaint.resolution = note;
  } else if (note) {
    complaint.resolution = note;
  }

  const previous = applyTransition(complaint, status, { role: actor.role, userId: actor.id }, note);
  await complaint.save();

  logger.info(
    SCOPE,
    `${actor.email} moved complaint "${complaint.subject}" from ${previous} to ${status} [complaint ${complaintId}]`,
  );

  void notify.complaintUpdated(complaint, status, complaint.resolution, complaint.history.length);

  return toPublicComplaint(complaint);
}

/* -------------------------------------------------------------------------- */
/* The driver's two moves                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The driver agrees it is fixed. `resolved -> closed`, DRIVER ONLY.
 *
 * The reporter is the only person who actually knows whether the problem went away, so their
 * confirmation is the strongest possible close. Without it the ticket closes itself after
 * AUTO_CLOSE_AFTER_MS anyway — confirming just gets there sooner.
 */
export async function confirmComplaintResolved(
  actor: AuthUser,
  complaintId: string,
): Promise<PublicComplaint> {
  const complaint = await assertComplaintInScope(actor, complaintId);

  if (complaint.status !== 'resolved') {
    throw ApiError.conflict(
      `Only a resolved complaint can be confirmed. This one is ${complaint.status.replace('_', ' ')}.`,
    );
  }

  applyTransition(complaint, 'closed', { role: 'driver', userId: actor.id }, 'Driver confirmed the fix.');
  await complaint.save();

  logger.info(SCOPE, `${actor.email} confirmed complaint "${complaint.subject}" is fixed — closed [complaint ${complaintId}]`);

  return toPublicComplaint(complaint);
}

/**
 * The driver says it is NOT fixed. `resolved -> open`, DRIVER ONLY, reason required.
 *
 * Only from `resolved`: that is the window where staff have made a claim the driver can dispute.
 * An `open` or `in_progress` ticket is already being worked, and a `closed` one is final — a
 * returning problem there becomes a follow-up complaint instead.
 *
 * Back to `open`, not `in_progress`: it goes back into the queue so whoever is on shift sees it,
 * rather than landing silently on the person who resolved it wrongly.
 */
export async function reopenComplaint(
  actor: AuthUser,
  complaintId: string,
  reason: string,
): Promise<PublicComplaint> {
  const complaint = await assertComplaintInScope(actor, complaintId);

  if (complaint.status !== 'resolved') {
    throw ApiError.conflict(
      complaint.status === 'closed'
        ? 'This complaint is closed and cannot be reopened. Report it again as a follow-up instead.'
        : 'This complaint is still being worked on, so there is nothing to reopen.',
    );
  }

  applyTransition(complaint, 'open', { role: 'driver', userId: actor.id }, reason.trim());
  await complaint.save();

  logger.info(
    SCOPE,
    `${actor.email} reopened complaint "${complaint.subject}" (reopened ${complaint.reopenCount} time(s)): "${reason.trim()}" [complaint ${complaintId}]`,
  );

  void notify.complaintReopened(complaint, reason.trim(), complaint.history.length);

  return toPublicComplaint(complaint);
}

/* -------------------------------------------------------------------------- */
/* Auto-close                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Close every complaint that has sat in `resolved` for longer than AUTO_CLOSE_AFTER_MS.
 *
 * Silence counts as agreement — the same rule every help desk uses. Without it `resolved` becomes
 * a permanent limbo, and the reopen window never ends.
 */
export async function sweepResolvedComplaints(): Promise<number> {
  const cutoff = new Date(Date.now() - AUTO_CLOSE_AFTER_MS);

  const due = await Complaint.find({ status: 'resolved', resolvedAt: { $lt: cutoff } });

  for (const complaint of due) {
    applyTransition(
      complaint,
      'closed',
      { role: 'system', userId: null },
      `Closed automatically — no reply within ${Math.round(AUTO_CLOSE_AFTER_MS / 86_400_000)} days of being resolved.`,
    );
    await complaint.save();
    void notify.complaintUpdated(complaint, 'closed', complaint.resolution, complaint.history.length);
  }

  if (due.length > 0) {
    logger.info(SCOPE, `Closed ${due.length} resolved complaint(s) automatically — the drivers didn't reply in time`);
  }

  return due.length;
}

let sweepTimer: NodeJS.Timeout | null = null;

export function startComplaintSweeper(): void {
  if (sweepTimer) return;

  const run = () =>
    void sweepResolvedComplaints().catch((error: unknown) =>
      logger.error(SCOPE, 'Background auto-close of resolved complaints failed', error),
    );

  // Not run at boot: the database may not be connected yet, and a complaint closing an hour late
  // after a restart costs nothing.
  sweepTimer = setInterval(run, COMPLAINT_SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

export function stopComplaintSweeper(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
