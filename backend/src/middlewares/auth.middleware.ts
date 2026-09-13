/**
 * Authentication middleware — establishes WHO is making the request.
 *
 * Reads `Authorization: Bearer <token>`, verifies it, then reloads the user from the
 * database and attaches a minimal `req.user`.
 *
 * The database reload is deliberate. A JWT is a snapshot: a token issued before an
 * admin suspended an account, changed its role, or reassigned its company still
 * carries the old claims until it expires. Treating the token as authoritative would
 * mean a suspended user keeps full access for up to `JWT_EXPIRES_IN`.
 *
 * COST, ACCEPTED ON PURPOSE: this adds one indexed `findById` to EVERY authenticated
 * request — every station list, every charger status poll, and from Module 8 every
 * socket handshake. That is a real, permanent overhead, not an oversight. It is the
 * correct trade at this scale: revocation that actually works beats a few saved
 * milliseconds.
 *
 * Do NOT "optimise" this by trusting the token's claims, or by bolting on a Redis
 * user cache when Module 8 makes things feel slow — a cache reintroduces the same
 * staleness window this reload exists to close, just with extra infrastructure. If it
 * ever genuinely needs to change, that is a deliberate Module 16 decision with a
 * cache-invalidation story, not a performance tweak made mid-module.
 */

import { User } from '../models/user.model';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { verifyAccessToken } from '../utils/jwt';

const BEARER_PREFIX = 'Bearer ';

export const authenticate = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization;

  if (!header || !header.startsWith(BEARER_PREFIX)) {
    throw ApiError.unauthorized('Authentication required. Send an Authorization: Bearer <token> header.');
  }

  const token = header.slice(BEARER_PREFIX.length).trim();
  if (!token) {
    throw ApiError.unauthorized('Authentication token is missing.');
  }

  const payload = verifyAccessToken(token);

  const user = await User.findById(payload.sub).select('_id email role status companyId');

  if (!user) {
    // Valid signature, but the account is gone — e.g. deleted after the token was issued.
    throw ApiError.unauthorized('This account no longer exists.');
  }

  if (user.status !== 'active') {
    throw ApiError.forbidden('Your account has been suspended. Contact an administrator.');
  }

  req.user = {
    id: String(user._id),
    email: user.email,
    role: user.role,
    companyId: user.companyId ? String(user.companyId) : null,
  };

  next();
});
