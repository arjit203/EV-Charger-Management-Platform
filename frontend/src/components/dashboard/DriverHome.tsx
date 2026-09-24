'use client';

/**
 * The DRIVER's home page — Module 15 moved it here UNCHANGED.
 *
 * ============================================================================
 * THIS IS A VERBATIM EXTRACTION, NOT A REDESIGN.
 *
 * Before Module 15, staff and drivers shared one `/dashboard` page: Module 1's
 * placeholder, with fourteen modules' worth of nav links appended to it. Module 15
 * replaces the STAFF half with a real operations console.
 *
 * The driver half is deliberately NOT restructured. Rebuilding the driver
 * experience is a separate piece of work with its own questions, and quietly
 * doing it under cover of "polish the admin dashboard" is exactly the scope creep
 * this project keeps refusing. So this file is the old rendering, moved.
 *
 * The carryover Module 15 recorded here — a capability list in the future tense
 * with module numbers, a "Company: none (Module 2)" row and a developer note about
 * GET /auth/me — was cleaned up in the leftovers pass. Copy only; the layout is
 * still the Module 15 extraction.
 * ============================================================================
 */

import { useCallback } from 'react';
import Link from 'next/link';

import { useAsyncData } from '@/hooks/useAsyncData';
import { useSocketEvent } from '@/hooks/useSocketEvent';
import { getActiveSession } from '@/services/session.service';
import { describeWhere, formatEnergy } from '@/components/SessionSummary';
import type { ChargingSession } from '@/types/api';

import { StatusBadge } from '@/components/StatusBadge';
import { useAuth } from '@/context/AuthContext';
import { ROLE_LABELS } from '@/types/api';
import { formatDateTime } from '@/lib/datetime';

/** What a driver can do here. */
const DRIVER_CAPABILITIES: string[] = [
  'Find a charging station near you and see which plugs are free',
  'Start and stop your own charging sessions',
  'Top up your wallet and see what each charge cost',
  'Save your vehicles so we only show plugs that fit',
  'Report a problem with a charge',
];

/**
 * Role-aware navigation.
 *
 * A driver simply has no company-management entry point. Note this only hides links —
 * the backend still answers 403 if a driver requests those endpoints directly, which is
 * where the actual enforcement lives.
 */
/** The driver's own navigation, exactly as it was before Module 15. */
const DRIVER_LINKS: { href: string; label: string }[] = [
  { href: '/charge', label: 'Start charging' },
  { href: '/map', label: 'Find a station' },
  { href: '/wallet', label: 'Wallet' },
  { href: '/complaints', label: 'Support' },
  { href: '/notifications', label: 'Notifications' },
  { href: '/sessions', label: 'My charging' },
  { href: '/my-vehicles', label: 'My vehicles' },
  { href: '/profile', label: 'My profile' },
];

/**
 * THE CHARGE IN PROGRESS, first thing on the home screen — every charging app does this, because
 * "is my car still charging?" is the question a driver opens the app to answer. Updates live, and
 * disappears when the charge ends (including when the operator stops it).
 */
function CurrentCharge() {
  const load = useCallback(() => getActiveSession(), []);
  const { state, reload } = useAsyncData(load);

  useSocketEvent<{ session: ChargingSession }>('session:statusChanged', () => {
    void reload();
  });

  if (state.status !== 'ok' || !state.data) return null;
  const active = state.data;

  return (
    <Link
      href={`/sessions/${active.id}`}
      className="block rounded-xl border border-emerald-600/40 bg-emerald-500/10 p-5 transition-colors hover:bg-emerald-500/15"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
        {active.status === 'initiating' ? 'Starting your charge…' : active.status === 'stopping' ? 'Stopping…' : 'Charging now'}
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{formatEnergy(active)}</p>
      <p className="mt-0.5 text-sm text-neutral-600 dark:text-neutral-400">
        {describeWhere(active) || 'Your current session'}
        {active.chargerName ? ` · ${active.chargerName} #${active.connectorNumber}` : ''}
      </p>
      <p className="mt-2 text-xs font-medium text-emerald-700 dark:text-emerald-400">View or stop &rarr;</p>
    </Link>
  );
}

export function DriverHome() {
  const { user } = useAuth();

  if (!user) return null; // RequireAuth guarantees this, but TypeScript cannot know it

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-16">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-neutral-500">
            EV-CMS
          </p>
          <h1 className="mt-1 text-2xl font-semibold">Welcome, {user.name}</h1>
        </div>
        {/* The bell and Sign out live in the shared header now — not repeated here. */}
      </header>

      <CurrentCharge />

      <section className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone="good" label={ROLE_LABELS[user.role]} />
          <StatusBadge
            tone={user.status === 'active' ? 'good' : 'bad'}
            label={`Account: ${user.status}`}
          />
        </div>

        <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-neutral-500">Email</dt>
          <dd className="font-mono text-xs">{user.email}</dd>

          <dt className="text-neutral-500">Phone</dt>
          <dd className="font-mono text-xs">{user.phone ?? '—'}</dd>

          <dt className="text-neutral-500">Last login</dt>
          <dd className="font-mono text-xs">
            {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'first session'}
          </dd>
        </dl>

      </section>

      {DRIVER_LINKS.length > 0 ? (
        <nav className="flex flex-wrap gap-2">
          {DRIVER_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium transition-colors hover:bg-neutral-500/10 dark:border-neutral-800"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      ) : null}

      <section className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="text-sm font-semibold">What you can do</h2>
        <ul className="mt-3 space-y-1.5 text-sm text-neutral-600 dark:text-neutral-400">
          {DRIVER_CAPABILITIES.map((capability) => (
            <li key={capability} className="flex gap-2">
              <span className="text-neutral-400">&bull;</span>
              {capability}
            </li>
          ))}
        </ul>
      </section>

    </main>
  );
}
