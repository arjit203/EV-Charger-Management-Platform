/**
 * Notification HTTP handlers. Thin, as always.
 *
 * Note what is absent: there is no POST. Notifications come from business events, never from a
 * client — and there is no detail endpoint either, because the list already carries every field
 * a caller could ask for.
 */

import type { Request, Response } from 'express';

import * as notificationService from '../services/notification.service';
import { ApiError } from '../utils/ApiError';
import { sendSuccess } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import type { ListNotificationsQuery } from '../validators/notification.validator';

function requireUser(req: Request) {
  if (!req.user) throw ApiError.unauthorized('Authentication required.');
  return req.user;
}

/** GET /notifications — newest first, `?unread=true` to filter. */
export const listNotifications = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, unread } = req.query as unknown as ListNotificationsQuery;

  const result = await notificationService.listNotifications(requireUser(req), {
    page,
    limit,
    unread,
  });

  sendSuccess(res, result, 'Notifications retrieved');
});

/**
 * GET /notifications/unread-count
 *
 * Counted server-side for the authenticated user. A frontend counter is a display convenience
 * that drifts; this is the number.
 */
export const getUnreadCount = asyncHandler(async (req: Request, res: Response) => {
  const unreadCount = await notificationService.getUnreadCount(requireUser(req));
  sendSuccess(res, { unreadCount }, 'Unread count retrieved');
});

/**
 * PATCH /notifications/read-all
 *
 * Declared before the `:notificationId` route in the router, or "read-all" would be parsed as an
 * id and fail validation.
 */
export const markAllAsRead = asyncHandler(async (req: Request, res: Response) => {
  const updated = await notificationService.markAllAsRead(requireUser(req));
  sendSuccess(res, { updated }, `${updated} notification${updated === 1 ? '' : 's'} marked read`);
});

/** PATCH /notifications/:notificationId/read — idempotent. */
export const markAsRead = asyncHandler(async (req: Request, res: Response) => {
  const notification = await notificationService.markAsRead(
    requireUser(req),
    String(req.params.notificationId),
  );

  sendSuccess(res, { notification }, 'Notification marked read');
});
