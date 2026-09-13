'use client';

/**
 * Module 1 dashboard — a placeholder that proves the session works end to end.
 *
 * It shows the user the backend resolved from the token (not anything cached locally),
 * and demonstrates role-aware UI. The real operations dashboard is Module 15; this page
 * grows into it as stations, chargers and sessions arrive.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { RequireAuth } from '@/components/RequireAuth';
import { StatusBadge } from '@/components/StatusBadge';
import { useAuth } from '@/context/AuthContext';
import { ROLE_LABELS, type Role } from '@/types/api';

/** What each role will be able to reach once later modules land. */
const ROLE_CAPABILITIES: Record<Role, string[]> = {
  super_admin: [
    'Manage companies / CPOs (Module 2)',
    'Platform-wide stations, chargers and sessions',
    'All analytics across every company',
  ],
  cpo_admin: [
    'Manage your own company only (Module 2)',
    'Your stations, chargers and operators',
    'Your company revenue and analytics',
  ],
  operator: [
    'Monitor and operate assigned stations (Modules 5–8)',
    'Send OCPP commands to chargers',
    'No company or platform administration',
  ],
  driver: [
    'Find available charging stations (Module 14)',
    'Start and stop your own sessions (Module 7)',
    'Your wallet, payments and charging history (Module 10)',
  ],
};

function DashboardContent() {
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
            EV-CMS &middot; Module 1
          </p>
          <h1 className="mt-1 text-2xl font-semibold">Welcome, {user.name}</h1>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-neutral-500/10 dark:border-neutral-700"
        >
          Sign out
        </button>
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

      <section className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="text-sm font-semibold">What this role will be able to do</h2>
        <ul className="mt-3 space-y-1.5 text-sm text-neutral-600 dark:text-neutral-400">
          {ROLE_CAPABILITIES[user.role].map((capability) => (
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

export default function DashboardPage() {
  return (
    <RequireAuth>
      <DashboardContent />
    </RequireAuth>
  );
}
