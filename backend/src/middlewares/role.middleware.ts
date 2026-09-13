/**
 * Authorisation middleware — establishes WHAT the caller may do.
 *
 * Always runs after `authenticate`. Role checks answer "may this KIND of user call
 * this endpoint"; they do NOT answer "does this user own this particular record".
 *
 * Ownership is a separate, mandatory check performed in the service layer by scoping
 * the query itself, for example:
 *
 *   - cpo_admin / operator -> add `{ companyId: req.user.companyId }` to the filter
 *   - driver               -> add `{ userId: req.user.id }` to the filter
 *
 * Scope the query rather than fetching first and comparing afterwards: a filtered
 * query cannot leak a record by accident, and a forgotten comparison can.
 */

import type { RequestHandler } from 'express';

import { ApiError } from '../utils/ApiError';
import { COMPANY_SCOPED_ROLES, type Role } from '../constants/roles';

/** Restrict a route to the listed roles. */
export function authorize(...allowedRoles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) {
      // authorize() was mounted without authenticate() in front of it.
      next(ApiError.unauthorized('Authentication required.'));
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      next(ApiError.forbidden('You do not have permission to perform this action.'));
      return;
    }

    next();
  };
}

/**
 * True when this user's queries must be filtered by `companyId`.
 * Used from Module 2 onward by services that return company-owned resources.
 */
export function requiresCompanyScope(role: Role): boolean {
  return COMPANY_SCOPED_ROLES.includes(role);
}
