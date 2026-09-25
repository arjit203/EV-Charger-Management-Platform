'use client';

/**
 * Tariff list.
 *
 * The active tariff is the whole point of this screen, so it is called out rather than left as
 * one badge among many — "what are we charging right now?" is the question an operator actually
 * opens this page to answer.
 */

import { useCallback, useState } from 'react';
import Link from 'next/link';

import { RequireAuth } from '@/components/RequireAuth';
import { CompanyFilter } from '@/components/filters';
import { StatusBadge } from '@/components/StatusBadge';
import { useAuth } from '@/context/AuthContext';
import { useAsyncData } from '@/hooks/useAsyncData';
import { formatRate } from '@/lib/money';
import { toMessage } from '@/lib/formatApiError';
import { listTariffs } from '@/services/tariff.service';
import type { Tariff, TariffStatus } from '@/types/api';
import { Pager, usePage } from '@/components/Pager';

function TariffRow({ tariff }: { tariff: Tariff }) {
  return (
    <Link
      href={`/tariffs/${tariff.id}`}
      className="list-row"
    >
      <div className="min-w-0">
        <p className="truncate font-medium">{tariff.name}</p>
        <p className="mt-0.5 truncate text-xs text-neutral-500 tabular-nums">
          {formatRate(tariff.pricePerKwhPaise)}
        </p>
      </div>
      <StatusBadge
        tone={tariff.status === 'active' ? 'good' : 'neutral'}
        label={tariff.status === 'active' ? 'in force' : 'inactive'}
      />
    </Link>
  );
}

function TariffListContent() {
  const { user } = useAuth();
  const canManage = user?.role === 'super_admin' || user?.role === 'cpo_admin';

  const [status, setStatus] = useState<TariffStatus | ''>('');
  const [companyId, setCompanyId] = useState('');
  const isPlatformAdmin = user?.role === 'super_admin';

  // Filters change -> back to page 1 (see usePage).
  const [page, setPage] = usePage(JSON.stringify([status, companyId]));

  const load = useCallback(
    () =>
      listTariffs({
        page,
        limit: 50,
        ...(status ? { status } : {}),
        ...(companyId ? { companyId } : {}),
      }),
    [status, companyId, page],
  );

  const { state } = useAsyncData(load);

  const active =
    state.status === 'ok' ? state.data.items.find((t) => t.status === 'active') : undefined;

  return (
    <main className="page page-flow">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tariffs</h1>
          <p className="mt-1 text-sm text-neutral-500">
            What drivers pay to charge at your stations.
          </p>
        </div>
        {canManage && (
          <Link
            href="/tariffs/new"
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-hover)]"
          >
            New tariff
          </Link>
        )}
      </div>

      {state.status === 'ok' && (!isPlatformAdmin || companyId) && (
        <div className="mt-6 rounded-2xl border border-neutral-200 p-6 dark:border-neutral-800">
          <p className="text-xs uppercase tracking-wide text-neutral-500">Currently charging</p>
          {active ? (
            <>
              <p className="mt-1 text-3xl font-semibold tabular-nums">
                {formatRate(active.pricePerKwhPaise)}
              </p>
              <p className="mt-1 text-sm text-neutral-500">{active.name}</p>
            </>
          ) : (
            <p className="mt-2 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
              No active tariff. Drivers cannot start a charge at your stations until one is
              activated.
            </p>
          )}
        </div>
      )}

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as TariffStatus | '')}
          className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
        >
          <option value="">All tariffs</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        <CompanyFilter value={companyId} onChange={setCompanyId} />
      </div>

      <div className="mt-4 space-y-3">
        {state.status === 'loading' && <p className="text-sm text-neutral-500">Loading…</p>}

        {state.status === 'error' && (
          <p className="rounded-lg bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-400">
            {toMessage(state.error)}
          </p>
        )}

        {state.status === 'ok' && state.data.items.length === 0 && (
          <p className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
            No tariffs yet.
          </p>
        )}

        {state.status === 'ok' &&
          state.data.items.map((tariff) => <TariffRow key={tariff.id} tariff={tariff} />)}

        {state.status === 'ok' && (
          <Pager
              page={state.data.page}
              totalPages={state.data.totalPages}
              total={state.data.total}
              shown={state.data.items.length}
              onPage={setPage}
            />
        )}
      </div>
    </main>
  );
}

export default function TariffsPage() {
  return (
    <RequireAuth roles={['super_admin', 'cpo_admin', 'operator']}>
      <TariffListContent />
    </RequireAuth>
  );
}
