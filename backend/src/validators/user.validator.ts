/**
 * Request validation for user management.
 *
 * Every schema is `.strict()`. For the self-service profile endpoint that is the primary
 * privilege-escalation defence: a body containing `role`, `companyId`, `status` or
 * `passwordHash` is REJECTED with a 422 naming the field, not silently stripped — so an
 * attempt shows up in the logs instead of looking like a normal request.
 */

import { z } from 'zod';

import { ASSIGNABLE_COMPANY_ROLES, ALL_ROLES } from '../constants/roles';
import { USER_STATUSES } from '../models/user.model';

const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid 24-character resource id');

export const userIdParamSchema = z.object({ userId: objectId });

export const listUsersQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    role: z.enum(ALL_ROLES as [string, ...string[]]).optional(),
    status: z.enum(USER_STATUSES as [string, ...string[]]).optional(),
    /** super_admin only. A cpo_admin sending someone else's company is refused. */
    companyId: objectId.optional(),
    search: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

/**
 * Create a staff account. Supersedes Module 2's `POST /companies/:companyId/users`.
 *
 * `role` accepts ONLY `cpo_admin | operator` — drivers are created exactly one way, by
 * self-registration at `/auth/register`, so this endpoint can never produce one (and
 * never a second super_admin).
 *
 * `companyId` is optional here because the two callers differ: a super_admin must supply
 * it (enforced in the service), while for a cpo_admin it is ignored entirely and taken
 * from their own token.
 */
export const createUserSchema = z
  .object({
    name: z.string().trim().min(2, 'Name must be at least 2 characters').max(120),
    email: z.email('Enter a valid email address').max(254),
    password: z.string().min(8, 'Password must be at least 8 characters').max(128),
    role: z.enum(ASSIGNABLE_COMPANY_ROLES),
    companyId: objectId.optional(),
    phone: z.string().trim().min(7).max(20).optional(),
  })
  .strict();

/** Administrative edit. Identity (email) and privileges (role/company/status) are not here. */
export const updateUserSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    phone: z.string().trim().min(7).max(20).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update.',
  });

/** Self-service profile edit. Same allowed fields — a driver has no extra privileges. */
export const updateMeSchema = updateUserSchema;

export const userStatusSchema = z
  .object({ status: z.enum(USER_STATUSES as [string, ...string[]]) })
  .strict();

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type UserStatusInput = z.infer<typeof userStatusSchema>;
