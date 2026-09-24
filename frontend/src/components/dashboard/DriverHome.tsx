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

import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { StatusBadge } from '@/components/StatusBadge';
import { NotificationBell } from '@/components/NotificationBell';
import { useAuth } from '@/context/AuthContext';
import { ROLE_LABELS } from '@/types/api';
import { buttonClasses } from '@/components/ui/Button';

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
            className={buttonClasses('secondary')}
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

          <dt className="text-neutral-500">Last login</dt>
          <dd className="font-mono text-xs">
            {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'first session'}
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

      <Link href="/" className="text-sm text-neutral-500 underline underline-offset-4">
        System status
      </Link>
    </main>
  );
}
