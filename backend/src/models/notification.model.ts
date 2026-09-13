/**
 * Notification — an in-app message for exactly one person.
 *
 * ONE ROW, ONE USER. There is no company-wide or broadcast notification in this module. A
 * company-level event (a complaint filed against Company A) writes one row per staff member
 * rather than one shared row with visibility rules.
 *
 * That costs a handful of extra rows and buys a question that a shared row cannot answer:
 * WHAT WOULD "MARK AS READ" MEAN? Read by one person, or by all? There is no clean answer, so
 * rather than invent one, ownership stays 100% `userId`-based — one scoping mechanism for the
 * whole module, not two.
 *
 * THE ROW IS THE NOTIFICATION; THE SOCKET IS DELIVERY. Module 8 pushes these live, but a client
 * that was offline finds them waiting on next load. That is the whole reason they are stored
 * rather than only emitted.
 */

import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

import {
  NOTIFICATION_TYPES,
  REFERENCE_TYPES,
  type NotificationType,
  type ReferenceType,
} from '../constants/notification';

export interface INotification {
  /** The recipient, and the ONLY security boundary in this module. */
  userId: Types.ObjectId;

  type: NotificationType;
  title: string;
  message: string;

  /** What to navigate to. A notification you cannot act on is not much use. */
  referenceType: ReferenceType;
  referenceId: Types.ObjectId;

  /** The business identity of the event. See `constants/notification.ts`. */
  dedupeKey: string;

  isRead: boolean;
  readAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export type NotificationModel = Model<INotification>;

const notificationSchema = new Schema<INotification, NotificationModel>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 500 },

    referenceType: { type: String, enum: REFERENCE_TYPES, required: true },
    referenceId: { type: Schema.Types.ObjectId, required: true },

    dedupeKey: { type: String, required: true },

    isRead: { type: Boolean, required: true, default: false },
    readAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/**
 * ONE INDEX FOR ALL THREE QUERIES.
 *
 * Every query in this module is already pinned to `userId` — there is no cross-user read
 * anywhere — so a single compound index serves the list (newest first), the unread filter, and
 * the unread count. A separate index on `isRead` or `createdAt` alone would never be used,
 * because neither is ever queried without a user.
 */
notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

/**
 * THE DEDUP GUARANTEE.
 *
 * A repeated business event cannot produce a repeated notification. The second insert fails with
 * E11000, which the service swallows deliberately — a retry is expected traffic, not an error,
 * exactly as Module 10 treats a duplicate webhook.
 *
 * Scoped per user, not globally, because a fanned-out `complaint_created` legitimately creates
 * the same key for several different staff members.
 */
notificationSchema.index({ userId: 1, dedupeKey: 1 }, { unique: true, name: 'one_notification_per_event' });

export const Notification = model<INotification, NotificationModel>(
  'Notification',
  notificationSchema,
);

export type NotificationDocument = HydratedDocument<INotification>;

/** Explicit allow-list. `dedupeKey` is internal bookkeeping and is not exposed. */
export interface PublicNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  referenceType: ReferenceType;
  referenceId: string;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

export function toPublicNotification(notification: NotificationDocument): PublicNotification {
  return {
    id: String(notification._id),
    type: notification.type,
    title: notification.title,
    message: notification.message,
    referenceType: notification.referenceType,
    referenceId: String(notification.referenceId),
    isRead: notification.isRead,
    readAt: notification.readAt ? notification.readAt.toISOString() : null,
    createdAt: notification.createdAt.toISOString(),
  };
}
