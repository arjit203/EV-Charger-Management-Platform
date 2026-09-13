/**
 * Company business logic — and the reference implementation of server-side company scoping.
 *
 * Read `getCompanyById` below before writing any query in Modules 4-13: it is the pattern
 * every company-owned resource repeats.
 */

import { type QueryFilter } from 'mongoose';

import { Company, toPublicCompany, type ICompany, type PublicCompany } from '../models/company.model';
import { ApiError } from '../utils/ApiError';
import * as realtime from '../realtime/publisher';
import { resolveCompanyScope } from '../utils/companyScope';
import type { AuthUser } from '../types/express';
import type { CompanyStatus } from '../constants/company';
import type { Paginated } from '../types/pagination';
import type {
  CreateCompanyInput,
  ListCompaniesQuery,
  UpdateCompanyInput,
} from '../validators/company.validator';


/**
 * Escape user input before putting it in a RegExp.
 *
 * Without this, a search for `.*` would match everything and a crafted pattern could pin
 * the CPU (ReDoS). Never interpolate raw user input into a regular expression.
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* -------------------------------------------------------------------------- */
/* Company CRUD                                                               */
/* -------------------------------------------------------------------------- */

/** super_admin only (enforced by the route). */
export async function createCompany(
  input: CreateCompanyInput,
  createdByUserId: string,
): Promise<PublicCompany> {
  const existing = await Company.findOne({ name: input.name }).select('_id');
  if (existing) {
    throw ApiError.conflict('A company with this name already exists.');
  }

  const company = await Company.create({ ...input, createdBy: createdByUserId });
  return toPublicCompany(company);
}

/**
 * super_admin only. This is the one genuinely unscoped read in the system, which is exactly
 * why the route restricts it to the single platform-wide role — a company-scoped caller must
 * use `getOwnCompany` instead, and receives 403 here.
 */
export async function listCompanies(query: ListCompaniesQuery): Promise<Paginated<PublicCompany>> {
  const filter: QueryFilter<ICompany> = {};

  if (query.status) filter.status = query.status;
  if (query.type) filter.type = query.type;
  if (query.search) {
    filter.name = { $regex: escapeRegex(query.search), $options: 'i' };
  }

  const skip = (query.page - 1) * query.limit;

  const [companies, total] = await Promise.all([
    Company.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    Company.countDocuments(filter),
  ]);

  return {
    items: companies.map(toPublicCompany),
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
  };
}

/**
 * Fetch one company, scoped to what this caller may see.
 *
 * *** THIS IS THE PATTERN FOR EVERY COMPANY-OWNED RESOURCE IN MODULES 4-13. ***
 *
 * Two things are happening, and it matters which one is the guarantee:
 *
 *  1. The early `forbidden` below only chooses the STATUS CODE. It exists because the test
 *     matrix (and good API design) wants 403 "not yours" rather than a vague 404.
 *
 *  2. The scoped query is the ACTUAL enforcement. Note the `$and`: for a company-scoped
 *     caller the document must match BOTH the requested id and their own company id, so
 *     the two can never differ. Delete step 1 entirely and a cross-company read still
 *     returns nothing — the database refuses, not an `if`.
 *
 * That ordering is the whole lesson: never fetch-then-compare, because a forgotten
 * comparison silently leaks a record, whereas a scoped query cannot.
 */
export async function getCompanyById(user: AuthUser, companyId: string): Promise<PublicCompany> {
  const scope = resolveCompanyScope(user);

  if (!scope.isPlatformWide && companyId !== scope.companyId) {
    throw ApiError.forbidden('You can only access your own company.');
  }

  const filter: QueryFilter<ICompany> = scope.isPlatformWide
    ? { _id: companyId }
    : { $and: [{ _id: companyId }, { _id: scope.companyId }] };

  const company = await Company.findOne(filter);

  if (!company) {
    throw ApiError.notFound('Company not found.');
  }

  return toPublicCompany(company);
}

/**
 * The caller's own company. The safest shape in the system: there is no identifier in the
 * URL for an attacker to change, so there is nothing to tamper with.
 *
 * `requireActiveCompany` has already loaded and status-checked it, so this just returns it.
 */
export function getOwnCompany(company: PublicCompany | undefined): PublicCompany {
  if (!company) {
    throw ApiError.notFound('Your account is not associated with a company.');
  }
  return company;
}

/** super_admin only. Cannot change status — that is a separate, deliberate endpoint. */
export async function updateCompany(
  companyId: string,
  input: UpdateCompanyInput,
): Promise<PublicCompany> {
  if (input.name) {
    // Another company already using the new name? The unique index would also catch this,
    // but checking first produces a clearer message than a raw duplicate-key error.
    const clash = await Company.findOne({ name: input.name, _id: { $ne: companyId } }).select('_id');
    if (clash) {
      throw ApiError.conflict('A company with this name already exists.');
    }
  }

  const company = await Company.findByIdAndUpdate(
    companyId,
    { $set: input },
    { new: true, runValidators: true },
  );

  if (!company) {
    throw ApiError.notFound('Company not found.');
  }

  return toPublicCompany(company);
}

/**
 * Activate or suspend a company. super_admin only.
 *
 * Suspending does NOT touch its users' accounts: company status and user status are
 * independent switches. Enforcement is live — `requireActiveCompany` re-reads this value on
 * every company-scoped request, so a suspension takes effect immediately even for staff
 * holding tokens issued beforehand.
 *
 * MODULE 8 ADDITION (flagged cross-module edit): a suspension now also drops the company's LIVE
 * SOCKETS. "Takes effect on the next request" is the whole mechanism above — but a Socket.IO
 * connection never makes another request. It is already open, and would keep receiving room
 * broadcasts indefinitely. Without this line, suspended staff lose REST access while keeping a
 * live feed of their own chargers through a side door: a real, if narrow, security
 * inconsistency. Their next connection attempt is refused at the handshake.
 */
export async function setCompanyStatus(
  companyId: string,
  status: CompanyStatus,
): Promise<PublicCompany> {
  const company = await Company.findByIdAndUpdate(
    companyId,
    { $set: { status } },
    { new: true, runValidators: true },
  );

  if (!company) {
    throw ApiError.notFound('Company not found.');
  }

  if (status !== 'active') {
    realtime.disconnectCompany(String(company._id));
  }

  return toPublicCompany(company);
}

