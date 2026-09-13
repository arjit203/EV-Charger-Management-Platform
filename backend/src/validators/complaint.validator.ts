/**
 * Request validation for complaints.
 *
 * THE IMPORTANT THING THIS FILE DOES is refuse to have fields.
 *
 * There is no `stationId`, no `connectorId`, no `companyId`, no `userId` on the create schema —
 * not validated ones, none at all. Those are derived server-side from a single anchor, so the
 * mismatch attack the design had to defend against ("a session from company B with a charger
 * from company A") cannot be expressed in a request. `.strict()` turns an attempt into a visible
 * 422 rather than a silent strip.
 */

import { z } from 'zod';

import {
  COMPLAINT_CATEGORIES,
  COMPLAINT_PRIORITIES,
  COMPLAINT_STATUSES,
} from '../constants/complaint';

const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid 24-character resource id');

export const complaintIdParamSchema = z.object({ complaintId: objectId });

export const createComplaintSchema = z
  .object({
    category: z.enum(COMPLAINT_CATEGORIES),
    subject: z
      .string()
      .trim()
      .min(5, 'Give the problem a short title')
      .max(120, 'Keep the title under 120 characters'),
    description: z
      .string()
      .trim()
      .min(10, 'Describe what happened')
      .max(2000, 'Keep the description under 2000 characters'),
    /**
     * The driver's own sense of urgency. Accepted because nothing happens faster for being
     * called `high` — no SLA, no routing, no escalation — so there is nothing to win by lying.
     * Staff can adjust it afterwards; the driver cannot.
     */
    priority: z.enum(COMPLAINT_PRIORITIES).optional(),

    /**
     * AT MOST ONE ANCHOR. Everything else about the complaint's place in the world is derived
     * from whichever of these is present.
     */
    chargingSessionId: objectId.optional(),
    chargerId: objectId.optional(),
  })
  .strict()
  .refine((data) => !(data.chargingSessionId && data.chargerId), {
    message:
      'Provide either a charging session or a charger, not both — the charger is derived from the session.',
    path: ['chargerId'],
  });

/**
 * Staff-editable fields, and only those.
 *
 * `subject` and `description` are absent on purpose: a complaint is an audit record, and the
 * reporter must not be able to retroactively change what they reported. `status` has its own
 * endpoint, because moving a ticket through its lifecycle is a distinct act from annotating it.
 */
export const updateComplaintSchema = z
  .object({
    resolution: z.string().trim().min(1).max(2000).optional(),
    priority: z.enum(COMPLAINT_PRIORITIES).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update.',
  });

export const complaintStatusSchema = z
  .object({
    status: z.enum(COMPLAINT_STATUSES),
    /** Required by the service when moving to `resolved`, optional otherwise. */
    resolution: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

export const listComplaintsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    status: z.enum(COMPLAINT_STATUSES).optional(),
    category: z.enum(COMPLAINT_CATEGORIES).optional(),
    priority: z.enum(COMPLAINT_PRIORITIES).optional(),
    stationId: objectId.optional(),
    chargerId: objectId.optional(),
  })
  .strict();

export type CreateComplaintInput = z.infer<typeof createComplaintSchema>;
export type UpdateComplaintInput = z.infer<typeof updateComplaintSchema>;
export type ComplaintStatusInput = z.infer<typeof complaintStatusSchema>;
export type ListComplaintsQuery = z.infer<typeof listComplaintsQuerySchema>;
