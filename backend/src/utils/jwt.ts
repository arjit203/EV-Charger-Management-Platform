/**
 * JWT signing and verification.
 *
 * Token transport for this project is `Authorization: Bearer <token>`. All knowledge
 * of that choice lives here and in `auth.middleware.ts`, so moving to httpOnly cookies
 * later is a two-file change on the backend.
 *
 * The payload deliberately carries `role` and `companyId`. That lets middleware make an
 * authorisation decision without a database round trip — but note that a token issued
 * before a role change still carries the OLD role until it expires, which is why
 * `auth.middleware.ts` reloads the user and treats the database as authoritative.
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
