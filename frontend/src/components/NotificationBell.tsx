'use client';

/**
 * The notification bell — unread badge plus a dropdown of recent notifications.
 *
 * LIVE, reusing Module 8's infrastructure. A new notification arrives over the `user:{id}` room
 * every socket already joins, through `useSocketEvent` — the hook that exists precisely so
 * listeners cannot accumulate on remount.
 *
 * The badge count comes from the SERVER, not from counting rows held locally. A local counter
 * drifts the moment anything is read in another tab.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { useAuth } from '@/context/AuthContext';
import { useSocketEvent } from '@/hooks/useSocketEvent';
import { useSocket } from '@/context/SocketContext';
import {
  getUnreadCount,
  listNotifications,
  markAllAsRead,
  markAsRead,
  NOTIFICATIONS_CHANGED,
} from '@/services/notification.service';
import type { AppNotification } from '@/types/api';

/** Where each notification takes you. Only routes that actually exist. */
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

function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function NotificationBell() {
  const { user } = useAuth();
  const router = useRouter();

  const [isOpen, setIsOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [items, setItems] = useState<AppNotification[]>([]);
  const [reloadToken, setReloadToken] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const userId = user?.id ?? null;
  /*
   * Anything pushed while the socket was down is gone for good — Socket.IO does not replay. So
   * each RE-connect (not the first connect, which the mount load already covers) refetches.
   */
  const { reconnectCount } = useSocket();
  const resync = reconnectCount > 1 ? reconnectCount : 0;

  /*
   * The project's established load-on-mount shape (see `useAsyncData`): an async IIFE with a
   * `cancelled` flag, state set only AFTER the await.
   *
   * Setting state synchronously in an effect body causes a cascading render and the React
   * Compiler lint rule rejects it — the flag also stops a late response updating an unmounted
   * component, and stops React's dev-mode double-mount clobbering fresh state.
   */
  useEffect(() => {
    if (!userId) return;

    let cancelled = false;

    void (async () => {
      try {
        const [count, list] = await Promise.all([
          getUnreadCount(),
          listNotifications({ limit: 8 }),
        ]);
        if (cancelled) return;
        setUnreadCount(count);
        setItems(list.items);
      } catch {
        // The bell is an accessory. If it cannot load, the rest of the page is unaffected.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, reloadToken, resync]);

  /** Bumped to force a reload after an action that invalidates what is displayed. */
  const refresh = useCallback(() => setReloadToken((value) => value + 1), []);

  // Something else (the Notifications page) marked notifications read — follow it.
  useEffect(() => {
    window.addEventListener(NOTIFICATIONS_CHANGED, refresh);
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED, refresh);
  }, [refresh]);

  /*
   * A new notification arrived. Prepend it and bump the badge rather than refetching — the
   * payload is the complete row, so there is nothing else to ask for.
   */
  useSocketEvent<{ notification: AppNotification }>('notification:new', ({ notification }) => {
    setItems((current) => [notification, ...current].slice(0, 8));
    setUnreadCount((count) => count + 1);
  });

  // Close when clicking outside. Registered only while open, so there is no permanent listener.
  useEffect(() => {
    if (!isOpen) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [isOpen]);

  if (!user) return null;

  async function open(notification: AppNotification) {
    setIsOpen(false);

    if (!notification.isRead) {
      setItems((current) =>
        current.map((n) => (n.id === notification.id ? { ...n, isRead: true } : n)),
      );
      setUnreadCount((count) => Math.max(0, count - 1));
      try {
        await markAsRead(notification.id);
      } catch {
        // A failed mark-as-read must not block navigation — the next refresh corrects it.
      }
    }

    router.push(hrefFor(notification));
  }

  async function clearAll() {
    setUnreadCount(0);
    setItems((current) => current.map((n) => ({ ...n, isRead: true })));
    try {
      await markAllAsRead();
    } catch {
      refresh();
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((value) => !value)}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        className="relative rounded-lg border border-neutral-300 px-3 py-2 text-sm transition-colors hover:bg-neutral-500/10 dark:border-neutral-700"
      >
        🔔
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-[var(--accent)] px-1.5 py-0.5 text-center text-[10px] font-semibold text-[var(--accent-contrast)]">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 z-20 mt-2 w-80 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-lg dark:border-neutral-800 dark:bg-neutral-950">
          <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
            <span className="text-sm font-semibold">Notifications</span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => void clearAll()}
                className="text-xs text-neutral-500 underline underline-offset-2"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 && (
              <p className="px-4 py-8 text-center text-sm text-neutral-500">Nothing yet.</p>
            )}

            {items.map((notification) => (
              <button
                key={notification.id}
                type="button"
                onClick={() => void open(notification)}
                className={`block w-full border-b border-neutral-100 px-4 py-3 text-left transition-colors hover:bg-neutral-500/5 dark:border-neutral-900 ${
                  notification.isRead ? '' : 'bg-[var(--accent-soft)]'
                }`}
              >
                <p className="flex items-center gap-2 text-sm font-medium">
                  {!notification.isRead && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" aria-label="Unread" />
                  )}
                  {notification.title}
                </p>
                <p className="mt-0.5 text-xs text-neutral-500">{notification.message}</p>
                <p className="mt-1 text-[11px] text-neutral-400">
                  {relativeTime(notification.createdAt)}
                </p>
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => {
              setIsOpen(false);
              router.push('/notifications');
            }}
            className="block w-full px-4 py-2.5 text-center text-xs text-neutral-500 underline underline-offset-2"
          >
            See all
          </button>
        </div>
      )}
    </div>
  );
}
