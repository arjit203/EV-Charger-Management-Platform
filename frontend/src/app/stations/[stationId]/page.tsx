'use client';

/**
 * Station detail.
 *
 * Deliberately shows no charger or connector information — that is Module 5. The status
 * controls reflect the backend's permission split: a cpo_admin can move a station between
 * active and inactive, but only a super_admin can apply or clear `suspended`.
 */

import { useCallback, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

import { RequireAuth } from '@/components/RequireAuth';
import { StationForm } from '@/components/StationForm';
import { StatusBadge } from '@/components/StatusBadge';
import { useAuth } from '@/context/AuthContext';
import { useAsyncData } from '@/hooks/useAsyncData';
import { toMessage } from '@/lib/formatApiError';
import {
  getStation,
  setStationStatus,
  updateStation,
  type StationInput,
} from '@/services/station.service';
import { STATION_STATUS_LABELS, type Station, type StationStatus } from '@/types/api';

function statusTone(status: StationStatus) {
  if (status === 'active') return 'good' as const;
  if (status === 'suspended') return 'bad' as const;
  return 'neutral' as const;
}

function StationDetails({
  station,
  onChanged,
}: {
  station: Station;
  onChanged: (station: Station) => void;
}) {
  const { user } = useAuth();
  const [isEditing, setIsEditing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const isPlatformAdmin = user?.role === 'super_admin';
  const canManage = isPlatformAdmin || user?.role === 'cpo_admin';
  // A platform suspension can only be cleared by a platform admin — the API enforces this too.
  const isLockedByPlatform = station.status === 'suspended' && !isPlatformAdmin;

  async function changeStatus(next: StationStatus) {
    setIsBusy(true);
    setActionError(null);
    try {
      onChanged(await setStationStatus(station.id, next));
    } catch (caught) {
      setActionError(toMessage(caught));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleUpdate(input: StationInput) {
    onChanged(await updateStation(station.id, input));
    setIsEditing(false);
  }

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-widest text-neutral-500">
            EV-CMS &middot; Station
          </p>
          <h1 className="mt-1 truncate text-2xl font-semibold">{station.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge tone={statusTone(station.status)} label={station.status} />
            <StatusBadge tone="neutral" label={station.stationCode} />
          </div>
        </div>

        {canManage && !isLockedByPlatform ? (
          <div className="flex flex-wrap gap-2">
            {!isEditing ? (
              <button type="button" onClick={() => setIsEditing(true)}
                className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-neutral-500/10 dark:border-neutral-700">
                Edit
              </button>
            ) : null}

            {station.status === 'active' ? (
              <button type="button" onClick={() => void changeStatus('inactive')} disabled={isBusy}
                className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50">
                {isBusy ? 'Working…' : 'Set inactive'}
              </button>
            ) : (
              <button type="button" onClick={() => void changeStatus('active')} disabled={isBusy}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50">
                {isBusy ? 'Working…' : 'Set active'}
              </button>
            )}

            {/* Suspension is a platform sanction — only offered to super_admin. */}
            {isPlatformAdmin ? (
              station.status === 'suspended' ? (
                <button type="button" onClick={() => void changeStatus('active')} disabled={isBusy}
                  className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium dark:border-neutral-700">
                  Lift suspension
                </button>
              ) : (
                <button type="button" onClick={() => void changeStatus('suspended')} disabled={isBusy}
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50">
                  Suspend
                </button>
              )
            ) : null}
          </div>
        ) : null}
      </header>

      {actionError ? (
        <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {actionError}
        </p>
      ) : null}

      {isLockedByPlatform ? (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">
          This station was suspended by a platform administrator. Only they can lift it.
        </p>
      ) : null}

      {station.status === 'inactive' ? (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          Temporarily out of service. This is your company&apos;s own switch — set it active again
          when the site reopens.
        </p>
      ) : null}

      <section className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
        {isEditing ? (
          <StationForm
            initial={station}
            submitLabel="Save changes"
            showCompanySelector={isPlatformAdmin}
            onSubmit={handleUpdate}
            onCancel={() => setIsEditing(false)}
          />
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-neutral-500">Status</dt>
            <dd className="text-xs">{STATION_STATUS_LABELS[station.status]}</dd>

            <dt className="text-neutral-500">Station code</dt>
            <dd className="font-mono text-xs">{station.stationCode}</dd>

            <dt className="text-neutral-500">Address</dt>
            <dd className="text-xs">
              {[station.address, station.city, station.state, station.postalCode, station.country]
                .filter(Boolean)
                .join(', ')}
            </dd>

            <dt className="text-neutral-500">Coordinates</dt>
            <dd className="font-mono text-xs">
              {station.latitude}, {station.longitude}
            </dd>

            <dt className="text-neutral-500">Opening hours</dt>
            <dd className="text-xs">{station.openingHours ?? '—'}</dd>

            <dt className="text-neutral-500">Site contact</dt>
            <dd className="font-mono text-xs">{station.contactPhone ?? '—'}</dd>

            <dt className="text-neutral-500">Company</dt>
            <dd className="font-mono text-xs">{station.companyId}</dd>

            <dt className="text-neutral-500">Created</dt>
            <dd className="text-xs">{new Date(station.createdAt).toLocaleString()}</dd>
          </dl>
        )}
      </section>

      <p className="text-xs text-neutral-500">
        Chargers and connectors for this station arrive in Module 5.
      </p>
    </>
  );
}

function StationDetailContent() {
  const params = useParams<{ stationId: string }>();
  const router = useRouter();
  const stationId = params.stationId;

  const load = useCallback(() => getStation(stationId), [stationId]);
  const { state, setData } = useAsyncData(load);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-16">
      {state.status === 'loading' ? (
        <p className="text-sm text-neutral-500">Loading station&hellip;</p>
      ) : state.status === 'error' ? (
        <div className="space-y-3">
          <StatusBadge tone="bad" label={`HTTP ${state.error.status}`} />
          <p className="text-sm font-medium">{state.error.message}</p>
          <p className="text-xs text-neutral-500">
            A 403 here is the company scoping working: stations belonging to another company are
            not reachable, whatever id is put in the URL.
          </p>
          <button type="button" onClick={() => router.back()}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium dark:border-neutral-700">
            Go back
          </button>
        </div>
      ) : (
        <StationDetails station={state.data} onChanged={setData} />
      )}

      <Link href="/stations" className="text-sm text-neutral-500 underline underline-offset-4">
        Back to stations
      </Link>
    </main>
  );
}

export default function StationDetailPage() {
  return (
    <RequireAuth roles={['super_admin', 'cpo_admin', 'operator']}>
      <StationDetailContent />
    </RequireAuth>
  );
}
