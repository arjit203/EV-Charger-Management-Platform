'use client';

/**
 * My vehicles — driver only.
 *
 * Every call here hits `/users/me/vehicles`, which carries no owner id. The server takes
 * ownership from the authenticated request, so there is no id in any URL for a driver to
 * change in order to reach someone else's car.
 */

import { useCallback, useState } from 'react';
import Link from 'next/link';

import { RequireAuth } from '@/components/RequireAuth';
import { StatusBadge } from '@/components/StatusBadge';
import { VehicleForm } from '@/components/VehicleForm';
import { useAsyncData } from '@/hooks/useAsyncData';
import { toMessage } from '@/lib/formatApiError';
import {
  createMyVehicle,
  deactivateMyVehicle,
  listMyVehicles,
  updateMyVehicle,
  type VehicleInput,
} from '@/services/vehicle.service';
import { CONNECTOR_LABELS, type Vehicle } from '@/types/api';
import { buttonClasses } from '@/components/ui/Button';

function VehicleCard({
  vehicle,
  onChanged,
}: {
  vehicle: Vehicle;
  onChanged: () => Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  async function handleUpdate(input: VehicleInput) {
    await updateMyVehicle(vehicle.id, input);
    setIsEditing(false);
    await onChanged();
  }

  async function toggleActive() {
    setIsBusy(true);
    setError(null);
    try {
      if (vehicle.isActive) await deactivateMyVehicle(vehicle.id);
      else await updateMyVehicle(vehicle.id, { isActive: true });
      await onChanged();
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <article className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-medium">
            {vehicle.make} {vehicle.model}
          </h2>
          <p className="mt-0.5 font-mono text-xs text-neutral-500">{vehicle.registrationNumber}</p>
        </div>
        <StatusBadge
          tone={vehicle.isActive ? 'good' : 'neutral'}
          label={vehicle.isActive ? 'active' : 'deactivated'}
        />
      </div>

      {error ? (
        <p role="alert" className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}

      {isEditing ? (
        <div className="mt-4">
          <VehicleForm
            initial={vehicle}
            submitLabel="Save changes"
            onSubmit={handleUpdate}
            onCancel={() => setIsEditing(false)}
          />
        </div>
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
            <dt className="text-neutral-500">Connector</dt>
            <dd className="text-xs">{CONNECTOR_LABELS[vehicle.connectorType]}</dd>
            <dt className="text-neutral-500">Battery</dt>
            <dd className="text-xs">
              {vehicle.batteryCapacityKwh ? `${vehicle.batteryCapacityKwh} kWh` : '—'}
            </dd>
          </dl>

          <div className="mt-4 flex gap-2">
            <button
              type="button" onClick={() => setIsEditing(true)}
              className={buttonClasses('secondary')}
            >
              Edit
            </button>
            <button
              type="button" onClick={() => void toggleActive()} disabled={isBusy}
              className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-neutral-500/10 disabled:opacity-50 dark:border-neutral-700"
            >
              {isBusy ? 'Working…' : vehicle.isActive ? 'Deactivate' : 'Reactivate'}
            </button>
          </div>
        </>
      )}
    </article>
  );
}

function MyVehiclesContent() {
  const load = useCallback(() => listMyVehicles(), []);
  const { state, reload } = useAsyncData(load);
  const [isAdding, setIsAdding] = useState(false);

  async function handleCreate(input: VehicleInput) {
    await createMyVehicle(input);
    setIsAdding(false);
    await reload();
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-16">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-neutral-500">
            EV-CMS &middot; Module 3
          </p>
          <h1 className="mt-1 text-2xl font-semibold">My vehicles</h1>
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            The EVs on your account. Connector type decides which chargers will fit.
          </p>
        </div>
        {!isAdding ? (
          <button
            type="button" onClick={() => setIsAdding(true)}
            className={buttonClasses('primary', 'md')}
          >
            Add vehicle
          </button>
        ) : null}
      </header>

      {isAdding ? (
        <section className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
          <h2 className="mb-4 text-sm font-semibold">New vehicle</h2>
          <VehicleForm
            submitLabel="Add vehicle"
            onSubmit={handleCreate}
            onCancel={() => setIsAdding(false)}
          />
        </section>
      ) : null}

      {state.status === 'loading' ? (
        <p className="text-sm text-neutral-500">Loading vehicles&hellip;</p>
      ) : state.status === 'error' ? (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {state.error.message}
        </p>
      ) : state.data.length === 0 ? (
        <p className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No vehicles yet. Add one to get started.
        </p>
      ) : (
        <div className="space-y-3">
          {state.data.map((vehicle) => (
            <VehicleCard key={vehicle.id} vehicle={vehicle} onChanged={reload} />
          ))}
        </div>
      )}

      <p className="text-xs text-neutral-500">
        Deactivating keeps a vehicle on your account but hides it from charging. Records are never
        destroyed, so your charging history stays intact.
      </p>

      <Link href="/dashboard" className="text-sm text-neutral-500 underline underline-offset-4">
        Back to dashboard
      </Link>
    </main>
  );
}

export default function MyVehiclesPage() {
  return (
    <RequireAuth roles={['driver']}>
      <MyVehiclesContent />
    </RequireAuth>
  );
}
