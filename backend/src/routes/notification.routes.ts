import { Router } from 'express';

import {
  getUnreadCount,
  listNotifications,
  markAllAsRead,
  markAsRead,
} from '../controllers/notification.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { validateParams, validateQuery } from '../middlewares/validate.middleware';
import {
  listNotificationsQuerySchema,
  notificationIdParamSchema,
} from '../validators/notification.validator';

const router = Router();

/*
 * Mounted at /notifications.
 *
 * NO `authorize(...)` ANYWHERE IN THIS FILE, and that is deliberate rather than an omission.
 * Every role has notifications, and every route is scoped to the authenticated user by
 * `applyOwnerScope` inside the service. Role is irrelevant here — ownership is the only boundary,
 * and it is the same boundary for a driver and a super_admin.
 *
 * No POST: notifications are a consequence of business events, never something a client creates.
 * No DELETE: a read notification simply stops being unread.
 */
router.use(authenticate);

router.get('/', validateQuery(listNotificationsQuerySchema), listNotifications);

router.get('/unread-count', getUnreadCount);

/**
 * Declared BEFORE `/:notificationId/read`, because Express matches in declaration order and
 * "read-all" would otherwise be captured as an id and rejected by the ObjectId validator.
 */
router.patch('/read-all', markAllAsRead);

router.patch('/:notificationId/read', validateParams(notificationIdParamSchema), markAsRead);

export default router;
