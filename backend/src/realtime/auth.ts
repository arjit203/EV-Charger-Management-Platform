/**
 * Socket.IO handshake authentication.
 *
 * A socket is not an HTTP request: it has no `Authorization` header it can resend, because
 * there is only ONE request — the upgrade — and everything after it is frames on an already
 * open connection. So the JWT travels in `socket.handshake.auth.token`, which the client
 * supplies once when it connects.
 *
 * WHAT THIS DELIBERATELY REUSES, rather than inventing a parallel scheme:
 *
 *   auth.middleware.ts    verify the signature, then RELOAD THE USER FROM MONGO
 *   requireActiveCompany  a company-scoped user's company must still be active
 *
 * Trusting the token's claims here would be a real inconsistency: Module 1 explicitly decided
 * never to trust them for REST, and a socket is longer-lived than a request, so a stale claim
 * would persist for longer, not less. The same indexed lookups, knowingly paid for — but ONCE
 * per connection rather than once per request, which makes this the cheapest place in the
 * project to apply the rule.
 *
 * Rejecting at the handshake means an unauthenticated socket is never established at all,
 * rather than connected-then-ignored.
 */

import type { Socket } from 'socket.io';

import { Company } from '../models/company.model';
import { User } from '../models/user.model';
import { ROLES } from '../constants/roles';
import { verifyAccessToken } from '../utils/jwt';
import { logger } from '../utils/logger';
import type { AuthUser } from '../types/express';

const SCOPE = 'realtime';

/** The authenticated user, attached to the socket for the life of the connection. */
export interface SocketData {
  user: AuthUser;
}

export type AppSocket = Socket<
  Record<string, never>,
  Record<string, unknown>,
  Record<string, never>,
  SocketData
>;

/**
 * Errors handed back to the client.
 *
 * Deliberately vague about WHY. A connection attempt is unauthenticated by definition, so a
 * precise reason ("this account is suspended") would tell an attacker which of their guesses
 * was a real account. The server log keeps the detail.
 */
function reject(reason: string): Error {
  return new Error(reason);
}

export async function authenticateSocket(
  socket: AppSocket,
  next: (error?: Error) => void,
): Promise<void> {
  try {
    const raw = socket.handshake.auth?.token;
    const token = typeof raw === 'string' ? raw.trim() : '';

    if (!token) {
      next(reject('Authentication required'));
      return;
    }

    // Throws on a bad signature or an expired token; both land in the catch below.
    const payload = verifyAccessToken(token);

    // THE DATABASE IS AUTHORITATIVE. The token's role and companyId are informational only.
    const user = await User.findById(payload.sub).select('_id email role status companyId');

    if (!user) {
      logger.warn(SCOPE, `Socket rejected: account ${String(payload.sub)} no longer exists`);
      next(reject('Authentication failed'));
      return;
    }

    if (user.status !== 'active') {
      logger.warn(SCOPE, `Socket rejected: account ${user.email} is ${user.status}`);
      next(reject('Authentication failed'));
      return;
    }

    const companyId = user.companyId ? String(user.companyId) : null;

    // Mirrors requireActiveCompany. A super_admin has no company to check; a company-scoped
    // role with no company at all fails closed rather than connecting unscoped.
    if (user.role !== ROLES.SUPER_ADMIN && user.role !== ROLES.DRIVER) {
      if (!companyId) {
        logger.warn(SCOPE, `Socket rejected: ${user.email} has no company`);
        next(reject('Authentication failed'));
        return;
      }

      const company = await Company.findById(companyId).select('status');
      if (!company || company.status !== 'active') {
        logger.warn(SCOPE, `Socket rejected: company for ${user.email} is unavailable`);
        next(reject('Authentication failed'));
        return;
      }
    }

    socket.data.user = {
      id: String(user._id),
      email: user.email,
      role: user.role,
      companyId,
    };

    next();
  } catch (error) {
    logger.warn(
      SCOPE,
      `Socket handshake rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
    next(reject('Authentication failed'));
  }
}
