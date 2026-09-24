'use client';

/**
 * Company list — super_admin only.
 *
 * This is the single genuinely unscoped read in the product. The backend answers 403 to
 * every other role, so the `roles` prop on RequireAuth below is a UX convenience that
 * saves a wasted request, not the thing that protects the data.
 */

import { useCallback, useState } from 'react';
import Link from 'next/link';

import { RequireAuth } from '@/components/RequireAuth';
import { FILTER_SELECT_CLASS } from '@/components/filters';
import { StatusBadge } from '@/components/StatusBadge';
import { useAsyncData } from '@/hooks/useAsyncData';
import { listCompanies } from '@/services/company.service';
import { COMPANY_TYPE_LABELS, type Company, type CompanyStatus, type CompanyType } from '@/types/api';
import { buttonClasses } from '@/components/ui/Button';

function CompanyRow({ company }: { company: Company }) {
  return (
    <Link
      href={`/companies/${company.id}`}
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-200 p-4 transition-colors hover:bg-neutral-500/5 dark:border-neutral-800"
    >
      <div className="min-w-0">
        <p className="truncate font-medium">{company.name}</p>
        <p className="mt-0.5 truncate text-xs text-neutral-500">
          {company.type}
          {company.address?.city ? ` · ${company.address.city}` : ''}
          {company.contactEmail ? ` · ${company.contactEmail}` : ''}
        </p>
      </div>
      <StatusBadge tone={company.status === 'active' ? 'good' : 'bad'} label={company.status} />
    </Link>
  );
}

function CompanyListContent() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<CompanyStatus | ''>('');
  const [type, setType] = useState<CompanyType | ''>('');

  const load = useCallback(
    () =>
      listCompanies({
        search: search || undefined,
        status: status || undefined,
        type: type || undefined,
        limit: 50,
      }),
    [search, status, type],
  );

  const { state } = useAsyncData(load);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-16">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-neutral-500">
            EV-CMS
          </p>
          <h1 className="mt-1 text-2xl font-semibold">Companies</h1>
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            Charge point operators on the platform.
          </p>
        </div>
        <Link
          href="/companies/new"
          className={buttonClasses('primary', 'md')}
        >
          New company
        </Link>
      </header>

      <div className="flex flex-wrap gap-3">
        <input
          type="search"
          placeholder="Search by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as CompanyStatus | '')}
          aria-label="Filter by status"
          className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </select>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as CompanyType | '')}
          aria-label="Filter by company type"
          className={FILTER_SELECT_CLASS}
        >
          <option value="">All types</option>
          {(Object.keys(COMPANY_TYPE_LABELS) as CompanyType[]).map((t) => (
            <option key={t} value={t}>
              {COMPANY_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </div>

      {state.status === 'loading' ? (
        <p className="text-sm text-neutral-500">Loading companies&hellip;</p>
      ) : state.status === 'error' ? (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {state.error.message}
        </p>
      ) : state.data.items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No companies match. Create one to get started.
        </p>
      ) : (
        <>
          <div className="space-y-2">
            {state.data.items.map((company) => (
              <CompanyRow key={company.id} company={company} />
            ))}
          </div>
          <p className="text-xs text-neutral-500">
            Showing {state.data.items.length} of {state.data.total}
          </p>
        </>
      )}

      <Link href="/dashboard" className="text-sm text-neutral-500 underline underline-offset-4">
        Back to dashboard
      </Link>
    </main>
  );
}

export default function CompanyListPage() {
  return (
    <RequireAuth roles={['super_admin']}>
      <CompanyListContent />
    </RequireAuth>
  );
}
