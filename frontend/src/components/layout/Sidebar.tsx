'use client';

/**
 * The navigation rail. Presentation only — the grouping and role filtering live in
 * `navigation.ts`, and the actual authorisation lives on the server.
 *
 * Shared by the desktop rail and the mobile drawer, so the two can never drift apart.
 */

import Link from 'next/link';

import { ROLE_LABELS, type Role } from '@/types/api';
import { isActivePath, navigationFor } from './navigation';
import { NAV_ICONS } from './icons';

export function Sidebar({ role, pathname }: { role: Role; pathname: string }) {
  const groups = navigationFor(role);

  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-1 p-3">
      <div className="mb-4 flex items-center gap-2.5 px-3 py-2">
        {/* A square mark, not a logo. Anchors the rail without inventing branding. */}
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--accent)] text-[13px] font-bold text-[var(--accent-contrast)]">
          EV
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold tracking-tight">EV-CMS</span>
          <span className="block truncate text-[11px] text-neutral-500">{ROLE_LABELS[role]}</span>
        </span>
      </div>

      {groups.map((group) => (
        <div key={group.title ?? 'root'} className="mb-2">
          {group.title && (
            <p className="px-3 pb-1.5 pt-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-neutral-400">
              {group.title}
            </p>
          )}

          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active = isActivePath(pathname, item.href);
              const Icon = NAV_ICONS[item.href];

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                      active
                        ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent)]'
                        : 'text-neutral-600 hover:bg-neutral-500/10 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100'
                    }`}
                  >
                    {Icon && <Icon className="h-4 w-4" />}
                    <span className="truncate">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {/*
        * Said in the UI as well as in the code, because it is the single most misunderstood
        * thing about an admin interface: this rail is convenience, not a permission boundary.
        */}
      <p className="mt-auto px-3 pb-2 pt-6 text-[10px] leading-relaxed text-neutral-400">
        Menu reflects your role. Access is enforced by the API, not by this menu.
      </p>
    </nav>
  );
}
