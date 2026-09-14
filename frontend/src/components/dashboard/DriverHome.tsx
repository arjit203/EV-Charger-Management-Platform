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
 * KNOWN CARRYOVER, recorded rather than silently fixed: the capability list below
 * is still written in the future tense about features that now exist ("Find
 * available charging stations (Module 14)"). Correcting that copy means deciding
 * what a driver's home page should actually say, which belongs to a driver-facing
 * pass, not to this one.
 * ============================================================================
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { StatusBadge } from '@/components/StatusBadge';
import { NotificationBell } from '@/components/NotificationBell';
import { useAuth } from '@/context/AuthContext';
import { ROLE_LABELS } from '@/types/api';

/** What each role will be able to reach once later modules land. */
/**
 * What a driver can do. The staff entries that used to live alongside this were unreachable
 * once the component became driver-only, so they are gone — the DRIVER's copy is untouched,
 * including its stale future tense (see the note at the top of this file).
 */
const DRIVER_CAPABILITIES: string[] = [
  'Manage your own vehicles',
  'Find available charging stations (Module 14)',
  'Start and stop your own sessions (Module 7)',
  'Your wallet, payments and charging history (Module 10)',
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

export function DriverHome() {
  const { user, logout } = useAuth();
  const router = useRouter();

  if (!user) return null; // RequireAuth guarantees this, but TypeScript cannot know it

  function handleLogout() {
    logout();
    router.replace('/login');
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-16">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-neutral-500">
            EV-CMS
          </p>
          <h1 className="mt-1 text-2xl font-semibold">Welcome, {user.name}</h1>
        </div>
        <div className="flex items-center gap-2">
          {/* Module 12 — live unread badge, fed by the user room Module 8 already assigns. */}
          <NotificationBell />
          <button
            type="button"
            onClick={handleLogout}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-neutral-500/10 dark:border-neutral-700"
          >
            Sign out
          </button>
        </div>
      </header>

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

          <dt className="text-neutral-500">Role</dt>
          <dd className="font-mono text-xs">{user.role}</dd>

          <dt className="text-neutral-500">Company</dt>
          <dd className="font-mono text-xs">{user.companyId ?? 'none (Module 2)'}</dd>

          <dt className="text-neutral-500">Last login</dt>
          <dd className="font-mono text-xs">
            {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'first session'}
          </dd>
        </dl>

        <p className="mt-4 text-xs text-neutral-500">
          These values came from <code className="font-mono">GET /auth/me</code>, resolved from your
          token by the backend — nothing here is read from local storage.
        </p>
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
        <h2 className="text-sm font-semibold">What this role will be able to do</h2>
        <ul className="mt-3 space-y-1.5 text-sm text-neutral-600 dark:text-neutral-400">
          {DRIVER_CAPABILITIES.map((capability) => (
            <li key={capability} className="flex gap-2">
              <span className="text-neutral-400">&bull;</span>
              {capability}
            </li>
          ))}
        </ul>
      </section>

      <Link href="/" className="text-sm text-neutral-500 underline underline-offset-4">
        System status
      </Link>
    </main>
  );
}
