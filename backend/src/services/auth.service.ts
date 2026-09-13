/**
 * Authentication business logic.
 *
 * Controllers stay thin and HTTP-shaped; everything that decides *what happens* lives
 * here, so the same rules apply no matter which transport calls them later.
 */

import { User, toPublicUser, type PublicUser } from '../models/user.model';
import { ROLES } from '../constants/roles';
import { ApiError } from '../utils/ApiError';
import { signAccessToken } from '../utils/jwt';
import type { LoginInput, RegisterInput } from '../validators/auth.validator';

/** Shape returned to the client after a successful register/login. */
export interface AuthResult {
  user: PublicUser;
  token: string;
}

/** Emails are stored and compared lowercase so `A@x.com` and `a@x.com` are one account. */
function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function issueToken(user: {
  _id: unknown;
  email: string;
  role: (typeof ROLES)[keyof typeof ROLES];
  companyId: unknown;
}): string {
  return signAccessToken({
    sub: String(user._id),
    email: user.email,
    role: user.role,
    companyId: user.companyId ? String(user.companyId) : null,
  });
}

/**
 * Public self-registration.
 *
 * SECURITY: the role is hardcoded to `driver` and `companyId` to null. Nothing the
 * caller sends can influence either. This is the second of two layers — the validator
 * already rejects a request that even mentions `role` — and it is the one that still
 * holds if the schema is ever loosened.
 */
export async function registerDriver(input: RegisterInput): Promise<AuthResult> {
  const email = normaliseEmail(input.email);

  const existing = await User.findOne({ email }).select('_id');
  if (existing) {
    throw ApiError.conflict('An account with this email already exists.');
  }

  const passwordHash = await User.hashPassword(input.password);

  const user = await User.create({
    name: input.name,
    email,
    phone: input.phone,
    passwordHash,
    role: ROLES.DRIVER,
    status: 'active',
    companyId: null,
  });

  return { user: toPublicUser(user), token: issueToken(user) };
}

/**
 * Email + password login.
 *
 * Returns the same message whether the email is unknown or the password is wrong.
 * Distinguishing them would turn this endpoint into a way to discover which email
 * addresses have accounts.
 */
export async function login(input: LoginInput): Promise<AuthResult> {
  const email = normaliseEmail(input.email);

  // `+passwordHash` is required because the field is `select: false` by default.
  const user = await User.findOne({ email }).select('+passwordHash');

  if (!user || !(await user.comparePassword(input.password))) {
    throw ApiError.unauthorized('Invalid email or password.');
  }

  if (user.status !== 'active') {
    throw ApiError.forbidden('Your account has been suspended. Contact an administrator.');
  }

  // `updateOne` rather than `user.save()` — this touches one field and avoids
  // re-running validation and re-writing the password hash.
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

  return { user: toPublicUser(user), token: issueToken(user) };
}

/** Load the current user's own profile. */
export async function getCurrentUser(userId: string): Promise<PublicUser> {
  const user = await User.findById(userId);

  if (!user) {
    throw ApiError.notFound('User not found.');
  }

  return toPublicUser(user);
}
