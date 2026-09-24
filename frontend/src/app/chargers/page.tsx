'use client';

/**
 * Charger list — super_admin, cpo_admin and operator.
 *
 * All three call the same endpoint; what comes back differs because the charger carries a
 * denormalised `companyId` that the server scopes on. The frontend filters nothing itself.
 */

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

import { RequireAuth } from '@/components/RequireAuth';
import { CompanyFilter, FILTER_SELECT_CLASS, PlugTypeFilter, PowerTypeFilter } from '@/components/filters';
import { StatusBadge } from '@/components/StatusBadge';
import { useAuth } from '@/context/AuthContext';
import { useAsyncData } from '@/hooks/useAsyncData';
import { listChargers } from '@/services/charger.service';
import type { Charger, ChargerStatus, ChargerType, ConnectorType } from '@/types/api';
import { buttonClasses } from '@/components/ui/Button';
import { Pager, usePage } from '@/components/Pager';

export function chargerStatusTone(status: ChargerStatus) {
  if (status === 'available') return 'good' as const;
  if (status === 'faulted') return 'bad' as const;
  return 'neutral' as const;
}

function ChargerRow({ charger }: { charger: Charger }) {
  return (
    <Link
      href={`/chargers/${charger.id}`}
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-200 p-4 transition-colors hover:bg-neutral-500/5 dark:border-neutral-800"
    >
      <div className="min-w-0">
        <p className="truncate font-medium">{charger.name}</p>
        <p className="mt-0.5 truncate text-xs text-neutral-500">
          <span className="font-mono">{charger.chargerCode}</span>
          {' · '}
          {charger.chargerType} {charger.powerKw} kW
          {' · '}
          {charger.manufacturer} {charger.model}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {/*
          The machine's own report comes FIRST, and only when it is bad. A charger that has
          announced a fault about itself is the single most important thing in this row — more
          than the admin status beside it, which may still say "available" and be quite wrong.
        */}
        {charger.hardwareStatus !== 'operative' && (
          <StatusBadge
            tone="bad"
            label={charger.hardwareStatus === 'faulted' ? 'hardware fault' : 'self-disabled'}
          />
        )}
        <StatusBadge tone={charger.isOnline ? 'good' : 'neutral'} label={charger.isOnline ? 'online' : 'offline'} />
        <StatusBadge tone={chargerStatusTone(charger.status)} label={charger.status} />
      </div>
    </Link>
  );
}

function ChargerListContent() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const stationId = searchParams.get('stationId') ?? undefined;

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ChargerStatus | ''>('');
  const [chargerType, setChargerType] = useState<ChargerType | ''>('');
  const [connectorType, setConnectorType] = useState<ConnectorType | ''>('');
  const [connectivity, setConnectivity] = useState<'' | 'online' | 'offline'>('');
  const [companyId, setCompanyId] = useState('');

  // Filters change -> back to page 1 (see usePage).
  const [page, setPage] = usePage(JSON.stringify([search, status, chargerType, connectorType, connectivity, companyId, stationId]));

  const load = useCallback(
    () =>
      listChargers({
        page,
        search: search || undefined,
        status: status || undefined,
        chargerType: chargerType || undefined,
        connectorType: connectorType || undefined,
        isOnline: connectivity ? connectivity === 'online' : undefined,
        companyId: companyId || undefined,
        stationId,
        limit: 50,
      }),
    [search, status, chargerType, connectorType, connectivity, companyId, stationId, page],
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
          <h1 className="mt-1 text-2xl font-semibold">Chargers</h1>
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            {stationId
              ? 'Hardware installed at the selected station.'
              : user?.role === 'super_admin'
                ? 'Every charger across all companies.'
                : 'Hardware installed at your company’s sites.'}
          </p>
        </div>
        {canCreate ? (
          <Link
            href={stationId ? `/chargers/new?stationId=${stationId}` : '/chargers/new'}
            className={buttonClasses('primary', 'md')}
          >
            Add charger
          </Link>
        ) : null}
      </header>

      <div className="flex flex-wrap gap-3">
        <input
          type="search" placeholder="Search name, code, OCPP id, model, station or city…"
          value={search} onChange={(e) => setSearch(e.target.value)}
          className="min-w-[min(100%,20rem)] flex-1 rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
        />
        <CompanyFilter value={companyId} onChange={setCompanyId} />
        <PowerTypeFilter value={chargerType} onChange={setChargerType} />
        <PlugTypeFilter value={connectorType} onChange={setConnectorType} />
        <select
          value={connectivity}
          onChange={(e) => setConnectivity(e.target.value as '' | 'online' | 'offline')}
          aria-label="Filter by connectivity"
          className={FILTER_SELECT_CLASS}
        >
          <option value="">Online &amp; offline</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
        </select>
        <select
          value={status} onChange={(e) => setStatus(e.target.value as ChargerStatus | '')}
          aria-label="Filter by status"
          className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
        >
          <option value="">All statuses</option>
          <option value="available">Available</option>
          <option value="unavailable">Unavailable</option>
          <option value="faulted">Faulted</option>
          <option value="maintenance">Maintenance</option>
        </select>
      </div>

      {state.status === 'loading' ? (
        <p className="text-sm text-neutral-500">Loading chargers&hellip;</p>
      ) : state.status === 'error' ? (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {state.error.message}
        </p>
      ) : state.data.items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No chargers match these filters.
        </p>
      ) : (
        <>
          <div className="space-y-2">
            {state.data.items.map((item) => (
              <ChargerRow key={item.id} charger={item} />
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

export default function ChargerListPage() {
  return (
    <RequireAuth roles={['super_admin', 'cpo_admin', 'operator']}>
      <ChargerListContent />
    </RequireAuth>
  );
}
