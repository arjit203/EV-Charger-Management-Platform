/**
 * Complaint — a support ticket, and the record of what was done about it.
 *
 * TWO OWNERS, LIKE A CHARGING SESSION. A complaint belongs to the driver who reported it AND to
 * the company whose hardware it concerns. Module 7 hit this first with sessions; the resolution
 * is the same: the caller's ROLE picks which scope applies, rather than combining them.
 *
 * THE RESOURCE IDS ARE DERIVED, NEVER SUBMITTED. A client sends at most ONE anchor — a session
 * id, or a charger id, or nothing — and everything else is resolved server-side from it. That is
 * what makes "a session from company B with a charger from company A" unrepresentable rather
 * than merely rejected: there is no field to put the second id in.
 *
 * IT IS AN AUDIT RECORD. `subject` and `description` are immutable after creation. Letting a
 * reporter retroactively edit what they reported would destroy the only reason to keep the
 * ticket after it closes.
 */

import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

import {
  COMPLAINT_CATEGORIES,
  COMPLAINT_PRIORITIES,
  COMPLAINT_STATUSES,
  type ComplaintCategory,
  type ComplaintPriority,
  type ComplaintStatus,
} from '../constants/complaint';

export interface IComplaint {
  /** The reporter. Always from the verified token, never from a request body. */
  userId: Types.ObjectId;

  /**
   * The company whose hardware this concerns — DERIVED from the anchor.
   *
   * NULL is a real, meaningful value: a complaint with no anchor ("I cannot log in") belongs to
   * no company, and is therefore visible only to super_admin. A CPO has no business reading an
   * account problem from a driver who has never used their stations.
   *
   * Never taken from the reporter's own record: a driver has `companyId: null` by design, locked
   * since Module 1. Nobody should ever "fix" a missing company here by giving drivers one.
   */
  companyId: Types.ObjectId | null;

  /* --- the anchor, and what was derived from it --- */
  chargingSessionId: Types.ObjectId | null;
  chargerId: Types.ObjectId | null;
  stationId: Types.ObjectId | null;
  connectorId: Types.ObjectId | null;

  category: ComplaintCategory;
  /** Immutable after creation. */
  subject: string;
  /** Immutable after creation. */
  description: string;

  priority: ComplaintPriority;
  status: ComplaintStatus;

  /** What staff did. Required before a complaint can be marked resolved. */
  resolution: string | null;
  /** WHO concluded it. Attribution matters when the ticket is a payment dispute. */
  resolvedBy: Types.ObjectId | null;
  resolvedAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export type ComplaintModel = Model<IComplaint>;

const complaintSchema = new Schema<IComplaint, ComplaintModel>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    companyId: { type: Schema.Types.ObjectId, ref: 'Company', default: null },

    chargingSessionId: { type: Schema.Types.ObjectId, ref: 'ChargingSession', default: null },
    chargerId: { type: Schema.Types.ObjectId, ref: 'Charger', default: null },
    stationId: { type: Schema.Types.ObjectId, ref: 'Station', default: null },
    connectorId: { type: Schema.Types.ObjectId, ref: 'Connector', default: null },

    category: { type: String, enum: COMPLAINT_CATEGORIES, required: true },

    subject: { type: String, required: true, trim: true, minlength: 5, maxlength: 120 },
    description: { type: String, required: true, trim: true, minlength: 10, maxlength: 2000 },

    priority: { type: String, enum: COMPLAINT_PRIORITIES, required: true, default: 'medium' },
    status: { type: String, enum: COMPLAINT_STATUSES, required: true, default: 'open', index: true },

    resolution: { type: String, trim: true, maxlength: 2000, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/** "My complaints, newest first" — the driver's only list. */
complaintSchema.index({ userId: 1, createdAt: -1 });

/**
 * The staff queue, which is ALWAYS filtered by status.
 *
 * Category and priority are deliberately not indexed separately: they are low-cardinality
 * filters applied on top of an already-scoped result set, so this compound index has already
 * done the selective work. Adding them would cost writes and buy nothing.
 */
complaintSchema.index({ companyId: 1, status: 1, createdAt: -1 });

/** "Is there an open dispute about this session?" — asked when settling or investigating. */
complaintSchema.index({ chargingSessionId: 1 });

export const Complaint = model<IComplaint, ComplaintModel>('Complaint', complaintSchema);

export type ComplaintDocument = HydratedDocument<IComplaint>;

/** Explicit allow-list, consistent with every other model in the project. */
export interface PublicComplaint {
  id: string;
  userId: string;
  companyId: string | null;
  chargingSessionId: string | null;
  chargerId: string | null;
  stationId: string | null;
  connectorId: string | null;
  category: ComplaintCategory;
  subject: string;
  description: string;
  priority: ComplaintPriority;
  status: ComplaintStatus;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toPublicComplaint(complaint: ComplaintDocument): PublicComplaint {
  return {
    id: String(complaint._id),
    userId: String(complaint.userId),
    companyId: complaint.companyId ? String(complaint.companyId) : null,
    chargingSessionId: complaint.chargingSessionId ? String(complaint.chargingSessionId) : null,
    chargerId: complaint.chargerId ? String(complaint.chargerId) : null,
    stationId: complaint.stationId ? String(complaint.stationId) : null,
    connectorId: complaint.connectorId ? String(complaint.connectorId) : null,
    category: complaint.category,
    subject: complaint.subject,
    description: complaint.description,
    priority: complaint.priority,
    status: complaint.status,
    resolution: complaint.resolution,
    resolvedBy: complaint.resolvedBy ? String(complaint.resolvedBy) : null,
    resolvedAt: complaint.resolvedAt ? complaint.resolvedAt.toISOString() : null,
    createdAt: complaint.createdAt.toISOString(),
    updatedAt: complaint.updatedAt.toISOString(),
  };
}
