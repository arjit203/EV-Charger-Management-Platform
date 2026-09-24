/**
 * Notification business logic.
 *
 * THE DIVISION OF LABOUR THIS FILE EXISTS TO ENFORCE:
 *
 *   a call site says       "this happened"
 *   this service decides   whether anyone is told, who, and what it says
 *
 * That is why every trigger below takes a domain object and nothing else. Module 7 does not
 * decide what a driver should read; it announces that a session completed. If the wording,
 * audience or dedup rule changes, it changes here — not in eleven places.
 *
 * EVERY TRIGGER IS FIRE-AND-FORGET AND CANNOT THROW. A notification failure must never roll back
 * a payment, fail an OCPP message, or break a complaint transition. Same discipline as Module
 * 8's emits, and for the same reason.
 */

import { Types } from 'mongoose';

import {
  Notification,
  toPublicNotification,
  type PublicNotification,
} from '../models/notification.model';
import { User } from '../models/user.model';
import { Station } from '../models/station.model';
import { complaintRef } from '../models/complaint.model';
import { dedupeKeys, type NotificationType, type ReferenceType } from '../constants/notification';
import { ROLES } from '../constants/roles';
import { ApiError } from '../utils/ApiError';
import { applyOwnerScope } from '../utils/ownerScope';
import { logger } from '../utils/logger';
import { formatPaise } from '../utils/money';
import * as realtime from '../realtime/publisher';
import type { Paginated } from '../types/pagination';
import type { AuthUser } from '../types/express';

const SCOPE = 'notification';
const DUPLICATE_KEY = 11000;

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(error) && (error as { code?: number }).code === DUPLICATE_KEY;
}

export interface CreateNotificationInput {
  userId: Types.ObjectId | string;
  type: NotificationType;
  title: string;
  message: string;
  referenceType: ReferenceType;
  referenceId: Types.ObjectId | string;
  dedupeKey: string;
}

/**
 * The one place a notification is created.
 *
 * A DUPLICATE IS NOT AN ERROR. The unique index on `{ userId, dedupeKey }` rejects a repeated
 * business event, and that rejection is swallowed — the settlement sweeper retrying every 15
 * seconds is expected traffic, not misbehaviour. Same treatment as Module 10's duplicate webhook.
 *
 * Returns null when nothing was created, so a caller can tell "already told them" from "told
 * them" if it ever matters. Nothing currently needs to.
 */
export async function createNotification(
  input: CreateNotificationInput,
): Promise<PublicNotification | null> {
  try {
    const notification = await Notification.create({
      userId: new Types.ObjectId(String(input.userId)),
      type: input.type,
      title: input.title,
      message: input.message,
      referenceType: input.referenceType,
      referenceId: new Types.ObjectId(String(input.referenceId)),
      dedupeKey: input.dedupeKey,
      isRead: false,
    });

    const payload = toPublicNotification(notification);

    /*
     * Delivery, reusing Module 8's existing `user:{id}` room — the one every socket already
     * auto-joins from its verified identity. No new room type, no new authentication: a driver
     * cannot subscribe to someone else's notifications because there is no join listener to ask.
     *
     * Best-effort. The ROW is the notification; this is delivery. A client that was offline
     * finds it waiting.
     */
    realtime.emitNotification(String(input.userId), payload);

    return payload;
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      // The same event, again. Exactly what the index is for.
      return null;
    }

    // Never rethrown to the caller — see the file header. A notification problem is not a
    // charging problem.
    logger.error(
      SCOPE,
      `Couldn't save an in-app notification (${input.dedupeKey}) — the action itself still succeeded`,
      error,
    );
    return null;
  }
}

/**
 * Fan out one event to every staff member of a company.
 *
 * `cpo_admin` AND `operator`, because Module 11 lets operators work tickets — notifying only
 * admins would tell people who cannot act and miss people who can.
 *
 * One row each, never a shared row. See the note in `notification.model.ts` for why.
 */
async function notifyCompanyStaff(
  companyId: Types.ObjectId | string,
  build: (userId: Types.ObjectId) => CreateNotificationInput,
): Promise<number> {
  const staff = await User.find({
    companyId: new Types.ObjectId(String(companyId)),
    role: { $in: [ROLES.CPO_ADMIN, ROLES.OPERATOR] },
    status: 'active',
  }).select('_id');

  let created = 0;
  for (const member of staff) {
    if (await createNotification(build(member._id))) created += 1;
  }

  return created;
}

/* -------------------------------------------------------------------------- */
/* Triggers — called from the existing choke points, one line each             */
/* -------------------------------------------------------------------------- */

/** Just enough of a session to write about it, so this file need not import Module 7's model. */
export interface SessionLike {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  energyConsumedWh: number;
  amountPaise: number | null;
  failureReason: string | null;
  /** Set when staff force-stopped the charge — the driver must hear that it was not them. */
  stoppedByRole?: string | null;
  stopNote?: string | null;
}

function wasForceStopped(session: SessionLike): boolean {
  return Boolean(session.stoppedByRole) && session.stoppedByRole !== 'driver';
}

export async function sessionStarted(session: SessionLike): Promise<void> {
  await createNotification({
    userId: session.userId,
    type: 'charging_started',
    title: 'Charging started',
    message: 'Your vehicle is now charging. You can watch the energy climb on the session page.',
    referenceType: 'charging_session',
    referenceId: session._id,
    dedupeKey: dedupeKeys.session(String(session._id), 'started'),
  });
}

export async function sessionCompleted(session: SessionLike): Promise<void> {
  const kwh = (session.energyConsumedWh / 1000).toFixed(3);
  const delivered =
    session.amountPaise === null
      ? `${kwh} kWh delivered.`
      : `${kwh} kWh for ${formatPaise(session.amountPaise)}.`;

  /*
   * A FORCE-STOP IS NOT "COMPLETED" FROM THE DRIVER'S SIDE. Their car stopped charging and they
   * did not ask it to — the notification says who did and why, and that they pay only for what
   * was delivered. Without this, the driver's only clue is a charge that ended early.
   */
  const forced = wasForceStopped(session);

  await createNotification({
    userId: session.userId,
    type: 'charging_completed',
    title: forced ? 'Charging stopped by the station operator' : 'Charging completed',
    message: forced
      ? `The station operator stopped your charge${session.stopNote ? `: "${session.stopNote}"` : '.'} ` +
        `${delivered} You are billed only for the energy delivered. Report a problem from the session page if this was wrong.`
      : `Your charging session has finished. ${delivered}`,
    referenceType: 'charging_session',
    referenceId: session._id,
    dedupeKey: dedupeKeys.session(String(session._id), 'completed'),
  });
}

export async function sessionFailed(session: SessionLike): Promise<void> {
  const kwh = (session.energyConsumedWh / 1000).toFixed(3);

  await createNotification({
    userId: session.userId,
    type: 'charging_failed',
    title: 'Charging did not complete',
    message:
      session.energyConsumedWh > 0
        ? `${session.failureReason ?? 'The session ended unexpectedly.'} ${kwh} kWh was delivered and has been charged for.`
        : session.failureReason ?? 'The session ended before any energy was delivered.',
    referenceType: 'charging_session',
    referenceId: session._id,
    dedupeKey: dedupeKeys.session(String(session._id), 'failed'),
  });
}

export async function paymentSucceeded(
  session: SessionLike,
  amountPaise: number,
): Promise<void> {
  await createNotification({
    userId: session.userId,
    type: 'payment_success',
    title: 'Payment successful',
    message: `${formatPaise(amountPaise)} was paid from your wallet for this charging session.`,
    referenceType: 'charging_session',
    referenceId: session._id,
    dedupeKey: dedupeKeys.session(String(session._id), 'paid'),
  });
}

/**
 * The charge could not be collected.
 *
 * THE DEDUP KEY MATTERS MOST HERE. Module 10's sweeper retries every 15 seconds for as long as
 * the balance is short, so without `session:<id>:pending` a driver would be told four times a
 * minute, indefinitely. They are told once.
 *
 * It is also the notification that prompts a driver to file the `payment_issue` complaint
 * Module 11 built a home for — which is what closes that loop.
 */
export async function paymentPending(
  session: SessionLike,
  amountPaise: number,
): Promise<void> {
  await createNotification({
    userId: session.userId,
    type: 'payment_pending',
    title: 'Payment could not be collected',
    message: `${formatPaise(amountPaise)} is outstanding for your charging session — your balance was too low. Top up and it settles automatically.`,
    referenceType: 'charging_session',
    referenceId: session._id,
    dedupeKey: dedupeKeys.session(String(session._id), 'pending'),
  });
}

export async function walletRecharged(
  userId: Types.ObjectId | string,
  paymentId: Types.ObjectId | string,
  amountPaise: number,
): Promise<void> {
  await createNotification({
    userId,
    type: 'wallet_recharged',
    title: 'Wallet topped up',
    message: `${formatPaise(amountPaise)} was added to your wallet.`,
    referenceType: 'payment',
    referenceId: paymentId,
    dedupeKey: dedupeKeys.payment(String(paymentId), 'recharged'),
  });
}

/* ------------------------------- complaints ------------------------------- */

export interface ComplaintLike {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  companyId: Types.ObjectId | null;
  stationId?: Types.ObjectId | null;
  subject: string;
}

/**
 * A driver filed a complaint — tell the staff who can act on it.
 *
 * An anchorless complaint has no company (Module 11's D3), so there is nobody to notify. That is
 * correct rather than a gap: a platform-level complaint belongs to super_admin, who has no
 * company queue to be alerted about.
 */
export async function complaintCreated(complaint: ComplaintLike): Promise<void> {
  if (!complaint.companyId) return;

  // Which site, in the notification itself — "New complaint" alone makes every recipient open it
  // to find out whether it is theirs to go and fix.
  const station = complaint.stationId
    ? await Station.findById(complaint.stationId).select('name city').lean()
    : null;
  const where = station ? ` at ${station.name}, ${station.city}` : '';

  await notifyCompanyStaff(complaint.companyId, (staffUserId) => ({
    userId: staffUserId,
    type: 'complaint_created',
    title: `New complaint ${complaintRef(complaint._id)}`,
    message: `A driver reported${where}: "${complaint.subject}"`,
    referenceType: 'complaint',
    referenceId: complaint._id,
    dedupeKey: dedupeKeys.complaint(String(complaint._id), 'created'),
  }));
}

/** Just enough of a charger to write about it, without importing Module 5's model. */
export interface ChargerFaultLike {
  _id: Types.ObjectId | string;
  companyId: Types.ObjectId | string;
  name: string;
  chargerCode: string;
  /** null for a charge-point-level fault (OCPP connectorId 0) — the MACHINE, not a plug. */
  connectorNumber: number | null;
  errorCode: string | null;
  detectedAt: Date;
}

/**
 * Hardware reported a fault — tell the people who can send an engineer.
 *
 * ONLY ON THE TRANSITION INTO A FAULT, never while one persists. Real chargers repeat their
 * status on reconnect and on a timer; notifying on each repeat would bury the bell. The caller
 * in `ocpp/handlers.ts` owns that decision because only it can see the previous value — this
 * function is told "a fault just started", not "a fault exists".
 *
 * The dedupe key carries the detection SECOND, so a repaired-then-refaulted charger notifies
 * again while a duplicated message does not. See `dedupeKeys.charger`.
 */
export async function chargerFault(charger: ChargerFaultLike): Promise<void> {
  const target =
    charger.connectorNumber === null
      ? `Charger ${charger.chargerCode} (${charger.name})`
      : `Connector ${charger.connectorNumber} on ${charger.chargerCode} (${charger.name})`;

  const detail = charger.errorCode ? ` Reported: ${charger.errorCode}.` : '';

  await notifyCompanyStaff(charger.companyId, (staffUserId) => ({
    userId: staffUserId,
    type: 'charger_fault',
    title: charger.connectorNumber === null ? 'Charger fault' : 'Connector fault',
    message: `${target} reported a fault and cannot be used.${detail}`,
    referenceType: 'charger',
    referenceId: charger._id,
    dedupeKey: dedupeKeys.charger(
      String(charger._id),
      `fault:${charger.connectorNumber ?? 0}:${Math.floor(charger.detectedAt.getTime() / 1000)}`,
    ),
  }));
}

/**
 * A complaint changed status — tell the driver who filed it.
 *
 * The dedupe key carries the NEW STATUS, so all three transitions produce three notifications
 * rather than one. This is the case that ruled out keying on ids alone.
 */
export async function complaintUpdated(
  complaint: ComplaintLike,
  status: string,
  resolution: string | null,
  /**
   * Position in the complaint's history. Part of the dedupe key because a reopened complaint
   * can reach the same status twice — keyed on status alone, the second "resolved" would be
   * swallowed as a duplicate and the driver never told.
   */
  historyLength: number,
): Promise<void> {
  const messages: Record<string, string> = {
    in_progress: 'Someone is looking into your complaint.',
    resolved: resolution
      ? `Your complaint has been resolved: ${resolution}`
      : 'Your complaint has been resolved.',
    closed: 'Your complaint has been closed. If the problem comes back, you can report it again as a follow-up.',
    open: 'Your complaint is back in the support queue.',
  };

  await createNotification({
    userId: complaint.userId,
    type: 'complaint_updated',
    // Ticket number and subject in the notification: a driver with two open tickets cannot tell
    // which one "Complaint resolved" is about.
    title: `Complaint ${complaintRef(complaint._id)} ${status.replace('_', ' ')}`,
    message: `"${complaint.subject}" — ${messages[status] ?? 'Your complaint was updated.'}`,
    referenceType: 'complaint',
    referenceId: complaint._id,
    dedupeKey: dedupeKeys.complaint(String(complaint._id), `${status}:${historyLength}`),
  });
}

/**
 * The driver disputed a resolution — tell the staff who can act on it, with the driver's reason,
 * because "reopened" alone gives them nothing to start from.
 */
export async function complaintReopened(
  complaint: ComplaintLike,
  reason: string,
  historyLength: number,
): Promise<void> {
  if (!complaint.companyId) return;

  await notifyCompanyStaff(complaint.companyId, (staffUserId) => ({
    userId: staffUserId,
    type: 'complaint_updated',
    title: `Complaint ${complaintRef(complaint._id)} reopened by driver`,
    message: `"${complaint.subject}" — ${reason}`,
    referenceType: 'complaint',
    referenceId: complaint._id,
    dedupeKey: dedupeKeys.complaint(String(complaint._id), `reopened:${historyLength}`),
  }));
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Owner-scoped, with NO super_admin bypass — Module 3's rule.
 *
 * Someone else's notifications are personal data, and there is no admin path to them at all in
 * this module. Nothing needs one.
 */
export async function listNotifications(
  actor: AuthUser,
  options: { page?: number; limit?: number; unread?: boolean } = {},
): Promise<Paginated<PublicNotification>> {
  const filter: Record<string, unknown> = {};
  if (options.unread) filter.isRead = false;

  const scoped = applyOwnerScope(actor, filter);

  const page = options.page ?? 1;
  const limit = options.limit ?? 20;

  const [items, total] = await Promise.all([
    Notification.find(scoped).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Notification.countDocuments(scoped),
  ]);

  return {
    items: items.map(toPublicNotification),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

export async function getUnreadCount(actor: AuthUser): Promise<number> {
  return Notification.countDocuments(applyOwnerScope(actor, { isRead: false }));
}

/**
 * Mark one as read.
 *
 * IDEMPOTENT, not a conflict. Re-reading something you have already read is not an error worth a
 * 409 — the row comes back unchanged.
 */
export async function markAsRead(
  actor: AuthUser,
  notificationId: string,
): Promise<PublicNotification> {
  const notification = await Notification.findOne(
    applyOwnerScope(actor, { _id: notificationId }),
  );

  // 404 rather than 403: notifications are personal, so "not yours" and "does not exist" are the
  // same answer, and neither confirms anything about another user's data.
  if (!notification) throw ApiError.notFound('Notification not found.');

  if (!notification.isRead) {
    notification.isRead = true;
    notification.readAt = new Date();
    await notification.save();
  }

  return toPublicNotification(notification);
}

/**
 * Mark everything read.
 *
 * Owner-scoped BY CONSTRUCTION: the filter is built by `applyOwnerScope`, so this cannot touch
 * another user's rows even if someone later adds a parameter to it.
 */
export async function markAllAsRead(actor: AuthUser): Promise<number> {
  const result = await Notification.updateMany(
    applyOwnerScope(actor, { isRead: false }),
    { $set: { isRead: true, readAt: new Date() } },
  );

  return result.modifiedCount;
}
