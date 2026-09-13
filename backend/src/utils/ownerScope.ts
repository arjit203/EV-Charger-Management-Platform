/**
 * Ownership scoping — the `userId` sibling of `applyCompanyScope`.
 *
 * Module 2 answered "which BUSINESS owns this?" for stations and chargers. This answers
 * "which PERSON owns this?" for vehicles, and from later modules for charging sessions,
 * wallets, payments, complaints and notifications.
 *
 * ONE CRITICAL DIFFERENCE from `applyCompanyScope`: there is no platform-wide bypass here.
 * `applyCompanyScope` returns the filter untouched for `super_admin`, because seeing every
 * company is that role's entire purpose. This function ALWAYS scopes, for every role
 * including super_admin — a personal resource stays personal. An admin who needs a user's
 * data uses the admin endpoints, which is an auditable, deliberate path rather than a
 * silent widening of a self-service query.
 *
 * THE RULE, unchanged from Module 2: the id comes from the verified request context, never
 * from client input.
 *
 *   // WRONG — trusts the caller, and writes into someone else's account
 *   Vehicle.create({ ...input, userId: req.body.ownerId })
 *
 *   // RIGHT
 *   Vehicle.create({ ...input, userId: req.user.id })
 *
 *   // WRONG — fetch, then hope the comparison is remembered
 *   const v = await Vehicle.findById(id);
 *   if (String(v.userId) !== req.user.id) throw forbidden();
 *
 *   // RIGHT — the database cannot return someone else's row
 *   const v = await Vehicle.findOne(applyOwnerScope(req.user, { _id: id }));
 */

import { Types } from 'mongoose';

import type { AuthUser } from '../types/express';

/** Add the caller's ownership constraint to a query filter. */
export function applyOwnerScope<T extends Record<string, unknown>>(
  user: AuthUser,
  filter: T = {} as T,
): T & { userId: Types.ObjectId } {
  return { ...filter, userId: new Types.ObjectId(user.id) };
}
