/**
 * Socket.IO room naming and ASSIGNMENT.
 *
 * THE SECURITY RULE OF THIS WHOLE MODULE: rooms are joined by the SERVER, from the
 * authenticated user, immediately on connection. There is no client-facing "join" message —
 * not a validated one, none at all.
 *
 * That is deliberate. If the server ever honoured `socket.emit('join', 'company:B')`, it would
 * be the socket equivalent of trusting `req.body.companyId` — exactly the vulnerability class
 * every module since Module 2 has been built to close. The safest validation is a code path
 * that does not exist, so `realtime/index.ts` registers no join listener.
 *
 * THREE ROOMS, which is the minimum that satisfies every scope:
 *
 *   company:{companyId}   cpo_admin + operator — everything happening at their own stations
 *   user:{userId}         driver — their own session events, and nothing else
 *   platform              super_admin — one static room, so we never have to track which
 *                         companies exist in order to fan out to them
 *
 * Deliberately NOT created: station, charger or session rooms. A company-scoped staff member
 * already receives every event for their company through the company room, and a charger or
 * session detail page filters on `chargerId` / `sessionId` fields it already holds. That is a
 * DISPLAY concern, not a security boundary — no data crosses a company line either way.
 */

import { ROLES } from '../constants/roles';
import type { AuthUser } from '../types/express';

/** Every event for one company's hardware and the charges happening on it. */
export const companyRoom = (companyId: string): string => `company:${companyId}`;

/** One driver's own session events. */
export const userRoom = (userId: string): string => `user:${userId}`;

/** Platform-wide. Static, so a super_admin needs no per-company subscriptions. */
export const PLATFORM_ROOM = 'platform';

/**
 * Which rooms this user belongs in — derived purely from the verified identity.
 *
 * A driver gets ONLY their personal room. That is what makes cross-company charging work
 * safely: a driver charging at company B's station is never placed in `company:B`, so they see
 * their own session and none of B's other traffic.
 */
export function roomsFor(user: AuthUser): string[] {
  if (user.role === ROLES.SUPER_ADMIN) return [PLATFORM_ROOM];

  if (user.role === ROLES.CPO_ADMIN || user.role === ROLES.OPERATOR) {
    // resolveCompanyScope would throw for a staff member with no company; that case is already
    // rejected at the handshake, so this is only ever reached with a company present.
    return user.companyId ? [companyRoom(user.companyId)] : [];
  }

  return [userRoom(user.id)];
}

/**
 * The audience for an event about one company's hardware.
 *
 * Always includes the platform room, which is why super_admin sees everything without the
 * server tracking a growing list of company rooms.
 */
export function companyAudience(companyId: string): string[] {
  return [companyRoom(companyId), PLATFORM_ROOM];
}

/**
 * The audience for a session event: the station's company, the platform, AND the driver.
 *
 * The driver is the reason this is a separate helper. They are not in the company room — often
 * they could not be, because they have no relationship with that company at all — so without
 * their personal room they would never learn that their own charge had started.
 */
export function sessionAudience(companyId: string, userId: string): string[] {
  return [companyRoom(companyId), userRoom(userId), PLATFORM_ROOM];
}
