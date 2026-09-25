'use client';

/**
 * Charging session detail — live while it runs, a receipt once it ends.
 *
 * MODULE 8 REPLACED THE POLL. This screen used to re-fetch every three seconds; now the
 * backend pushes `session:statusChanged` and `session:meterUpdate` as they land, and the
 * numbers move the instant the charger reports them instead of up to three seconds later.
 *
 * The two real-time systems stay separate. The charger's MeterValues arrives over OCPP on a
 * socket that ends at the backend; the backend writes it, then emits an app event over
 * Socket.IO. The browser never speaks OCPP and the charger never speaks Socket.IO — the
 * backend is the only thing that sees both.
 *
 * REST still does the first load, and does it again on every reconnect: an event describes a
 * change, so there has to be something to change, and events missed while offline are gone.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

import { useSocket } from '@/context/SocketContext';
import { useSocketEvent } from '@/hooks/useSocketEvent';

import { RequireAuth } from '@/components/RequireAuth';
import { StatusBadge } from '@/components/StatusBadge';
import {
  SESSION_STATUS_LABELS,
  describeStop,
  formatDuration,
  formatEnergy,
  formatWhen,
  sessionTone,
} from '@/components/SessionSummary';
import { useAuth } from '@/context/AuthContext';
import { useAsyncData } from '@/hooks/useAsyncData';
import { toMessage } from '@/lib/formatApiError';
import { estimateAmountPaise, formatPaise, formatRate } from '@/lib/money';
import { getSession, getSessionReadings, stopSession } from '@/services/session.service';
import type { ChargingSession, MeterReading } from '@/types/api';
import { formatTime } from '@/lib/datetime';
import { LoadError } from '@/components/ui/LoadError';

const OPEN_STATUSES = ['initiating', 'active', 'stopping'];

/**
 * Charging progress — the numbers a driver and a support agent actually read.
 *
 * WHY THERE IS NO CHART HERE ANY MORE. It plotted CUMULATIVE energy, which only ever rises; at a
 * steady charging power it is a straight diagonal on every session, so it told nobody anything
 * the kWh figure above had not already said. The shape that carries information on real hardware
 * is POWER over time (a DC charger tapering as the battery fills) — and that is summarised here as
 * current / average / peak kW rather than drawn, until there is hardware whose curve is worth
 * looking at.
 */
function ChargingProgress({
  session,
  readings,
  now,
}: {
  session: ChargingSession;
  readings: MeterReading[];
  now: number;
}) {
  const isOpen = OPEN_STATUSES.includes(session.status);
  const latest = readings.at(-1);
  const powers = readings.map((r) => r.powerKw).filter((p): p is number => p !== null);
  const peak = powers.length ? Math.max(...powers) : null;

  const start = session.startedAt ? new Date(session.startedAt).getTime() : null;
  const end = session.endedAt ? new Date(session.endedAt).getTime() : now;
  const hours = start ? Math.max(0, end - start) / 3_600_000 : 0;
  const average = hours > 0.001 ? session.energyConsumedKwh / hours : null;
  const soc = [...readings].reverse().find((r) => r.socPercent !== null)?.socPercent ?? null;

  const cells: { label: string; value: string }[] = [
    {
      label: isOpen ? 'Power now' : 'Power at end',
      value: latest?.powerKw !== null && latest?.powerKw !== undefined ? `${latest.powerKw} kW` : '—',
    },
    { label: 'Average power', value: average === null ? '—' : `${average.toFixed(1)} kW` },
    { label: 'Peak power', value: peak === null ? '—' : `${peak} kW` },
    ...(soc !== null ? [{ label: 'Battery', value: `${soc}%` }] : []),
  ];

  return (
    <section className="rounded-2xl border border-neutral-200 p-6 dark:border-neutral-800">
      <h2 className="text-sm font-semibold">Charging progress</h2>
      <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        {cells.map((cell) => (
          <div key={cell.label}>
            <dt className="text-xs text-neutral-500">{cell.label}</dt>
            <dd className="mt-0.5 font-medium tabular-nums">{cell.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-xs text-neutral-500">
        {readings.length === 0
          ? isOpen
            ? 'Waiting for the charger to report its first meter reading…'
            : 'The charger sent no meter readings for this session.'
          : `Last reading from the charger ${formatTime(latest!.meterTimestamp)}` +
            (isOpen ? ' · updating live' : '')}
        {session.powerKw ? ` · charger rated ${session.powerKw} kW` : ''}
      </p>
    </section>
  );
}

/**
 * The raw meter log. STAFF ONLY, collapsed by default — it is evidence for a billing dispute
 * ("the charger says 0.4 kWh at 10:02, 6.1 kWh at 10:40"), not something a driver needs.
 */
function MeterLog({ readings }: { readings: MeterReading[] }) {
  if (readings.length === 0) return null;
  return (
    <details className="rounded-2xl border border-neutral-200 p-6 text-sm dark:border-neutral-800">
      <summary className="cursor-pointer font-semibold">
        Meter readings ({readings.length})
      </summary>
      <div className="mt-4 max-h-72 overflow-auto">
        <table className="w-full text-left text-xs tabular-nums">
          <thead className="text-neutral-500">
            <tr>
              <th className="py-1 pr-4 font-medium">Time</th>
              <th className="py-1 pr-4 font-medium">Meter (kWh)</th>
              <th className="py-1 pr-4 font-medium">Power (kW)</th>
            </tr>
          </thead>
          <tbody>
            {readings.map((r) => (
              <tr key={r.id} className="border-t border-neutral-200 dark:border-neutral-800">
                <td className="py-1 pr-4">{formatTime(r.meterTimestamp)}</td>
                <td className="py-1 pr-4">{(r.energyWh / 1000).toFixed(3)}</td>
                <td className="py-1 pr-4">{r.powerKw ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Where the charge happened, and on what — the header of any real charging receipt. */
function ChargeLocation({ session, isStaff }: { session: ChargingSession; isStaff: boolean }) {
  const rows: { label: string; value: React.ReactNode }[] = [
    { label: 'Operator', value: session.companyName ?? '—' },
    {
      label: 'Station',
      value: session.stationName ? (
        <>
          {isStaff ? (
            <Link href={`/stations/${session.stationId}`} className="underline underline-offset-2">
              {session.stationName}
            </Link>
          ) : (
            session.stationName
          )}
          {session.stationAddress && (
            <span className="block text-xs font-normal text-neutral-500">
              {session.stationAddress}
              {session.stationCity ? `, ${session.stationCity}` : ''}
            </span>
          )}
        </>
      ) : (
        '—'
      ),
    },
    {
      label: 'Charger',
      value: (
        <>
          {isStaff && session.chargerName ? (
            <Link href={`/chargers/${session.chargerId}`} className="underline underline-offset-2">
              {session.chargerName}
            </Link>
          ) : (
            (session.chargerName ?? '—')
          )}
          <span className="block text-xs font-normal text-neutral-500">
            {[session.chargerType, session.powerKw ? `${session.powerKw} kW` : null]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </>
      ),
    },
    {
      label: 'Connector',
      value: `#${session.connectorNumber}${session.connectorType ? ` · ${session.connectorType}` : ''}`,
    },
    ...(isStaff
      ? [
          {
            label: 'Driver',
            value: (
              <>
                {session.driverName ?? '—'}
                {session.driverEmail && (
                  <span className="block text-xs font-normal text-neutral-500">
                    {session.driverEmail}
                  </span>
                )}
              </>
            ),
          },
        ]
      : []),
  ];

  return (
    <section className="rounded-2xl border border-neutral-200 p-6 dark:border-neutral-800">
      <h2 className="text-sm font-semibold">Where</h2>
      <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
        {rows.map((row) => (
          <div key={row.label}>
            <dt className="text-xs text-neutral-500">{row.label}</dt>
            <dd className="mt-0.5 font-medium">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Reasons a staff member picks from before force-stopping someone's charge. */
const FORCE_STOP_REASONS = [
  'Safety concern at the site',
  'Charger fault reported — stopping for inspection',
  'Driver asked support to stop it',
  'Vehicle is fully charged and blocking the bay',
  'Scheduled maintenance',
];

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
  const { isConnected } = useSocket();
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

  async function stop(reason?: string) {
    setIsStopping(true);
    setError(null);
    try {
      onChanged(await stopSession(session.id, reason));
      setIsChoosingReason(false);
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setIsStopping(false);
    }
  }

  const [isChoosingReason, setIsChoosingReason] = useState(false);
  const [reasonChoice, setReasonChoice] = useState(FORCE_STOP_REASONS[0]);
  const [reasonText, setReasonText] = useState('');

  const forceStopped = Boolean(session.stoppedByRole && session.stoppedByRole !== 'driver');
  const stopDescription = describeStop(session);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{formatEnergy(session)}</h1>
          {(session.stationName || session.companyName) && (
            <p className="mt-1 text-sm font-medium">
              {session.stationName ?? 'Charging station'}
              {session.companyName && (
                <span className="font-normal text-neutral-500"> · by {session.companyName}</span>
              )}
            </p>
          )}
          <p className="mt-1 text-sm text-neutral-500">
            {session.chargerName ? `${session.chargerName} · ` : ''}Connector {session.connectorNumber}
            {session.transactionId !== null && (
              <>
                {' · '}
                <span className="font-mono text-xs">txn {session.transactionId}</span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isOpen && (
            <StatusBadge
              tone={isConnected ? 'good' : 'warn'}
              label={isConnected ? 'live' : 'reconnecting…'}
            />
          )}
          <StatusBadge tone={sessionTone(session.status)} label={SESSION_STATUS_LABELS[session.status]} />
        </div>
      </div>

      {session.status === 'initiating' && (
        <p className="rounded-lg bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-400">
          The charger has been asked to start and has not confirmed yet. Nothing is charging
          until it does — this usually takes a few seconds.
        </p>
      )}

      {/*
        The driver must hear that someone else ended their charge, and why. This updates live: the
        stop pushes `session:statusChanged` to the driver's own room, and a notification is left
        in their inbox for when they are not looking at this screen.
      */}
      {forceStopped && (
        <div className="rounded-lg bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-300">
          <p className="font-medium">
            {session.status === 'stopping'
              ? 'The station operator is stopping this charge.'
              : 'This charge was stopped by the station operator.'}
          </p>
          {session.stopNote && <p className="mt-1">Reason: {session.stopNote}</p>}
          {isOwner && (
            <p className="mt-1 text-xs">
              You are billed only for the energy delivered before the stop. If this was wrong,
              report a problem below.
            </p>
          )}
        </div>
      )}

      {session.status === 'failed' && !forceStopped && (
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
          <dt className="text-xs text-neutral-500">{isOpen ? 'Cost so far' : 'Amount'}</dt>
          <dd className="mt-0.5 font-medium tabular-nums">
            {/*
              While charging this is an ESTIMATE, computed right here from two numbers the page
              already has: the energy Module 8 streams on every meter update, and the rate that
              was snapshotted onto the session when it started. No new endpoint, no new event.

              Once the session ends, `amountPaise` is the authoritative figure the server
              calculated from the final meter reading - so the display switches to it.
            */}
            {session.amountPaise !== null
              ? formatPaise(session.amountPaise)
              : (() => {
                  const estimate = estimateAmountPaise(
                    session.energyConsumedKwh,
                    session.appliedPricePerKwhPaise,
                  );
                  return estimate === null ? '—' : `~${formatPaise(estimate)}`;
                })()}
          </dd>
        </div>
      </dl>

      {/*
        MODULE 10 — payment is its OWN state machine. A completed session that is still unpaid is
        correct, not an error: the electricity flowed and the wallet was short. Saying so plainly
        beats a screen that implies everything settled.
      */}
      {session.amountPaise !== null && session.amountPaise > 0 && (
        <div
          className={`rounded-lg p-4 text-sm ${
            session.paymentStatus === 'paid'
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
              : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
          }`}
        >
          {session.paymentStatus === 'paid' ? (
            <>
              Paid {formatPaise(session.amountPaise)} from {isOwner ? 'your' : "the driver's"} wallet.
            </>
          ) : !isOwner ? (
            <>
              <strong>{formatPaise(session.amountPaise)} is outstanding.</strong> The driver&apos;s
              balance was too low when this charge ended. It is collected automatically when they
              top up.
            </>
          ) : (
            <>
              <strong>{formatPaise(session.amountPaise)} is outstanding.</strong> Your balance was
              too low when this charge ended. Top up your{' '}
              <Link href="/wallet" className="underline underline-offset-2">
                wallet
              </Link>{' '}
              and it settles automatically.
            </>
          )}
        </div>
      )}

      {session.appliedPricePerKwhPaise !== null && (
        <p className="text-sm text-neutral-500">
          Charged at {formatRate(session.appliedPricePerKwhPaise)}
          {isOpen ? ' — the rate is fixed for this session even if the price sheet changes.' : ''}
        </p>
      )}

      {stopDescription && !forceStopped && (
        <p className="text-sm text-neutral-500">{stopDescription}</p>
      )}

      <ChargeLocation session={session} isStaff={isStaff} />

      <ChargingProgress session={session} readings={readings} now={now} />

      {isStaff && <MeterLog readings={readings} />}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {canStop && isOwner && (
        <button
          type="button"
          onClick={() => void stop()}
          disabled={isStopping}
          className="w-full rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-60 sm:w-auto sm:px-6"
        >
          {isStopping ? 'Asking the charger…' : 'Stop charging'}
        </button>
      )}

      {/*
        FORCE-STOP asks for a reason first. The driver is notified with it, and it stays on the
        session record — "why did my charge stop?" is the call support will get next.
      */}
      {canStop && !isOwner && isStaff && !isChoosingReason && (
        <button
          type="button"
          onClick={() => setIsChoosingReason(true)}
          className="w-full rounded-lg border border-red-600 px-4 py-2.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-500/10 sm:w-auto sm:px-6 dark:text-red-400"
        >
          Force stop this charge…
        </button>
      )}

      {canStop && !isOwner && isStaff && isChoosingReason && (
        <section className="space-y-3 rounded-2xl border border-red-600/40 p-6">
          <h2 className="text-sm font-semibold">Force stop — the driver will be told why</h2>
          <select
            value={reasonChoice}
            onChange={(event) => setReasonChoice(event.target.value)}
            className="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700"
          >
            {FORCE_STOP_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
            <option value="other">Other…</option>
          </select>
          {reasonChoice === 'other' && (
            <input
              value={reasonText}
              onChange={(event) => setReasonText(event.target.value)}
              placeholder="Reason shown to the driver"
              maxLength={200}
              className="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700"
            />
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void stop(reasonChoice === 'other' ? reasonText.trim() : reasonChoice)}
              disabled={isStopping || (reasonChoice === 'other' && reasonText.trim().length < 3)}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-60"
            >
              {isStopping ? 'Asking the charger…' : 'Stop the charge'}
            </button>
            <button
              type="button"
              onClick={() => setIsChoosingReason(false)}
              disabled={isStopping}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium transition-colors hover:bg-neutral-500/10 dark:border-neutral-700"
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      {/*
        Where a dispute actually starts. The session id goes in the URL as the complaint's
        ANCHOR, and the server derives the charger, station and company from it — the driver
        never selects them, so a mismatched set cannot be submitted.

        Owner only: /complaints/new is a driver page, so showing this to staff just bounced them
        to the dashboard.
      */}
      {!isOpen && isOwner && (
        <Link
          href={`/complaints/new?sessionId=${session.id}`}
          className="inline-block text-sm text-neutral-500 underline underline-offset-4"
        >
          Something wrong with this charge? Report a problem
        </Link>
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
    async () => {
      // In parallel: this runs again on every meter tick while the page is open.
      const [session, readings] = await Promise.all([
        getSession(sessionId),
        getSessionReadings(sessionId),
      ]);
      return { session, readings };
    },
    [sessionId],
  );

  const { state, reload, setData } = useAsyncData(load);
  // Only the reconnect counter is needed here; the "live" badge lives in the child, which
  // reads `isConnected` itself.
  const { reconnectCount } = useSocket();

  /*
   * RECOVERY, not polling. Refetch once per (re)connect, because events emitted while the
   * browser was offline are not replayed. The first connect is included deliberately, so the
   * normal path and the recovery path are one piece of code.
   */
  useEffect(() => {
    if (reconnectCount > 1) void reload();
  }, [reconnectCount, reload]);

  // Only this session's events matter. The socket carries a driver's own sessions and, for
  // staff, their whole company - so the id check is a DISPLAY filter, never a security one.
  useSocketEvent<{ session: ChargingSession }>('session:statusChanged', ({ session }) => {
    if (state.status !== 'ok' || session.id !== state.data.session.id) return;
    // MERGE, not replace: the pushed payload carries no display labels (station, operator…), and
    // replacing would blank the "Where" card the moment the charger reported anything.
    setData((data) => ({ ...data, session: { ...data.session, ...session } }));
  });

  useSocketEvent<{ sessionId: string }>('session:meterUpdate', (event) => {
    if (state.status !== 'ok' || event.sessionId !== state.data.session.id) return;
    // Refetch rather than appending the payload: the readings list is the chart's source and
    // the server already knows the canonical order, so one request beats reimplementing the
    // merge (and any disagreement between the two).
    void reload();
  });

  return (
    <main className="page page-detail page-flow">
      {state.status === 'loading' && <p className="text-sm text-neutral-500">Loading…</p>}

      {state.status === 'error' && (
        <LoadError error={state.error} noun="session" backHref="/sessions" backLabel="Back to sessions" />
      )}

      {state.status === 'ok' && (
        <SessionDetail
          session={state.data.session}
          readings={state.data.readings}
          onChanged={(session) => setData((data) => ({ ...data, session: { ...data.session, ...session } }))}
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
