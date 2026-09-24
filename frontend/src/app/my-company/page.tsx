'use client';

/**
 * "My company" — cpo_admin and operator.
 *
 * Calls `GET /companies/me`, which takes no id at all: the backend resolves the company
 * from the authenticated request. That makes it the safest shape in the product — there is
 * no identifier in the URL for anyone to tamper with.
 *
 * Read-only in Module 2. Editing a company stays super_admin-only for now.
 */

import { useCallback } from 'react';
import Link from 'next/link';

import { RequireAuth } from '@/components/RequireAuth';
import { StatusBadge } from '@/components/StatusBadge';
import { useAsyncData } from '@/hooks/useAsyncData';
import { getMyCompany } from '@/services/company.service';
import { COMPANY_TYPE_LABELS } from '@/types/api';

function MyCompanyContent() {
  const load = useCallback(() => getMyCompany(), []);
  const { state } = useAsyncData(load);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-16">
      <header>
        <p className="text-xs font-medium uppercase tracking-widest text-neutral-500">
          EV-CMS
        </p>
        <h1 className="mt-1 text-2xl font-semibold">My company</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          The company your account belongs to. Your stations, chargers and sessions will all
          be scoped to it.
        </p>
      </header>

      {state.status === 'loading' ? (
        <p className="text-sm text-neutral-500">Loading&hellip;</p>
      ) : state.status === 'error' ? (
        <div className="space-y-2">
          <StatusBadge tone="bad" label={`HTTP ${state.error.status}`} />
          <p className="text-sm font-medium">{state.error.message}</p>
          {state.error.errorCode === 'COMPANY_SUSPENDED' ? (
            <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
              Your sign-in still works — identity is a separate question from company status.
              A platform administrator can reactivate the company.
            </p>
          ) : null}
        </div>
      ) : (
        <section className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={state.data.status === 'active' ? 'good' : 'bad'} label={state.data.status} />
            <StatusBadge tone="neutral" label={state.data.type} />
          </div>

          <h2 className="mt-4 text-lg font-semibold">{state.data.name}</h2>

          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-neutral-500">Legal name</dt>
            <dd>{state.data.legalName ?? '—'}</dd>
            <dt className="text-neutral-500">Type</dt>
            <dd className="text-xs">{COMPANY_TYPE_LABELS[state.data.type]}</dd>
            <dt className="text-neutral-500">Email</dt>
            <dd className="font-mono text-xs">{state.data.contactEmail ?? '—'}</dd>
            <dt className="text-neutral-500">Phone</dt>
            <dd className="font-mono text-xs">{state.data.contactPhone ?? '—'}</dd>
            <dt className="text-neutral-500">Address</dt>
            <dd className="text-xs">
              {state.data.address
                ? [
                    state.data.address.line1,
                    state.data.address.city,
                    state.data.address.state,
                    state.data.address.postalCode,
                    state.data.address.country,
                  ].filter(Boolean).join(', ')
                : '—'}
            </dd>
          </dl>

          <p className="mt-4 text-xs text-neutral-500">
            Read-only. Company details are managed by a platform administrator.
          </p>
        </section>
      )}

      <Link href="/dashboard" className="text-sm text-neutral-500 underline underline-offset-4">
        Back to dashboard
      </Link>
    </main>
  );
}

export default function MyCompanyPage() {
  return (
    <RequireAuth roles={['cpo_admin', 'operator']}>
      <MyCompanyContent />
    </RequireAuth>
  );
}
