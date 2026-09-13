/**
 * User management business logic.
 *
 * Two distinct surfaces live here and must not be confused:
 *
 *   ADMINISTRATIVE  — acting on OTHER people. Scoped by company (staff only).
 *   SELF-SERVICE    — acting on YOURSELF. Scoped by user id, always.
 *
 * Note that drivers never appear in an administrative company-scoped list. That is
 * structural, not a rule bolted on: drivers have `companyId: null` (locked in Module 1,
 * because a driver can charge at any company's stations and belongs to none), so a company
 * filter can never match one. Drivers are platform-wide entities — visible to super_admin,
 * and otherwise only to themselves.
 *
 * Do NOT "fix" this by giving drivers a companyId. Besides breaking Module 1's validator,
 * a `{ companyId: null }` filter would match EVERY driver at once — company scoping fails
 * wide open for personal data, which is exactly why `applyOwnerScope` exists.
 */

import { Types, type QueryFilter } from 'mongoose';

import { User, toPublicUser, type IUser, type PublicUser, type UserStatus } from '../models/user.model';
import { Company } from '../models/company.model';
import { ROLES, type Role } from '../constants/roles';
import { ApiError } from '../utils/ApiError';
import { resolveCompanyScope } from '../utils/companyScope';
import type { AuthUser } from '../types/express';
import type { Paginated } from '../types/pagination';
import type { CreateUserInput, ListUsersQuery, UpdateUserInput } from '../validators/user.validator';

/** Never interpolate raw user input into a RegExp — see company.service for the reasoning. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The set of users this actor may administer, expressed as a query filter.
 *
 * super_admin      -> {} (everyone)
 * cpo_admin        -> own company AND staff roles only
 *
 * This is the guarantee. Every administrative read and write below spreads it into the
 * query, so no handler can accidentally reach outside it.
 */
function manageableUsersFilter(actor: AuthUser): QueryFilter<IUser> {
  if (actor.role === ROLES.SUPER_ADMIN) return {};

  const scope = resolveCompanyScope(actor); // throws 403 if a scoped role has no company

  return {
    companyId: new Types.ObjectId(scope.companyId as string),
    role: { $in: [ROLES.CPO_ADMIN, ROLES.OPERATOR] },
  };
}

/**
 * Choose the error for "the scoped query returned nothing".
 *
 * A company-scoped actor gets 403 even when the id simply does not exist. Distinguishing
 * 404 from 403 would turn this endpoint into an oracle for probing which user ids are
 * real — the same reasoning that makes login return one message for both "unknown email"
 * and "wrong password".
 */
function notFoundOrForbidden(actor: AuthUser): ApiError {
  return actor.role === ROLES.SUPER_ADMIN
    ? ApiError.notFound('User not found.')
    : ApiError.forbidden('You can only access users from your own company.');
}

/* -------------------------------------------------------------------------- */
/* Administrative                                                             */
/* -------------------------------------------------------------------------- */

export async function listUsers(
  actor: AuthUser,
  query: ListUsersQuery,
): Promise<Paginated<PublicUser>> {
  const filter: QueryFilter<IUser> = { ...manageableUsersFilter(actor) };

  if (query.companyId) {
    if (actor.role === ROLES.SUPER_ADMIN) {
      filter.companyId = new Types.ObjectId(query.companyId);
    } else if (query.companyId !== actor.companyId) {
      // Refused rather than silently ignored, so tampering is visible. The filter above
      // would have constrained the query anyway.
      throw ApiError.forbidden('You can only view users from your own company.');
    }
  }

  if (query.role) {
    const requested = query.role as Role;

    // A cpo_admin asking for drivers is asking for something outside their scope.
    if (actor.role !== ROLES.SUPER_ADMIN && requested !== ROLES.CPO_ADMIN && requested !== ROLES.OPERATOR) {
      throw ApiError.forbidden('You can only view staff accounts from your own company.');
    }

    filter.role = requested;
  }

  if (query.status) filter.status = query.status as UserStatus;

  if (query.search) {
    const pattern = { $regex: escapeRegex(query.search), $options: 'i' };
    filter.$or = [{ name: pattern }, { email: pattern }, { phone: pattern }];
  }

  const skip = (query.page - 1) * query.limit;

  const [users, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    User.countDocuments(filter),
  ]);

  return {
    items: users.map(toPublicUser),
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
  };
}

export async function getUserById(actor: AuthUser, userId: string): Promise<PublicUser> {
  const user = await User.findOne({ _id: userId, ...manageableUsersFilter(actor) });
  if (!user) throw notFoundOrForbidden(actor);
  return toPublicUser(user);
}

/**
 * Create a staff account.
 *
 * Supersedes Module 2's `POST /companies/:companyId/users`, which is removed.
 *
 * Two callers, deliberately different:
 *   super_admin — creates cpo_admin or operator in ANY company; must name the company.
 *   cpo_admin   — creates `operator` ONLY, in their OWN company. The role restriction
 *                 prevents self-replicating admins, and the company is taken from their
 *                 token so a body value can never redirect the account elsewhere.
 *
 * Neither caller can create a driver: the validator's enum excludes it. Drivers are created
 * exactly one way — self-registration via /auth/register.
 */
export async function createStaffUser(
  actor: AuthUser,
  input: CreateUserInput,
): Promise<PublicUser> {
  let companyId: string;

  if (actor.role === ROLES.SUPER_ADMIN) {
    if (!input.companyId) {
      throw ApiError.validation('Validation failed', [
        { field: 'companyId', message: 'Required when creating a user as a platform administrator.' },
      ]);
    }
    companyId = input.companyId;
  } else {
    const scope = resolveCompanyScope(actor);

    if (input.role !== ROLES.OPERATOR) {
      throw ApiError.forbidden('A CPO admin can only create operator accounts.');
    }

    if (input.companyId && input.companyId !== scope.companyId) {
      throw ApiError.forbidden('You can only create users in your own company.');
    }

    companyId = scope.companyId as string;
  }

  const company = await Company.findById(companyId).select('_id');
  if (!company) throw ApiError.notFound('Company not found.');

  const email = input.email.trim().toLowerCase();

  const existing = await User.findOne({ email }).select('_id');
  if (existing) throw ApiError.conflict('An account with this email already exists.');

  const user = await User.create({
    name: input.name,
    email,
    phone: input.phone,
    passwordHash: await User.hashPassword(input.password),
    role: input.role,
    status: 'active',
    companyId: company._id,
  });

  return toPublicUser(user);
}

/** Administrative edit. Cannot touch role, company, status or email. */
export async function updateUser(
  actor: AuthUser,
  userId: string,
  input: UpdateUserInput,
): Promise<PublicUser> {
  const user = await User.findOneAndUpdate(
    { _id: userId, ...manageableUsersFilter(actor) },
    { $set: input },
    { new: true, runValidators: true },
  );

  if (!user) throw notFoundOrForbidden(actor);
  return toPublicUser(user);
}

/**
 * Activate or suspend an account.
 *
 * Guarded against self-suspension: an admin who suspends themselves is instantly locked
 * out by `auth.middleware`, with no one but another admin able to undo it.
 */
export async function setUserStatus(
  actor: AuthUser,
  userId: string,
  status: UserStatus,
): Promise<PublicUser> {
  if (userId === actor.id) {
    throw ApiError.forbidden('You cannot change your own account status.');
  }

  const user = await User.findOneAndUpdate(
    { _id: userId, ...manageableUsersFilter(actor) },
    { $set: { status } },
    { new: true, runValidators: true },
  );

  if (!user) throw notFoundOrForbidden(actor);
  return toPublicUser(user);
}

/* -------------------------------------------------------------------------- */
/* Self-service                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Update your own profile.
 *
 * Scoped to `actor.id` — there is no id in the URL, so there is nothing to tamper with.
 * The strict schema rejects `role`, `companyId`, `status` and `passwordHash` outright, so
 * a driver cannot promote themselves or move into a company.
 *
 * Reading your own profile is deliberately NOT here: `GET /auth/me` already does it, and a
 * second identical endpoint would be redundant surface.
 */
export async function updateOwnProfile(
  actor: AuthUser,
  input: UpdateUserInput,
): Promise<PublicUser> {
  const user = await User.findByIdAndUpdate(
    actor.id,
    { $set: input },
    { new: true, runValidators: true },
  );

  if (!user) throw ApiError.notFound('User not found.');
  return toPublicUser(user);
}
