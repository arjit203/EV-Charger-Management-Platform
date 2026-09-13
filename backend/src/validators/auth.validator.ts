/**
 * Request validation schemas for authentication.
 *
 * Validation happens at the edge (middleware) so controllers and services can trust
 * their input. Anything that reaches a service has already been shape-checked.
 */

import { z } from 'zod';

/**
 * Public self-registration.
 *
 * `.strict()` is load-bearing security, not tidiness. Without it, Zod silently strips
 * unknown keys — so a request containing `"role": "super_admin"` or `"companyId": "..."`
 * would be quietly dropped and look identical to a clean request in the logs. With it,
 * that request is rejected with a 422 naming the offending field, so a privilege-escalation
 * attempt is visible rather than invisible.
 *
 * Note there is deliberately NO `role` field here. Self-signup can only ever produce a
 * `driver`; the service hardcodes that and ignores any client input. Privileged accounts
 * (cpo_admin, operator) are created by an authenticated cpo_admin/super_admin, and the very
 * first super_admin comes from the seed script.
 */
export const registerSchema = z
  .object({
    name: z.string().trim().min(2, 'Name must be at least 2 characters').max(120),
    email: z.email('Enter a valid email address').max(254),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .max(128, 'Password must be at most 128 characters'),
    phone: z.string().trim().min(7).max(20).optional(),
  })
  .strict();

export const loginSchema = z
  .object({
    email: z.email('Enter a valid email address').max(254),
    password: z.string().min(1, 'Password is required').max(128),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
