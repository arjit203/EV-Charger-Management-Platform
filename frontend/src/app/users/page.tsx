'use client';

/**
 * User list — super_admin and cpo_admin.
 *
 * What each sees is decided entirely by the server: super_admin gets everyone, cpo_admin
 * gets only their own company's STAFF. A cpo_admin will never see a driver here — drivers
 * have no company, so a company-scoped query structurally cannot match one. That is by
 * design, not a missing filter.
 */

import { useCallback, useState } from 'react';
import Link from 'next/link';

import { RequireAuth } from '@/components/RequireAuth';
import { CompanyFilter } from '@/components/filters';
import { StatusBadge } from '@/components/StatusBadge';
import { useAuth } from '@/context/AuthContext';
import { useAsyncData } from '@/hooks/useAsyncData';
import { listUsers } from '@/services/user.service';
import { ROLE_LABELS, type Role, type User, type UserStatus } from '@/types/api';
import { buttonClasses } from '@/components/ui/Button';
import { Pager, usePage } from '@/components/Pager';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';

function UserRow({ user }: { user: User }) {
  return (
    <Link
      href={`/users/${user.id}`}
      className="list-row"
    >
      <div className="min-w-0">
        <p className="truncate font-medium">{user.name}</p>
        <p className="mt-0.5 truncate text-xs text-neutral-500">
          {user.email}
          {user.phone ? ` · ${user.phone}` : ''}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone="neutral" label={ROLE_LABELS[user.role]} />
        <StatusBadge tone={user.status === 'active' ? 'good' : 'bad'} label={user.status} />
      </div>
    </Link>
  );
}

function UserListContent() {
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const query = useDebouncedValue(search.trim());
  const [role, setRole] = useState<Role | ''>('');
  const [status, setStatus] = useState<UserStatus | ''>('');
  const [companyId, setCompanyId] = useState('');

  // Filters change -> back to page 1 (see usePage).
  const [page, setPage] = usePage(JSON.stringify([query, role, status, companyId]));

  const load = useCallback(
    () =>
      listUsers({
        page,
        search: query || undefined,
        role: role || undefined,
        status: status || undefined,
        companyId: companyId || undefined,
        limit: 50,
      }),
    [query, role, status, companyId, page],
  );

  const { state } = useAsyncData(load);
  const isPlatformAdmin = user?.role === 'super_admin';

  return (
    <main className="page">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            {isPlatformAdmin
              ? 'Everyone on the platform, including EV drivers.'
              : 'Staff accounts belonging to your company.'}
          </p>
        </div>
        <Link
          href="/users/new"
          className={buttonClasses('primary', 'md')}
        >
          Add staff
        </Link>
      </header>

      <div className="flex flex-wrap gap-3">
        <input
          type="search" placeholder="Search name, email or phone…"
          value={search} onChange={(e) => setSearch(e.target.value)}
          className="min-w-[min(100%,20rem)] flex-1 rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
        />
        <select
          value={role} onChange={(e) => setRole(e.target.value as Role | '')} aria-label="Filter by role"
          className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
        >
          <option value="">All roles</option>
          <option value="cpo_admin">CPO Admin</option>
          <option value="operator">Operator</option>
          {isPlatformAdmin ? <option value="driver">Driver</option> : null}
          {isPlatformAdmin ? <option value="super_admin">Platform Admin</option> : null}
        </select>
        <select
          value={status} onChange={(e) => setStatus(e.target.value as UserStatus | '')} aria-label="Filter by status"
          className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </select>
        <CompanyFilter value={companyId} onChange={setCompanyId} />
      </div>

      {state.status === 'loading' ? (
        <p className="text-sm text-neutral-500">Loading users&hellip;</p>
      ) : state.status === 'error' ? (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {state.error.message}
        </p>
      ) : state.data.items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No users match these filters.
        </p>
      ) : (
        <>
          <div className="space-y-2">
            {state.data.items.map((item) => (
              <UserRow key={item.id} user={item} />
            ))}
          </div>
          <Pager
            page={state.data.page}
            totalPages={state.data.totalPages}
            total={state.data.total}
            shown={state.data.items.length}
            onPage={setPage}
          />
        </>
      )}

    </main>
  );
}

export default function UserListPage() {
  return (
    <RequireAuth roles={['super_admin', 'cpo_admin']}>
      <UserListContent />
    </RequireAuth>
  );
}
