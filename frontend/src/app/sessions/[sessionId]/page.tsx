'use client';

/**
 * Charging session detail — live while it runs, a receipt once it ends.
 *
 * POLLING, AND WHY IT IS TEMPORARY. This screen re-fetches every three seconds while the
 * session is open. That is the honest interim solution: the browser has no way to learn that a
 * charger sent a MeterValues, because the OCPP socket ends at the backend. Module 8 replaces
 * the polling with Socket.IO and the backend pushes each reading as it lands.
 *
 * The two real-time systems stay separate even then. The browser never speaks OCPP, and the
 * charger never speaks Socket.IO — the backend is the only thing that sees both.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

import { RequireAuth } from '@/components/RequireAuth';
import { StatusBadge } from '@/components/StatusBadge';
import {
  SESSION_STATUS_LABELS,
  STOP_REASON_LABELS,
  formatDuration,
  formatEnergy,
  formatWhen,
  sessionTone,
} from '@/components/SessionSummary';
import { useAuth } from '@/context/AuthContext';
import { useAsyncData } from '@/hooks/useAsyncData';
import { toMessage } from '@/lib/formatApiError';
import { getSession, getSessionReadings, stopSession } from '@/services/session.service';
import type { ChargingSession, MeterReading } from '@/types/api';

const POLL_INTERVAL_MS = 3000;
const OPEN_STATUSES = ['initiating', 'active', 'stopping'];

/** A tiny inline chart. No library: it is one path over a handful of points. */
function EnergyCurve({ readings }: { readings: MeterReading[] }) {
  if (readings.length < 2) {
    return (
      <p className="text-sm text-neutral-500">
        Waiting for the charger to report energy…
      </p>
    );
  }

  const width = 600;
  const height = 140;
  const first = new Date(readings[0].meterTimestamp).getTime();
  const last = new Date(readings[readings.length - 1].meterTimestamp).getTime();
  const span = Math.max(1, last - first);
  const maxWh = Math.max(...readings.map((r) => r.energyWh)) || 1;

  const points = readings.map((reading) => {
    const x = ((new Date(reading.meterTimestamp).getTime() - first) / span) * width;
    const y = height - (reading.energyWh / maxWh) * (height - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-36 w-full"
      preserveAspectRatio="none"
      role="img"
      aria-label="Energy delivered over time"
    >
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        className="text-emerald-600"
      />
    </svg>
  );
}

function SessionDetail({
  session,
  readings,
  onChanged,
}: {
  session: ChargingSession;
  readings: MeterReading[];
  onChanged: (session: ChargingSession) => void;
}) {
  const { user } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [isStopping, setIsStopping] = useState(false);

  // A clock tick so the elapsed time advances between polls rather than freezing.
  const [now, setNow] = useState(() => Date.now());
  const isOpen = OPEN_STATUSES.includes(session.status);

  useEffect(() => {
    if (!isOpen) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isOpen]);

  const isOwner = user?.id === session.userId;
  const isStaff = user?.role !== 'driver';
  const canStop = isOpen && session.status !== 'stopping' && (isOwner || isStaff);

  async function stop() {
    setIsStopping(true);
    setError(null);
    try {
      onChanged(await stopSession(session.id));
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setIsStopping(false);
    }
  }

  const latest = readings.at(-1);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{formatEnergy(session)}</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Connector {session.connectorNumber}
            {session.transactionId !== null && (
              <>
                {' · '}
                <span className="font-mono text-xs">txn {session.transactionId}</span>
              </>
            )}
          </p>
        </div>
        <StatusBadge tone={sessionTone(session.status)} label={SESSION_STATUS_LABELS[session.status]} />
      </div>

      {session.status === 'initiating' && (
        <p className="rounded-lg bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-400">
          The charger has been asked to start and has not confirmed yet. Nothing is charging
          until it does — this usually takes a few seconds.
        </p>
      )}

      {session.status === 'failed' && (
        <p className="rounded-lg bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-400">
          {session.failureReason ?? 'This session did not complete.'}
        </p>
      )}

      <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-neutral-500">Duration</dt>
          <dd className="mt-0.5 font-medium">{formatDuration(session, now)}</dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-500">Started</dt>
          <dd className="mt-0.5 font-medium">{formatWhen(session.startedAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-500">Ended</dt>
          <dd className="mt-0.5 font-medium">{formatWhen(session.endedAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-500">Power now</dt>
          <dd className="mt-0.5 font-medium">
            {isOpen && latest?.powerKw !== null && latest?.powerKw !== undefined
              ? `${latest.powerKw} kW`
              : '—'}
          </dd>
        </div>
      </dl>

      {session.stopReason && (
        <p className="text-sm text-neutral-500">
          {STOP_REASON_LABELS[session.stopReason] ?? session.stopReason}
        </p>
      )}

      <section className="rounded-2xl border border-neutral-200 p-6 dark:border-neutral-800">
        <h2 className="text-sm font-semibold">Energy delivered</h2>
        <p className="mb-4 mt-0.5 text-xs text-neutral-500">
          {readings.length} meter reading{readings.length === 1 ? '' : 's'} from the charger
          {isOpen ? ' · updating every few seconds' : ''}
        </p>
        <EnergyCurve readings={readings} />
      </section>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {canStop && (
        <button
          type="button"
          onClick={() => void stop()}
          disabled={isStopping}
          className="w-full rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-60 sm:w-auto sm:px-6"
        >
          {isStopping ? 'Asking the charger…' : isOwner ? 'Stop charging' : 'Force stop'}
        </button>
      )}

      {session.status === 'stopping' && (
        <p className="text-sm text-neutral-500">
          Stop sent. The session completes when the charger reports its final meter reading.
        </p>
      )}
    </div>
  );
}

function SessionDetailContent() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId;

  const load = useCallback(
    async () => ({
      session: await getSession(sessionId),
      readings: await getSessionReadings(sessionId),
    }),
    [sessionId],
  );

  const { state, reload, setData } = useAsyncData(load);

  // Poll only while there is something to watch. A completed session never changes again, so
  // continuing to poll it would be pure waste — and it is why this effect depends on `isOpen`
  // rather than running unconditionally.
  const isOpen = state.status === 'ok' && OPEN_STATUSES.includes(state.data.session.status);

  useEffect(() => {
    if (!isOpen) return;
    const timer = setInterval(() => void reload(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isOpen, reload]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      {state.status === 'loading' && <p className="text-sm text-neutral-500">Loading…</p>}

      {state.status === 'error' && (
        <p className="rounded-lg bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-400">
          {toMessage(state.error)}
        </p>
      )}

      {state.status === 'ok' && (
        <SessionDetail
          session={state.data.session}
          readings={state.data.readings}
          onChanged={(session) => setData({ ...state.data, session })}
        />
      )}

      <Link
        href="/sessions"
        className="mt-10 inline-block text-sm text-neutral-500 underline underline-offset-4"
      >
        All sessions
      </Link>
    </main>
  );
}

export default function SessionDetailPage() {
  return (
    <RequireAuth>
      <SessionDetailContent />
    </RequireAuth>
  );
}
