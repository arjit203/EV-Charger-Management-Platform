'use client';

/**
 * Charger and connector status — the one section of the dashboard that is genuinely LIVE.
 *
 * ============================================================================
 * WHY THIS IS LIVE AND THE REVENUE CARD IS NOT.
 *
 * A charger changing state is a DISCRETE EVENT someone may need to act on. A
 * revenue total is an AGGREGATE OVER A WINDOW, and a figure that twitches on
 * every payment is noise rather than information.
 *
 * This is Module 8's own D7 reasoning — "connectivity emits on transition only;
 * heartbeat-rate emits are noise" — applied to a card instead of a socket.
 * ============================================================================
 *
 * The counts arrive from `/analytics/overview` on load, then Socket.IO adjusts them. NOTHING
 * is recomputed here: the deltas move a number the server produced, and any navigation away
 * and back re-reads the authoritative figure.
 *
 * No new events, no new rooms, no publisher changes. These are the same two events Module 8
 * already emits and the `/monitor` page already consumes.
 */

import { useState } from 'react';
import Link from 'next/link';

import { useSocketEvent } from '@/hooks/useSocketEvent';
import type { ConnectorStatus, FleetSnapshot } from '@/types/api';
import { statusTone } from '@/components/StatusBadge';
import { Panel } from './primitives';

interface ConnectorStatusEvent {
  connectorId: string;
  status: ConnectorStatus;
}

interface ChargerConnectivityEvent {
  chargerId: string;
  isOnline: boolean;
}

/*
 * Connector counts read as a number + word rather than a pill, because there are seven of
 * them and seven pills is a wall. The COLOUR still comes from the one shared vocabulary, so
 * `charging` is the same blue here as the badge on the sessions table beside it.
 */
const TONE_TEXT: Record<string, string> = {
  good: 'text-emerald-600 dark:text-emerald-400',
  info: 'text-blue-600 dark:text-blue-400',
  warn: 'text-amber-600 dark:text-amber-500',
  bad: 'text-red-600 dark:text-red-500',
  neutral: 'text-neutral-500',
};

export function FleetStatus({ fleet }: { fleet: FleetSnapshot }) {
  /*
   * Server truth is the starting point, and it WINS whenever it arrives. Seeding state from a
   * prop needs care: a bare `useState(fleet)` would ignore every later refetch, leaving the
   * tile frozen on the first payload it ever saw. The reconciliation just below is what keeps
   * a reload authoritative over any accumulated socket deltas.
   */
  const [connectors, setConnectors] = useState(fleet.connectorsByStatus);
  const [online, setOnline] = useState(fleet.chargersOnline);

  /*
   * ADJUSTING STATE WHEN A PROP CHANGES, React's documented pattern for exactly this — not an
   * effect. A refetch hands down a new `fleet` object, and the server's counts must win over
   * whatever the socket has accumulated since the last load.
   *
   * `useEffect(..., [fleet])` would be the obvious way and the React Compiler rejects it: a
   * setState inside an effect renders once with stale values and then again with fresh ones.
   * Comparing against the last-seen prop DURING render corrects it before anything paints.
   */
  const [seenFleet, setSeenFleet] = useState(fleet);
  if (seenFleet !== fleet) {
    setSeenFleet(fleet);
    setConnectors(fleet.connectorsByStatus);
    setOnline(fleet.chargersOnline);
  }

  /*
   * A connector moved. We know its NEW status but not its old one, so the counts cannot be
   * adjusted by decrementing a bucket we would have to guess at.
   *
   * Rather than invent a wrong number, the tile marks itself STALE and shows the new status as
   * the freshest thing it knows. Being honestly out of date beats being confidently wrong —
   * and a refetch on navigation restores exact counts from the server.
   */
  const [liveNote, setLiveNote] = useState<string | null>(null);

  useSocketEvent<ConnectorStatusEvent>('connector:statusChanged', (event) => {
    setLiveNote(`A connector just became ${event.status}`);
  });

  useSocketEvent<ChargerConnectivityEvent>('charger:connectivityChanged', (event) => {
    // Connectivity IS a clean +1/-1: the event carries the new boolean and nothing else moves.
    setOnline((current) => Math.max(0, Math.min(fleet.chargers, current + (event.isOnline ? 1 : -1))));
    setLiveNote(`A charger just went ${event.isOnline ? 'online' : 'offline'}`);
  });

  const offline = Math.max(0, fleet.chargers - online);

  return (
    <Panel title="Fleet status" action={{ href: '/monitor', label: 'Live operations →' }}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Link href="/chargers" className="flex min-h-[5.25rem] flex-col justify-center rounded-lg border border-transparent bg-neutral-500/5 p-3 transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]">
          <p className="text-xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{online}</p>
          <p className="text-xs text-neutral-500">Online</p>
        </Link>
        <Link href="/chargers" className="flex min-h-[5.25rem] flex-col justify-center rounded-lg border border-transparent bg-neutral-500/5 p-3 transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]">
          <p className={`text-xl font-semibold tabular-nums ${offline > 0 ? 'text-amber-600 dark:text-amber-500' : ''}`}>
            {offline}
          </p>
          <p className="text-xs text-neutral-500">Offline</p>
        </Link>
        <Link href="/chargers" className="flex min-h-[5.25rem] flex-col justify-center rounded-lg border border-transparent bg-neutral-500/5 p-3 transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]">
          <p className={`text-xl font-semibold tabular-nums ${fleet.chargersByStatus.faulted > 0 ? 'text-red-600 dark:text-red-500' : ''}`}>
            {fleet.chargersByStatus.faulted}
          </p>
          <p className="text-xs text-neutral-500">Faulted</p>
        </Link>
        <Link href="/chargers" className="flex min-h-[5.25rem] flex-col justify-center rounded-lg border border-transparent bg-neutral-500/5 p-3 transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]">
          <p className="text-xl font-semibold tabular-nums">{fleet.chargersByStatus.maintenance}</p>
          <p className="text-xs text-neutral-500">Maintenance</p>
        </Link>
      </div>

      <p className="mt-4 text-[11px] uppercase tracking-wide text-neutral-400">Connectors</p>
      <ul className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
        {Object.entries(connectors).map(([status, count]) => (
          <li key={status} className="flex items-baseline gap-1.5">
            <span className={`font-medium tabular-nums ${TONE_TEXT[statusTone(status)]}`}>{count}</span>
            <span className="text-neutral-500">{status}</span>
          </li>
        ))}
      </ul>

      {liveNote && (
        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-neutral-500">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
          {liveNote} · counts refresh on reload
        </p>
      )}
    </Panel>
  );
}
