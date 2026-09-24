'use client';

/**
 * Sessions in progress right now — the second live section.
 *
 * LIVE, and reusing exactly what Modules 7 and 8 already emit:
 *
 *   session:statusChanged   a session started, is stopping, completed or failed
 *   session:meterUpdate     energy ticked up on a running session
 *
 * NO BUSINESS LOGIC LIVES HERE. The table does not decide whether a session is active, what it
 * costs, or how much energy it delivered — every one of those is computed server-side and
 * arrives on the payload. This component sorts rows and formats numbers.
 *
 * The one judgement it makes is which rows belong on screen: a session that reaches a terminal
 * state is dropped, because "active sessions" that are finished is a table that lies.
 */

import { useState } from 'react';
import Link from 'next/link';

import { useSocketEvent } from '@/hooks/useSocketEvent';
import { estimateAmountPaise, formatPaise } from '@/lib/money';
import type { ChargingSession } from '@/types/api';
import { StatusBadge } from '@/components/StatusBadge';
import { EmptyState, Panel, relativeTime } from './primitives';

/** Module 7's vocabulary: anything not yet finished occupies a connector. */
const OPEN_STATUSES = ['initiating', 'active', 'stopping'];

export function ActiveSessions({ initial }: { initial: ChargingSession[] }) {
  const [sessions, setSessions] = useState(initial);

  /*
   * A refetch is authoritative over anything the socket has accumulated. Done by comparing
   * against the last-seen prop DURING render — React's documented "adjusting state when a
   * prop changes" — rather than `useEffect(..., [initial])`, which the React Compiler rejects
   * because a setState inside an effect paints once with stale rows before correcting itself.
   */
  const [seenInitial, setSeenInitial] = useState(initial);
  if (seenInitial !== initial) {
    setSeenInitial(initial);
    setSessions(initial);
  }

  useSocketEvent<{ session: ChargingSession }>('session:statusChanged', ({ session }) => {
    setSessions((current) => {
      const previous = current.find((row) => row.id === session.id);
      const without = current.filter((row) => row.id !== session.id);

      // Terminal sessions leave the table. Everything else is inserted or replaced in place.
      if (!OPEN_STATUSES.includes(session.status)) return without;

      // MERGE onto the row we had: a push may lack the display labels the REST load carried.
      return [{ ...previous, ...session }, ...without].sort(
        (a, b) =>
          new Date(b.startedAt ?? b.requestedAt).getTime() -
          new Date(a.startedAt ?? a.requestedAt).getTime(),
      );
    });
  });

  useSocketEvent<{ sessionId: string; energyConsumedWh: number; energyConsumedKwh: number }>(
    'session:meterUpdate',
    (event) => {
      setSessions((current) =>
        current.map((row) =>
          row.id === event.sessionId
            ? {
                ...row,
                energyConsumedWh: event.energyConsumedWh,
                energyConsumedKwh: event.energyConsumedKwh,
              }
            : row,
        ),
      );
    },
  );

  return (
    <Panel
      title={`Active sessions${sessions.length > 0 ? ` (${sessions.length})` : ''}`}
      action={{ href: '/sessions', label: 'All sessions →' }}
    >
      {sessions.length === 0 ? (
        <EmptyState message="No sessions in progress." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-[11px] font-medium uppercase tracking-[0.08em] text-neutral-500 dark:border-neutral-800">
                <th className="pb-2 font-medium">Where</th>
                <th className="pb-2 font-medium">Driver</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 text-right font-medium">Energy</th>
                <th className="pb-2 text-right font-medium">Est. cost</th>
                <th className="pb-2 text-right font-medium">Started</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-900">
              {sessions.map((session) => {
                /*
                 * An ESTIMATE, and labelled as one. Module 9 snapshots the rate onto the
                 * session and Module 8 streams the energy, so this is those two numbers
                 * multiplied by the helper Module 10 already wrote — not a second pricing
                 * implementation. The authoritative amount is computed server-side when the
                 * session ends.
                 */
                const estimate = estimateAmountPaise(
                  session.energyConsumedKwh,
                  session.appliedPricePerKwhPaise,
                );

                return (
                  <tr key={session.id} className="transition-colors hover:bg-neutral-500/5">
                    <td className="py-2.5">
                      <Link href={`/sessions/${session.id}`} className="underline underline-offset-2">
                        {session.stationName ?? 'Station'}
                      </Link>
                      <span className="block text-[11px] text-neutral-500">
                        {session.chargerName ?? 'Charger'} #{session.connectorNumber}
                        {session.connectorType ? ` · ${session.connectorType}` : ''}
                      </span>
                    </td>
                    <td className="py-2.5 text-neutral-600 dark:text-neutral-400">
                      {session.driverName ?? '—'}
                    </td>
                    <td className="py-2.5">
                      <StatusBadge status={session.status} size="sm" />
                    </td>
                    <td className="py-2.5 text-right tabular-nums">
                      {session.energyConsumedKwh.toFixed(3)} kWh
                    </td>
                    <td className="py-2.5 text-right tabular-nums text-neutral-500">
                      {estimate === null ? '—' : formatPaise(estimate)}
                    </td>
                    <td className="py-2.5 text-right text-neutral-500">
                      {session.startedAt ? relativeTime(session.startedAt) : 'starting…'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-neutral-500">
            Cost is a live estimate from the snapshotted rate. The final amount is calculated by
            the server when the session ends.
          </p>
        </div>
      )}
    </Panel>
  );
}
