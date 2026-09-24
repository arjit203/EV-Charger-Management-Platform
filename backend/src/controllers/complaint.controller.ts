/**
 * Complaint HTTP handlers. Thin, as always.
 *
 * The detail handler returns the complaint plus, when it is anchored to a charging session, that
 * session's LIVE payment state — derived at read time so staff see whether a disputed charge is
 * still outstanding right now, not what it was when the ticket was filed.
 */

import type { Request, Response } from 'express';

import * as complaintService from '../services/complaint.service';
import { ApiError } from '../utils/ApiError';
import { sendSuccess } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import type {
  AssignComplaintInput,
  ComplaintStatusInput,
  CreateComplaintInput,
  ListComplaintsQuery,
  ReopenComplaintInput,
  UpdateComplaintInput,
} from '../validators/complaint.validator';

function requireUser(req: Request) {
  if (!req.user) throw ApiError.unauthorized('Authentication required.');
  return req.user;
}

/** POST /complaints — driver only. */
export const createComplaint = asyncHandler(async (req: Request, res: Response) => {
  const complaint = await complaintService.createComplaint(
    requireUser(req),
    req.body as CreateComplaintInput,
  );

  sendSuccess(res, { complaint }, 'Complaint submitted', 201);
});

/**
 * GET /complaints
 *
 * One endpoint, two audiences — the service picks owner scope for a driver and company scope for
 * staff. There is deliberately no `/complaints/me`: it would answer the identical question.
 */
export const listComplaints = asyncHandler(async (req: Request, res: Response) => {
  const result = await complaintService.listComplaints(
    requireUser(req),
    req.query as unknown as ListComplaintsQuery,
  );

  sendSuccess(res, result, 'Complaints retrieved');
});

/** GET /complaints/:complaintId */
export const getComplaintById = asyncHandler(async (req: Request, res: Response) => {
  const { complaint, session } = await complaintService.getComplaintById(
    requireUser(req),
    String(req.params.complaintId),
  );

  // `session` is null unless the complaint is anchored to one. Read-only context: this module
  // can see payment state and has no authority over it.
  sendSuccess(res, { complaint, session }, 'Complaint retrieved');
});

/** PATCH /complaints/:complaintId — resolution notes and priority. Staff only. */
export const updateComplaint = asyncHandler(async (req: Request, res: Response) => {
  const complaint = await complaintService.updateComplaint(
    requireUser(req),
    String(req.params.complaintId),
    req.body as UpdateComplaintInput,
  );

  sendSuccess(res, { complaint }, 'Complaint updated');
});

/** PATCH /complaints/:complaintId/status — the lifecycle. Staff only. */
export const setComplaintStatus = asyncHandler(async (req: Request, res: Response) => {
  const { status, resolution } = req.body as ComplaintStatusInput;

  const complaint = await complaintService.setComplaintStatus(
    requireUser(req),
    String(req.params.complaintId),
    status,
    resolution,
  );

  sendSuccess(res, { complaint }, `Complaint marked ${status}`);
});

/** POST /complaints/:complaintId/confirm — the driver agrees it is fixed. Driver only. */
export const confirmComplaintResolved = asyncHandler(async (req: Request, res: Response) => {
  const complaint = await complaintService.confirmComplaintResolved(
    requireUser(req),
    String(req.params.complaintId),
  );

  sendSuccess(res, { complaint }, 'Thanks for confirming — complaint closed');
});

/** POST /complaints/:complaintId/reopen — the driver says it is still broken. Driver only. */
export const reopenComplaint = asyncHandler(async (req: Request, res: Response) => {
  const { reason } = req.body as ReopenComplaintInput;

  const complaint = await complaintService.reopenComplaint(
    requireUser(req),
    String(req.params.complaintId),
    reason,
  );

  sendSuccess(res, { complaint }, 'Complaint reopened');
});

/** POST /complaints/:complaintId/assign — take, release or hand over a ticket. Staff only. */
export const assignComplaint = asyncHandler(async (req: Request, res: Response) => {
  const { assigneeId } = req.body as AssignComplaintInput;

  const complaint = await complaintService.assignComplaint(
    requireUser(req),
    String(req.params.complaintId),
    assigneeId,
  );

  sendSuccess(res, { complaint }, assigneeId ? 'Complaint assigned' : 'Complaint unassigned');
});
