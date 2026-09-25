'use client';

/**
 * Tariff detail — view, edit, activate/deactivate.
 *
 * The screen says plainly what activating does, because the consequence is not obvious from a
 * toggle: it takes the current tariff out of force and changes what every future charge costs.
 * Sessions already running are unaffected — they snapshotted their rate when they started.
 */

import { useCallback, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

import { RequireAuth } from '@/components/RequireAuth';
import { StatusBadge } from '@/components/StatusBadge';
import { TariffForm } from '@/components/TariffForm';
import { useAuth } from '@/context/AuthContext';
import { useAsyncData } from '@/hooks/useAsyncData';
import { formatRate } from '@/lib/money';
import { toMessage } from '@/lib/formatApiError';
import { getTariff, setTariffStatus, updateTariff } from '@/services/tariff.service';
import type { Tariff } from '@/types/api';
import { formatDateTime } from '@/lib/datetime';
import { LoadError } from '@/components/ui/LoadError';

function TariffDetail({
  tariff,
  onChanged,
}: {
  tariff: Tariff;
  onChanged: (tariff: Tariff) => void;
}) {
  const { user } = useAuth();
  const canManage = user?.role === 'super_admin' || user?.role === 'cpo_admin';

  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const isActive = tariff.status === 'active';

  async function toggleStatus() {
    setIsBusy(true);
    setError(null);
    try {
      onChanged(await setTariffStatus(tariff.id, isActive ? 'inactive' : 'active'));
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setIsBusy(false);
    }
  }

  if (isEditing) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Edit tariff</h2>
        <TariffForm
          initial={tariff}
          submitLabel="Save changes"
          onCancel={() => setIsEditing(false)}
          onSubmit={async (input) => {
            onChanged(await updateTariff(tariff.id, input));
            setIsEditing(false);
          }}
        />
        {isActive && (
          <p className="rounded-lg bg-neutral-500/10 p-3 text-xs text-neutral-600 dark:text-neutral-400">
            This tariff is in force. Changing the rate affects charges started from now on —
            sessions already running keep the rate they started at.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{tariff.name}</h1>
          <p className="mt-1 text-3xl font-semibold tabular-nums">
            {formatRate(tariff.pricePerKwhPaise)}
          </p>
        </div>
        <StatusBadge
          tone={isActive ? 'good' : 'neutral'}
          label={isActive ? 'in force' : 'inactive'}
        />
      </div>

      <dl className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <dt className="text-xs text-neutral-500">Stored as</dt>
          <dd className="mt-0.5 font-mono tabular-nums">{tariff.pricePerKwhPaise} paise / kWh</dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-500">Last updated</dt>
          <dd className="mt-0.5">{formatDateTime(tariff.updatedAt)}</dd>
        </div>
      </dl>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {canManage && (
        <div className="flex flex-wrap gap-3 border-t border-neutral-200 pt-5 dark:border-neutral-800">
          <button
            type="button"
            onClick={() => setIsEditing(true)}
            className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium transition-colors hover:bg-neutral-500/10 dark:border-neutral-700"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => void toggleStatus()}
            disabled={isBusy}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-60 ${
              isActive ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'
            }`}
          >
            {isBusy ? 'Saving…' : isActive ? 'Deactivate' : 'Make this the active tariff'}
          </button>
        </div>
      )}

      {canManage && (
        <p className="text-xs text-neutral-500">
          {isActive
            ? 'Deactivating leaves your company with no price, and drivers will not be able to start a charge until another tariff is activated.'
            : 'Activating this replaces whichever tariff is currently in force. Only one can be active at a time.'}
        </p>
      )}
    </div>
  );
}

function TariffDetailContent() {
  const params = useParams<{ tariffId: string }>();
  const router = useRouter();
  const tariffId = params.tariffId;

  const load = useCallback(() => getTariff(tariffId), [tariffId]);
  const { state, setData } = useAsyncData(load);

  return (
    <main className="page page-detail page-flow">
      {state.status === 'loading' && <p className="text-sm text-neutral-500">Loading…</p>}

      {state.status === 'error' && (
        <LoadError error={state.error} noun="tariff" backHref="/tariffs" backLabel="Back to tariffs" />
      )}

      {state.status === 'ok' && <TariffDetail tariff={state.data} onChanged={setData} />}

      <button
        type="button"
        onClick={() => router.push('/tariffs')}
        className="mt-10 text-sm text-neutral-500 underline underline-offset-4"
      >
        All tariffs
      </button>
      <Link href="/dashboard" className="sr-only">
        Dashboard
      </Link>
    </main>
  );
}

export default function TariffDetailPage() {
  return (
    <RequireAuth roles={['super_admin', 'cpo_admin', 'operator']}>
      <TariffDetailContent />
    </RequireAuth>
  );
}
