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

export function Sidebar({ role, pathname }: { role: Role; pathname: string }) {
  const groups = navigationFor(role);

  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-1 p-3">
      <div className="mb-3 px-3 py-2">
        <p className="text-sm font-semibold tracking-tight">EV-CMS</p>
        <p className="text-[11px] text-neutral-500">{ROLE_LABELS[role]}</p>
      </div>

      {groups.map((group) => (
        <div key={group.title ?? 'root'} className="mb-2">
          {group.title && (
            <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-widest text-neutral-400">
              {group.title}
            </p>
          )}

          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active = isActivePath(pathname, item.href);

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={`block rounded-lg px-3 py-2 text-sm transition-colors ${
                      active
                        ? 'bg-emerald-500/10 font-medium text-emerald-700 dark:text-emerald-400'
                        : 'text-neutral-600 hover:bg-neutral-500/10 dark:text-neutral-300'
                    }`}
                  >
                    {item.label}
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
