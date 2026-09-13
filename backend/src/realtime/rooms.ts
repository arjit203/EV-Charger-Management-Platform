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
 * A driver gets no company room. That is what makes cross-company charging work safely: a driver
 * charging at company B's station is never placed in `company:B`, so they see their own traffic
 * and none of B's.
 *
 * EVERY SOCKET JOINS ITS OWN `user:{id}` ROOM (Module 12, flagged change to Module 8).
 *
 * Originally only drivers did, because the only thing addressed to a person was a driver's own
 * session. Module 12 broke that assumption: a `complaint_created` notification is addressed to a
 * specific STAFF MEMBER, and staff were in `company:{id}` only — so the row was written and the
 * live delivery silently went nowhere. A test caught it.
 *
 * The right way to think about it: the user room is about WHO YOU ARE, the company and platform
 * rooms are about WHAT YOU CAN SEE. Everyone has the first.
 *
 * This widens nothing it should not. The only other thing emitted to a user room is a session
 * event, addressed with the DRIVER's id — staff do not have charging sessions, so a staff member
 * in their own room receives nothing extra.
 */
export function roomsFor(user: AuthUser): string[] {
  // Always. See the note above.
  const rooms = [userRoom(user.id)];

  if (user.role === ROLES.SUPER_ADMIN) {
    rooms.push(PLATFORM_ROOM);
  } else if (user.role === ROLES.CPO_ADMIN || user.role === ROLES.OPERATOR) {
    // A staff member with no company is already rejected at the handshake, so this is only ever
    // reached with one present.
    if (user.companyId) rooms.push(companyRoom(user.companyId));
  }

  return rooms;
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
