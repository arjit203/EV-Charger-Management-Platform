/**
 * Company-status enforcement (Module 2).
 *
 * Runs after `authenticate` + `authorize` on every company-scoped route. It answers a
 * third question the other two do not: "is the caller's company still allowed to operate?"
 *
 *   authenticate         -> who are you?            (identity)
 *   authorize(...roles)  -> what kind of user?      (role)
 *   requireActiveCompany -> is your company active? (tenancy)
 *
 * DESIGN DECISION — enforcement is LIVE, checked against the database on every request,
 * not baked into the token at login. `companyId` is embedded in the JWT, so a token issued
 * before a suspension would otherwise keep working for up to JWT_EXPIRES_IN (7 days). This
 * is the same reasoning that makes `auth.middleware.ts` reload the user, and the cost is
 * the same: one indexed lookup, knowingly accepted. Do not cache it.
 *
 * DESIGN DECISION — a suspended company does NOT block login. Authentication answers "who
 * are you"; company status answers "what may you touch". Staff can still sign in and see a
 * clear explanation instead of an inscrutable credentials error. Company status and user
 * status are independent switches.
 *
 * `super_admin` is intentionally exempt: they have no company, and they must be able to
 * view and reactivate a suspended one.
 */

import { Company, toPublicCompany } from '../models/company.model';
import { ROLES } from '../constants/roles';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { resolveCompanyScope } from '../utils/companyScope';

export const requireActiveCompany = asyncHandler(async (req, _res, next) => {
  if (!req.user) {
    throw ApiError.unauthorized('Authentication required.');
  }

  // Platform-wide role: no company of their own to check.
  if (req.user.role === ROLES.SUPER_ADMIN) {
    next();
    return;
  }

  // Throws 403 if a company-scoped role somehow has no companyId (fails closed).
  const scope = resolveCompanyScope(req.user);

  const company = await Company.findById(scope.companyId);

  if (!company) {
    // The company was deleted while its staff still hold valid tokens.
    throw ApiError.forbidden('Your company no longer exists. Contact an administrator.');
  }

  if (company.status !== 'active') {
    throw new ApiError(
      403,
      'Your company has been suspended. Contact an administrator.',
      'COMPANY_SUSPENDED',
    );
  }

  // Hand the loaded company downstream so `/companies/me` needs no second query.
  req.company = toPublicCompany(company);

  next();
});
