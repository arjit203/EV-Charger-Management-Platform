/**
 * Company scoping — the single most reused security primitive in this project.
 *
 * THE RULE: a company-scoped caller must never be able to read or write another company's
 * data, no matter what id they put in the URL or body. The `companyId` used to build a
 * query comes from the authenticated request context (verified token, re-checked against
 * the database in auth.middleware.ts) and NEVER from client input.
 *
 * THE PATTERN: scope the query, do not fetch-then-compare.
 *
 *   // WRONG — correctness depends on remembering the `if`
 *   const station = await Station.findById(id);
 *   if (station.companyId !== req.user.companyId) throw forbidden();
 *
 *   // RIGHT — the database physically cannot return someone else's row
 *   const station = await Station.findOne(applyCompanyScope(req.user, { _id: id }));
 *
 * Modules 4-13 (Stations, Chargers, Sessions, Tariffs, Payments, Analytics) all reuse
 * `applyCompanyScope`. One audited function beats the same check hand-written eleven times.
 */

import { Types } from 'mongoose';

import { ROLES } from '../constants/roles';
import { ApiError } from './ApiError';
import type { AuthUser } from '../types/express';

export interface CompanyScope {
  /** True for super_admin: may see every company's data. */
  isPlatformWide: boolean;
  /** The one company this caller is bound to. Null only when platform-wide. */
  companyId: string | null;
}

/**
 * Work out what this caller is allowed to see.
 *
 * @throws {ApiError} 403 when a company-scoped role somehow has no company. That is a data
 * integrity problem, and failing closed is the only safe response — the alternative would
 * be an unscoped query returning everything.
 */
export function resolveCompanyScope(user: AuthUser): CompanyScope {
  if (user.role === ROLES.SUPER_ADMIN) {
    return { isPlatformWide: true, companyId: null };
  }

  if (!user.companyId) {
    throw ApiError.forbidden('Your account is not associated with a company.');
  }

  return { isPlatformWide: false, companyId: user.companyId };
}

/**
 * Add the caller's company constraint to a query filter.
 *
 * For resources that carry a `companyId` field — Station, Charger, ChargingSession,
 * Tariff, PaymentTransaction, and the `$match` stage of every analytics aggregation.
 *
 * For `super_admin` the filter is returned untouched, which is the whole point of the role.
 */
export function applyCompanyScope<T extends Record<string, unknown>>(
  user: AuthUser,
  filter: T,
): T & { companyId?: Types.ObjectId } {
  const scope = resolveCompanyScope(user);

  if (scope.isPlatformWide) return filter;

  return { ...filter, companyId: new Types.ObjectId(scope.companyId as string) };
}
