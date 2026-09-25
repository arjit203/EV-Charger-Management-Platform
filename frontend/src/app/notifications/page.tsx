'use client';

/**
 * Full notification history.
 *
 * The bell shows the last handful; this is everything. Same data, same ownership — scoped to the
 * authenticated user by the server, with no filtering here.
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';

import { RequireAuth } from '@/components/RequireAuth';
import { useAsyncData } from '@/hooks/useAsyncData';
import { useSocketEvent } from '@/hooks/useSocketEvent';
import { toMessage } from '@/lib/formatApiError';
import {
  listNotifications,
  markAllAsRead,
  markAsRead,
} from '@/services/notification.service';
import type { AppNotification } from '@/types/api';
import { formatDateTime } from '@/lib/datetime';

function hrefFor(notification: AppNotification): string {
  switch (notification.referenceType) {
    case 'charging_session':
      return `/sessions/${notification.referenceId}`;
    case 'complaint':
      return `/complaints/${notification.referenceId}`;
    case 'payment':
      return '/wallet';
    case 'charger':
      return `/chargers/${notification.referenceId}`;
    default:
      return '/notifications';
  }
}

function NotificationsContent() {
  const router = useRouter();
  const [unreadOnly, setUnreadOnly] = useState(false);

  const load = useCallback(
    () => listNotifications({ limit: 50, unread: unreadOnly }),
    [unreadOnly],
  );

  const { state, reload, setData } = useAsyncData(load);

  // A notification arriving while this page is open belongs at the top of it.
  useSocketEvent<{ notification: AppNotification }>('notification:new', ({ notification }) => {
    setData((data) => ({
      ...data,
      items: [notification, ...data.items],
      total: data.total + 1,
    }));
  });

  async function open(notification: AppNotification) {
    if (!notification.isRead) {
      try {
        await markAsRead(notification.id);
      } catch {
        // Navigation matters more than the read flag; the next load corrects it.
      }
    }
    router.push(hrefFor(notification));
  }

  return (
    <main className="page page-detail page-flow">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
          <p className="mt-1 text-sm text-neutral-500">Everything the platform has told you.</p>
        </div>
        <button
          type="button"
          onClick={() => void markAllAsRead().then(reload)}
          className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium transition-colors hover:bg-neutral-500/10 dark:border-neutral-700"
        >
          Mark all read
        </button>
      </div>

      <label className="mt-6 flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
        <input
          type="checkbox"
          checked={unreadOnly}
          onChange={(event) => setUnreadOnly(event.target.checked)}
        />
        Unread only
      </label>

      <div className="mt-6 space-y-2">
        {state.status === 'loading' && <p className="text-sm text-neutral-500">Loading…</p>}

        {state.status === 'error' && (
          <p className="rounded-lg bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-400">
            {toMessage(state.error)}
          </p>
        )}

        {state.status === 'ok' && state.data.items.length === 0 && (
          <p className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
            {unreadOnly ? 'Nothing unread.' : 'Nothing yet.'}
          </p>
        )}

        {state.status === 'ok' &&
          state.data.items.map((notification) => (
            <button
              key={notification.id}
              type="button"
              onClick={() => void open(notification)}
              data-highlight={!notification.isRead}
              className="list-row w-full !block"
            >
              <p className={`flex items-center gap-2 ${notification.isRead ? 'font-normal text-neutral-300' : 'font-medium'}`}>
                {!notification.isRead && (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" aria-label="Unread" />
                )}
                {notification.title}
              </p>
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                {notification.message}
              </p>
              <p className="mt-1.5 text-xs text-neutral-500">
                {formatDateTime(notification.createdAt)}
              </p>
            </button>
          ))}
      </div>
    </main>
  );
}

export default function NotificationsPage() {
  return (
    <RequireAuth>
      <NotificationsContent />
    </RequireAuth>
  );
}
