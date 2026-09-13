'use client';

/**
 * Start a charge — the driver's screen.
 *
 * In a finished product the connector id arrives by scanning the QR code printed on the plug;
 * `/charge?connectorId=...` is exactly the URL that code would encode. Typing it by hand is
 * the same flow without a camera, which is why the lookup is a real endpoint rather than
 * something the scan page fakes.
 *
 * The screen deliberately does NOT decide whether charging is possible. It asks the server
 * (`canStart` plus a reason), because that verdict depends on three separate states — the
 * charger's administrative status, its live connectivity, and the plug's own status — and only
 * the server sees all three.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';

import { RequireAuth } from '@/components/RequireAuth';
import { StatusBadge } from '@/components/StatusBadge';
import { useAsyncData } from '@/hooks/useAsyncData';
import { toMessage } from '@/lib/formatApiError';
import {
  getActiveSession,
  getConnectorForCharging,
  startSession,
} from '@/services/session.service';
import { listMyVehicles } from '@/services/vehicle.service';
import type { ConnectorChargingView, Vehicle } from '@/types/api';

function ConnectorCard({
  connector,
  vehicles,
}: {
  connector: ConnectorChargingView;
  vehicles: Vehicle[];
}) {
  const router = useRouter();
  const [vehicleId, setVehicleId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  // A car that physically cannot use this plug is filtered out here as a convenience — the
  // server rejects the mismatch with 422 regardless, which is what actually enforces it.
  const usable = vehicles.filter((v) => v.connectorType === connector.connectorType);
  const incompatible = vehicles.length - usable.length;

  async function start() {
    setIsStarting(true);
    setError(null);
    try {
      const session = await startSession({
        connectorId: connector.connectorId,
        ...(vehicleId ? { vehicleId } : {}),
      });
      router.push(`/sessions/${session.id}`);
    } catch (caught) {
      setError(toMessage(caught));
      setIsStarting(false);
    }
  }

  return (
    <div className="rounded-2xl border border-neutral-200 p-6 dark:border-neutral-800">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{connector.chargerName}</h2>
          <p className="mt-1 text-sm text-neutral-500">
            {connector.stationName} · {connector.stationAddress}
          </p>
        </div>
        <StatusBadge
          tone={connector.canStart ? 'good' : 'warn'}
          label={connector.canStart ? 'ready' : connector.status}
        />
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-neutral-500">Connector</dt>
          <dd className="mt-0.5 font-medium">#{connector.connectorNumber}</dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-500">Plug type</dt>
          <dd className="mt-0.5 font-medium">{connector.connectorType}</dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-500">Max power</dt>
          <dd className="mt-0.5 font-medium">{connector.powerKw} kW</dd>
        </div>
      </dl>

      {!connector.canStart ? (
        <p className="mt-5 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
          {connector.unavailableReason ?? 'This connector cannot be used right now.'}
        </p>
      ) : (
        <div className="mt-6 space-y-4">
          <label className="block text-sm">
            <span className="text-neutral-600 dark:text-neutral-400">
              Which car? <span className="text-neutral-400">(optional)</span>
            </span>
            <select
              value={vehicleId}
              onChange={(event) => setVehicleId(event.target.value)}
              className="mt-1 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700"
            >
              <option value="">Not specified</option>
              {usable.map((vehicle) => (
                <option key={vehicle.id} value={vehicle.id}>
                  {vehicle.make} {vehicle.model} — {vehicle.registrationNumber}
                </option>
              ))}
            </select>
            {incompatible > 0 && (
              <span className="mt-1 block text-xs text-neutral-500">
                {incompatible} of your vehicles cannot use a {connector.connectorType} plug and
                are not listed.
              </span>
            )}
          </label>

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          <button
            type="button"
            onClick={() => void start()}
            disabled={isStarting}
            className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-60"
          >
            {isStarting ? 'Asking the charger…' : 'Start charging'}
          </button>
          <p className="text-center text-xs text-neutral-500">
            The charger has to confirm before power flows — the next screen waits for it.
          </p>
        </div>
      )}
    </div>
  );
}

function ChargeContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const connectorIdParam = searchParams.get('connectorId') ?? '';

  const [input, setInput] = useState(connectorIdParam);

  const load = useCallback(async () => {
    const [active, vehicles] = await Promise.all([getActiveSession(), listMyVehicles()]);
    if (!connectorIdParam) return { active, vehicles, connector: null };
    return { active, vehicles, connector: await getConnectorForCharging(connectorIdParam) };
  }, [connectorIdParam]);

  const { state } = useAsyncData(load);

  // One open session at a time is enforced per connector by the database; the driver-facing
  // rule is simpler still — finish the charge you already have.
  useEffect(() => {
    if (state.status === 'ok' && state.data.active) {
      router.replace(`/sessions/${state.data.active.id}`);
    }
  }, [state, router]);

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Start charging</h1>
      <p className="mt-2 text-sm text-neutral-500">
        Scan the code on the charger, or paste a connector id below.
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          router.push(`/charge?connectorId=${encodeURIComponent(input.trim())}`);
        }}
        className="mt-6 flex gap-2"
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Connector id"
          className="flex-1 rounded-lg border border-neutral-300 bg-transparent px-3 py-2 font-mono text-sm dark:border-neutral-700"
        />
        <button
          type="submit"
          className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium transition-colors hover:bg-neutral-500/10 dark:border-neutral-700"
        >
          Look up
        </button>
      </form>

      <div className="mt-8">
        {state.status === 'loading' && <p className="text-sm text-neutral-500">Loading…</p>}

        {state.status === 'error' && (
          <p className="rounded-lg bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-400">
            {toMessage(state.error)}
          </p>
        )}

        {state.status === 'ok' && !state.data.connector && (
          <p className="text-sm text-neutral-500">
            Enter a connector id to see whether it is free.
          </p>
        )}

        {state.status === 'ok' && state.data.connector && (
          <ConnectorCard connector={state.data.connector} vehicles={state.data.vehicles} />
        )}
      </div>

      <Link
        href="/sessions"
        className="mt-8 inline-block text-sm text-neutral-500 underline underline-offset-4"
      >
        My charging history
      </Link>
    </main>
  );
}

export default function ChargePage() {
  return (
    <RequireAuth roles={['driver']}>
      <ChargeContent />
    </RequireAuth>
  );
}
