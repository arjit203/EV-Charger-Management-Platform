'use client';

/**
 * The topbar: where you are, who you are, what is unread, and the way out.
 *
 * `NotificationBell` is Module 12's component, moved here unchanged. It was previously
 * rendered inside the dashboard page, which meant the unread badge disappeared the moment you
 * navigated anywhere else. Mounting it in the shell is the whole reason it is now always
 * visible — no new notification code, just a better home for the existing one.
 */

import { useRouter } from 'next/navigation';

import { NotificationBell } from '@/components/NotificationBell';
import { useAuth } from '@/context/AuthContext';
import { useSocket } from '@/context/SocketContext';
import { ROLE_LABELS, type User } from '@/types/api';
import { sectionForPath, titleForPath } from './navigation';
import { IconMenu } from './icons';
import { Button } from '@/components/ui/Button';

export function Topbar({
  user,
  pathname,
  onOpenNav,
}: {
  user: User;
  pathname: string;
  onOpenNav: () => void;
}) {
  const { logout } = useAuth();
  const { isConnected } = useSocket();
  const router = useRouter();

  const section = sectionForPath(pathname, user.role);

  function handleLogout() {
    logout();
    router.replace('/login');
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-[var(--border)] bg-[var(--background)]/85 px-4 backdrop-blur sm:px-8">
      {/* Drawer trigger — phone and tablet only. */}
      <button
        type="button"
        onClick={onOpenNav}
        aria-label="Open navigation"
        className="rounded-lg border border-neutral-300 p-2 text-neutral-600 transition-colors hover:bg-neutral-500/10 lg:hidden dark:border-neutral-700 dark:text-neutral-300"
      >
        <IconMenu className="h-4 w-4" />
      </button>

      {/* A breadcrumb, not a second title: the page's own heading is the title. */}
      <p className="flex min-w-0 items-center gap-1.5 truncate text-[13px]">
        {section && (
          <>
            <span className="hidden text-neutral-500 sm:inline">{section}</span>
            <span className="hidden text-neutral-600 sm:inline" aria-hidden>/</span>
          </>
        )}
        <span className="truncate font-medium text-neutral-200">{titleForPath(pathname, user.role)}</span>
      </p>

      <div className="ml-auto flex items-center gap-2 sm:gap-3">
        {/*
          * Live/offline refers to THIS BROWSER's Socket.IO connection — whether the page will
          * receive push updates. It is deliberately not a claim about any charger: charger
          * connectivity is a different thing entirely, and conflating the two would be the
          * kind of misleading status badge this project keeps refusing to ship.
          */}
        <span
          title={isConnected ? 'Receiving live updates' : 'Not receiving live updates'}
          className="hidden items-center gap-1.5 text-[11px] text-neutral-500 sm:inline-flex"
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-neutral-400'}`}
          />
          {isConnected ? 'Live' : 'Offline'}
        </span>

        <NotificationBell />

        <div className="hidden text-right sm:block">
          <p className="max-w-[12rem] truncate text-xs font-medium">{user.name}</p>
          <p className="text-[11px] text-neutral-500">{ROLE_LABELS[user.role]}</p>
        </div>

        <Button variant="secondary" onClick={handleLogout}>
          Sign out
        </Button>
      </div>
    </header>
  );
}
