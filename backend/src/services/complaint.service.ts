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
  ALLOWED_TRANSITIONS,
  CONCLUDING_TRANSITIONS,
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
 * File a complaint.
 *
 * `userId` comes from the verified token. `companyId` and the resource ids come from the anchor.
 * The only things the client actually decides are the category, the words, and the priority.
 */
export async function createComplaint(
  actor: AuthUser,
  input: CreateComplaintInput,
): Promise<PublicComplaint> {
  const anchor = await resolveAnchor(actor, input);

  const complaint = await Complaint.create({
    userId: new Types.ObjectId(actor.id),
    ...anchor,
    category: input.category,
    subject: input.subject,
    description: input.description,
    // The driver's own sense of urgency. Safe to accept because nothing is faster for being
    // called `high` — no SLA, no routing, no escalation is attached to it.
    priority: input.priority ?? 'medium',
    status: 'open',
  });

  logger.info(
    SCOPE,
    `Complaint ${String(complaint._id)} opened (${input.category}) by ${actor.email}`,
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
 * `priority` is staff-only AFTER creation. A driver sets the initial value and then cannot
 * change it, so the record of how urgent they said it was stays intact.
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

  if (input.priority !== undefined) {
    if (actor.role === ROLES.OPERATOR) {
      throw ApiError.forbidden('Only an administrator can change a complaint priority.');
    }
    complaint.priority = input.priority;
  }

  // Interim notes. An operator can record what they found without concluding the ticket.
  if (input.resolution !== undefined) complaint.resolution = input.resolution;

  await complaint.save();

  return toPublicComplaint(complaint);
}

/**
 * Move a complaint through its lifecycle.
 *
 * TWO GATES, and they are independent:
 *
 *   1. Is the transition legal at all?  -> the table in constants/complaint.ts
 *   2. Is THIS ROLE allowed to make it? -> concluding moves are admin-only
 *
 * Checking them separately means the error tells the caller which rule they hit: 409 for "you
 * cannot get there from here", 403 for "not with your role".
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
        ? 'This complaint is closed. Closed complaints cannot be reopened — file a new one referencing it.'
        : `A complaint cannot move from ${complaint.status} to ${status}.`,
      { from: complaint.status, to: status, allowed },
    );
  }

  if (CONCLUDING_TRANSITIONS.includes(status) && actor.role === ROLES.OPERATOR) {
    throw ApiError.forbidden(
      'Only an administrator can resolve or close a complaint. You can move it to in_progress and add notes.',
    );
  }

  if (status === 'resolved') {
    const text = resolution ?? complaint.resolution;

    // You cannot conclude that something is fixed without saying what was done. Especially when
    // the ticket is a payment dispute and this note is the only record of the decision.
    if (!text || text.trim().length === 0) {
      throw ApiError.validation('A resolution is required before a complaint can be resolved.');
    }

    complaint.resolution = text;
    complaint.resolvedBy = new Types.ObjectId(actor.id);
    complaint.resolvedAt = new Date();
  } else if (resolution !== undefined) {
    complaint.resolution = resolution;
  }

  const previous = complaint.status;
  complaint.status = status;
  await complaint.save();

  logger.info(SCOPE, `Complaint ${complaintId}: ${previous} -> ${status} by ${actor.email}`);

  // The dedupe key carries the NEW STATUS, so all three transitions produce three notifications
  // rather than one. This is the case that ruled out keying on ids alone.
  void notify.complaintUpdated(complaint, status, complaint.resolution);

  return toPublicComplaint(complaint);
}
