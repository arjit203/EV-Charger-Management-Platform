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

function hrefFor(notification: AppNotification): string {
  switch (notification.referenceType) {
    case 'charging_session':
      return `/sessions/${notification.referenceId}`;
    case 'complaint':
      return `/complaints/${notification.referenceId}`;
    case 'payment':
      return '/wallet';
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
    if (state.status !== 'ok') return;
    setData({
      ...state.data,
      items: [notification, ...state.data.items],
      total: state.data.total + 1,
    });
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
    <main className="mx-auto max-w-2xl px-6 py-12">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Notifications</h1>
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
              className={`block w-full rounded-xl border p-4 text-left transition-colors hover:bg-neutral-500/5 ${
                notification.isRead
                  ? 'border-neutral-200 dark:border-neutral-800'
                  : 'border-emerald-600/30 bg-emerald-500/5'
              }`}
            >
              <p className="flex items-center gap-2 font-medium">
                {!notification.isRead && (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                )}
                {notification.title}
              </p>
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                {notification.message}
              </p>
              <p className="mt-1.5 text-xs text-neutral-500">
                {new Date(notification.createdAt).toLocaleString()}
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
