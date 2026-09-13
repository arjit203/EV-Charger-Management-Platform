/**
 * JWT signing and verification.
 *
 * Token transport for this project is `Authorization: Bearer <token>`. All knowledge
 * of that choice lives here and in `auth.middleware.ts`, so moving to httpOnly cookies
 * later is a two-file change on the backend.
 *
 * IMPORTANT: the `role` and `companyId` claims in this payload are NOT used to make
 * authorisation decisions. `auth.middleware.ts` reloads the user from MongoDB on every
 * authenticated request and overwrites `req.user` with the database values, because a
 * token issued before a suspension, role change or company reassignment would otherwise
 * keep granting the old access until it expired.
 *
 * So there is deliberately no "fast path" here, and adding one would reintroduce exactly
 * the staleness the reload exists to prevent. The claims are carried for debugging and
 * log correlation only — treat them as informational, never as a source of truth.
 * See the cost note in `auth.middleware.ts`.
 */

import jwt from 'jsonwebtoken';

import { env } from '../config/env';
import { ApiError } from './ApiError';
import type { Role } from '../constants/roles';

export interface AccessTokenPayload {
  /** Standard JWT "subject" claim — the user's id. */
  sub: string;
  email: string;
  role: Role;
  companyId: string | null;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  });
}

/**
 * Verify a token and return its payload.
 *
 * @throws {ApiError} 401, with a message distinguishing an expired token from an
 * invalid one — the frontend needs that difference to decide between "log in again"
 * and "something is wrong".
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.jwtSecret);

    if (typeof decoded === 'string' || !decoded.sub) {
      throw ApiError.unauthorized('Malformed authentication token');
    }

    return {
      sub: String(decoded.sub),
      email: String((decoded as jwt.JwtPayload).email ?? ''),
      role: (decoded as jwt.JwtPayload).role as Role,
      companyId: ((decoded as jwt.JwtPayload).companyId as string | null) ?? null,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;

    if (error instanceof jwt.TokenExpiredError) {
      throw new ApiError(401, 'Your session has expired. Please log in again.', 'TOKEN_EXPIRED');
    }

    throw new ApiError(401, 'Invalid authentication token', 'TOKEN_INVALID');
  }
}
