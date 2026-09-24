'use client';

/**
 * Station list — super_admin, cpo_admin and operator.
 *
 * All three roles call the same endpoint. What comes back differs entirely because of
 * server-side company scoping: a super_admin gets every station, a cpo_admin or operator
 * gets only their own company's. The frontend does no filtering of its own.
 */

import { useCallback, useState } from 'react';
import Link from 'next/link';

import { RequireAuth } from '@/components/RequireAuth';
import { CompanyFilter, FILTER_SELECT_CLASS } from '@/components/filters';
import { StatusBadge } from '@/components/StatusBadge';
import { useAuth } from '@/context/AuthContext';
import { useAsyncData } from '@/hooks/useAsyncData';
import { listStations } from '@/services/station.service';
import type { Station, StationStatus } from '@/types/api';
import { buttonClasses } from '@/components/ui/Button';

function statusTone(status: StationStatus) {
  if (status === 'active') return 'good' as const;
  if (status === 'suspended') return 'bad' as const;
  return 'neutral' as const;
}

function StationRow({ station }: { station: Station }) {
  return (
    <Link
      href={`/stations/${station.id}`}
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-200 p-4 transition-colors hover:bg-neutral-500/5 dark:border-neutral-800"
    >
      <div className="min-w-0">
        <p className="truncate font-medium">{station.name}</p>
        <p className="mt-0.5 truncate text-xs text-neutral-500">
          <span className="font-mono">{station.stationCode}</span>
          {' · '}
          {station.city}, {station.state}
        </p>
      </div>
      <StatusBadge tone={statusTone(station.status)} label={station.status} />
    </Link>
  );
}

function StationListContent() {
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StationStatus | ''>('');
  const [city, setCity] = useState('');
  const [companyId, setCompanyId] = useState('');

  const load = useCallback(
    () =>
      listStations({
        search: search || undefined,
        status: status || undefined,
        city: city.trim() || undefined,
        companyId: companyId || undefined,
        limit: 50,
      }),
    [search, status, city, companyId],
  );

  const { state } = useAsyncData(load);
  const canCreate = user?.role === 'super_admin' || user?.role === 'cpo_admin';

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-16">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-neutral-500">
            EV-CMS
          </p>
          <h1 className="mt-1 text-2xl font-semibold">Charging stations</h1>
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            {user?.role === 'super_admin'
              ? 'Every site across all companies on the platform.'
              : 'The sites operated by your company.'}
          </p>
        </div>
        {canCreate ? (
          <Link
            href="/stations/new"
            className={buttonClasses('primary', 'md')}
          >
            New station
          </Link>
        ) : null}
      </header>

      <div className="flex flex-wrap gap-3">
        <input
          type="search" placeholder="Search name, code or address…"
          value={search} onChange={(e) => setSearch(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
        />
        <select
          value={status} onChange={(e) => setStatus(e.target.value as StationStatus | '')}
          aria-label="Filter by status"
          className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="suspended">Suspended</option>
        </select>
        <input
          type="search" placeholder="City" aria-label="Filter by city"
          value={city} onChange={(e) => setCity(e.target.value)}
          className={`w-32 ${FILTER_SELECT_CLASS}`}
        />
        <CompanyFilter value={companyId} onChange={setCompanyId} />
      </div>

      {state.status === 'loading' ? (
        <p className="text-sm text-neutral-500">Loading stations&hellip;</p>
      ) : state.status === 'error' ? (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {state.error.message}
        </p>
      ) : state.data.items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No stations match these filters.
        </p>
      ) : (
        <>
          <div className="space-y-2">
            {state.data.items.map((item) => (
              <StationRow key={item.id} station={item} />
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

export default function StationListPage() {
  return (
    <RequireAuth roles={['super_admin', 'cpo_admin', 'operator']}>
      <StationListContent />
    </RequireAuth>
  );
}
