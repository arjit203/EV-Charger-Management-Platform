/**
 * Notification API calls.
 *
 * Note what is missing: any way to create one. Notifications are a consequence of business
 * events, so the client can only read them and mark them read.
 */

import { apiRequest } from './apiClient';
import type {
  AppNotification,
  NotificationPayload,
  Paginated,
  UnreadCountPayload,
} from '@/types/api';

/** Newest first. `unread` filters to the bell's dropdown set. */
export function listNotifications(
  params: { page?: number; limit?: number; unread?: boolean } = {},
): Promise<Paginated<AppNotification>> {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  // Only sent when true — the API's `unread` filter has no "false" meaning, it is either
  // applied or absent.
  if (params.unread) query.set('unread', 'true');
  const suffix = query.toString() ? `?${query}` : '';
  return apiRequest<Paginated<AppNotification>>(`/notifications${suffix}`, { cache: 'no-store' });
}

/** Counted server-side. A local counter drifts; this is the number. */
export async function getUnreadCount(): Promise<number> {
  const { unreadCount } = await apiRequest<UnreadCountPayload>('/notifications/unread-count', {
    cache: 'no-store',
  });
  return unreadCount;
}

/** Idempotent — marking an already-read notification returns it unchanged. */
export async function markAsRead(notificationId: string): Promise<AppNotification> {
  const { notification } = await apiRequest<NotificationPayload>(
    `/notifications/${notificationId}/read`,
    { method: 'PATCH' },
  );
  return notification;
}

export async function markAllAsRead(): Promise<number> {
  const { updated } = await apiRequest<{ updated: number }>('/notifications/read-all', {
    method: 'PATCH',
  });
  return updated;
}
