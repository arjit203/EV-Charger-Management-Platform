/**
 * Request validation for notifications.
 *
 * The smallest validator in the project, because notifications accept almost nothing: they are
 * created by business events, not by requests. There is no create schema at all.
 */

import { z } from 'zod';

const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid 24-character resource id');

export const notificationIdParamSchema = z.object({ notificationId: objectId });

export const listNotificationsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    /** `?unread=true` for the bell dropdown; omitted for the full history page. */
    unread: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .strict();

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;
