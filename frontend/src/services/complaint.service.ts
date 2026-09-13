/**
 * Complaint API calls.
 *
 * Note what `createComplaint` accepts: a category, words, a priority, and **at most one anchor**.
 * There is no `stationId`, `connectorId` or `companyId` parameter, because the server derives
 * them — sending one is a 422, not a silent strip.
 */

import { apiRequest } from './apiClient';
import type {
  Complaint,
  ComplaintCategory,
  ComplaintDetailPayload,
  ComplaintPayload,
  ComplaintPriority,
  ComplaintStatus,
  Paginated,
} from '@/types/api';

export interface CreateComplaintInput {
  category: ComplaintCategory;
  subject: string;
  description: string;
  priority?: ComplaintPriority;
  /** The anchor. At most one — the server rejects both together. */
  chargingSessionId?: string;
  chargerId?: string;
}

export interface ListComplaintsParams {
  page?: number;
  limit?: number;
  status?: ComplaintStatus;
  category?: ComplaintCategory;
  priority?: ComplaintPriority;
  stationId?: string;
  chargerId?: string;
}

/** Scoped server-side: a driver gets their own, staff get their company's. */
export function listComplaints(params: ListComplaintsParams = {}): Promise<Paginated<Complaint>> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const suffix = query.toString() ? `?${query}` : '';
  return apiRequest<Paginated<Complaint>>(`/complaints${suffix}`, { cache: 'no-store' });
}

/** Returns the complaint plus, when anchored to a session, that session's live payment state. */
export function getComplaint(complaintId: string): Promise<ComplaintDetailPayload> {
  return apiRequest<ComplaintDetailPayload>(`/complaints/${complaintId}`, { cache: 'no-store' });
}

export async function createComplaint(input: CreateComplaintInput): Promise<Complaint> {
  const { complaint } = await apiRequest<ComplaintPayload>('/complaints', {
    method: 'POST',
    body: input,
  });
  return complaint;
}

/**
 * Staff-editable fields only.
 *
 * `subject` and `description` are deliberately absent: a support ticket is an audit record, and
 * letting anyone rewrite what was originally reported would destroy the reason to keep it.
 */
export async function updateComplaint(
  complaintId: string,
  input: { resolution?: string; priority?: ComplaintPriority },
): Promise<Complaint> {
  const { complaint } = await apiRequest<ComplaintPayload>(`/complaints/${complaintId}`, {
    method: 'PATCH',
    body: input,
  });
  return complaint;
}

/**
 * Move a complaint through its lifecycle.
 *
 * Two independent gates on the server: is the transition legal (409 if not), and may this role
 * make it (403 if not). An operator can reach `in_progress`; only an admin can `resolve` or
 * `close`.
 */
export async function setComplaintStatus(
  complaintId: string,
  status: ComplaintStatus,
  resolution?: string,
): Promise<Complaint> {
  const { complaint } = await apiRequest<ComplaintPayload>(`/complaints/${complaintId}/status`, {
    method: 'PATCH',
    body: { status, ...(resolution ? { resolution } : {}) },
  });
  return complaint;
}
