'use client';

/**
 * Live operations dashboard — the first screen in this project that is genuinely real-time.
 *
 * Every previous screen fetched once and sat still. This one loads its state from REST, then
 * amends it in place as events arrive. The REST load is not redundant: events describe CHANGES,
 * so without a starting point there would be nothing to change.
 *
 * WHAT IT DOES NOT DO: filter for security. The server decides what reaches this socket — a
 * cpo_admin is in their company's room and no other, so another company's charger can never
 * appear here regardless of what this component renders.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import { RequireAuth } from '@/components/RequireAuth';
import { StatusBadge } from '@/components/StatusBadge';
import { SESSION_STATUS_LABELS, formatEnergy, sessionTone } from '@/components/SessionSummary';
import { useSocket } from '@/context/SocketContext';
import { useSocketEvent } from '@/hooks/useSocketEvent';
import { useAsyncData } from '@/hooks/useAsyncData';
import { toMessage } from '@/lib/formatApiError';
import { listChargers } from '@/services/charger.service';
import { listSessions } from '@/services/session.service';
import type { ChargerHardwareStatus, ChargingSession, ConnectorStatus } from '@/types/api';

interface ConnectorStatusEvent {
  connectorId: string;
  chargerId: string;
  connectorNumber: number;
  status: ConnectorStatus;
  errorCode: string | null;
}

interface ConnectivityEvent {
  chargerId: string;
  isOnline: boolean;
  lastHeartbeatAt: string | null;
}

/** The machine's own report about itself — OCPP connectorId 0, not any one plug. */
interface HardwareStatusEvent {
  chargerId: string;
  hardwareStatus: ChargerHardwareStatus;
  faultCode: string | null;
}

interface MeterUpdateEvent {
  sessionId: string;
  energyConsumedWh: number;
  energyConsumedKwh: number;
  powerKw: number | null;
}

/*
 * Connector tone now comes from the SHARED vocabulary in StatusBadge, not a local map.
 *
 * The local one said `charging` was amber — i.e. "needs attention" — while the dashboard
 * showed the same status blue. A charge in progress is not a warning, and the same word must
 * not be two colours on two screens.
 */

function MonitorContent() {
  const { isConnected, reconnectCount } = useSocket();

  const load = useCallback(
    async () => ({
      chargers: (await listChargers({ limit: 100 })).items,
      sessions: (await listSessions({ active: true, limit: 50 })).items,
    }),
    [],
  );

  const { state, reload, setData } = useAsyncData(load);

  /** connectorId -> live status, so a plug can update without refetching its charger. */
  const [connectors, setConnectors] = useState<Record<string, ConnectorStatusEvent>>({});
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);

  /*
   * There is ONE copy of the data: the one `useAsyncData` holds. Events amend it through
   * `setData`, rather than being mirrored into a second useState that an effect keeps in sync.
   * The mirror would have to be re-seeded on every reload, which means setState inside an
   * effect - a cascading render, and two copies that can disagree while the copy is pending.
   */
  const chargers = state.status === 'ok' ? state.data.chargers : [];
  const sessions = state.status === 'ok' ? state.data.sessions : [];

  /*
   * RECOVERY. Events sent while the browser was offline are gone — there is no replay. So on
   * every (re)connect we refetch REST state, which restores the truth in one request whether
   * the gap was two seconds or ten minutes. This also covers the very first connect, so the
   * normal path and the recovery path are the same code.
   */
  useEffect(() => {
    if (reconnectCount > 1) void reload();
  }, [reconnectCount, reload]);

  useSocketEvent<ConnectivityEvent>('charger:connectivityChanged', (event) => {
    if (state.status !== 'ok') return;

    setData({
      ...state.data,
      chargers: state.data.chargers.map((charger) =>
        charger.id === event.chargerId
          ? { ...charger, isOnline: event.isOnline, lastHeartbeatAt: event.lastHeartbeatAt }
          : charger,
      ),
    });
    setLastEventAt(new Date().toLocaleTimeString());
  });

  /*
   * A CHARGE POINT FAULTING IS THE EVENT THIS PAGE MOST NEEDS AND USED TO MISS ENTIRELY.
   * The gateway dropped connectorId 0 on the floor, so a machine could report itself broken
   * and this dashboard would keep showing it online and available until someone refreshed.
   */
  useSocketEvent<HardwareStatusEvent>('charger:hardwareStatusChanged', (event) => {
    if (state.status !== 'ok') return;

    setData({
      ...state.data,
      chargers: state.data.chargers.map((charger) =>
        charger.id === event.chargerId
          ? { ...charger, hardwareStatus: event.hardwareStatus, faultCode: event.faultCode }
          : charger,
      ),
    });
    setLastEventAt(new Date().toLocaleTimeString());
  });

  useSocketEvent<ConnectorStatusEvent>('connector:statusChanged', (event) => {
    setConnectors((current) => ({ ...current, [event.connectorId]: event }));
    setLastEventAt(new Date().toLocaleTimeString());
  });

  useSocketEvent<{ session: ChargingSession }>('session:statusChanged', ({ session }) => {
    if (state.status !== 'ok') return;

    const open = ['initiating', 'active', 'stopping'].includes(session.status);
    const without = state.data.sessions.filter((s) => s.id !== session.id);

    setData({
      ...state.data,
      // A finished session leaves the live list rather than lingering as a stale row.
      sessions: open ? [session, ...without] : without,
    });
    setLastEventAt(new Date().toLocaleTimeString());
  });

  useSocketEvent<MeterUpdateEvent>('session:meterUpdate', (event) => {
    if (state.status !== 'ok') return;

    setData({
      ...state.data,
      sessions: state.data.sessions.map((session) =>
        session.id === event.sessionId
          ? {
              ...session,
              energyConsumedWh: event.energyConsumedWh,
              energyConsumedKwh: event.energyConsumedKwh,
            }
          : session,
      ),
    });
    setLastEventAt(new Date().toLocaleTimeString());
  });

  const liveConnectors = Object.values(connectors);

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Live operations</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Updates arrive as they happen — this page never reloads itself.
          </p>
        </div>
        <div className="text-right">
          <StatusBadge
            tone={isConnected ? 'good' : 'warn'}
            label={isConnected ? 'live' : 'reconnecting…'}
          />
          {lastEventAt && (
            <p className="mt-1.5 text-[11px] tabular-nums text-neutral-500">last event {lastEventAt}</p>
          )}
        </div>
      </div>

      {state.status === 'loading' && <p className="mt-8 text-sm text-neutral-500">Loading…</p>}

      {state.status === 'error' && (
        <p className="mt-8 rounded-lg bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-400">
          {toMessage(state.error)}
        </p>
      )}

      {state.status === 'ok' && (
        <>
          <section className="mt-8">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-500">
              Chargers ({chargers.length})
            </h2>
            <div className="mt-3 space-y-2">
              {chargers.length === 0 && (
                <p className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
                  No chargers yet.
                </p>
              )}
              {chargers.map((charger) => (
                <Link
                  key={charger.id}
                  href={`/chargers/${charger.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-200 p-4 transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] dark:border-neutral-800"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{charger.name}</p>
                    <p className="mt-0.5 truncate text-xs text-neutral-500">
                      <span className="font-mono">{charger.chargerCode}</span>
                      {' · '}
                      {charger.powerKw} kW
                      {charger.lastHeartbeatAt
                        ? ` · beat ${new Date(charger.lastHeartbeatAt).toLocaleTimeString()}`
                        : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {charger.hardwareStatus !== 'operative' && (
                      <StatusBadge
                        tone="bad"
                        label={
                          charger.faultCode
                            ? `fault: ${charger.faultCode}`
                            : charger.hardwareStatus === 'faulted'
                              ? 'hardware fault'
                              : 'self-disabled'
                        }
                      />
                    )}
                    <StatusBadge
                      tone={charger.isOnline ? 'good' : 'neutral'}
                      label={charger.isOnline ? 'online' : 'offline'}
                    />
                  </div>
                </Link>
              ))}
            </div>
          </section>

          {liveConnectors.length > 0 && (
            <section className="mt-10">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-500">
                Connector activity
              </h2>
              <p className="mt-0.5 text-xs text-neutral-500">
                Reported by the hardware since this page opened.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {liveConnectors.map((connector) => (
                  <span
                    key={connector.connectorId}
                    className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-xs dark:border-neutral-800"
                  >
                    <span className="text-neutral-500">#{connector.connectorNumber}</span>
                    <StatusBadge status={connector.status} />
                    {connector.errorCode && (
                      <span className="text-red-600 dark:text-red-400">{connector.errorCode}</span>
                    )}
                  </span>
                ))}
              </div>
            </section>
          )}

          <section className="mt-10">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-500">
              Charging now ({sessions.length})
            </h2>
            <div className="mt-3 space-y-2">
              {sessions.length === 0 && (
                <p className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
                  Nothing charging right now.
                </p>
              )}
              {sessions.map((session) => (
                <Link
                  key={session.id}
                  href={`/sessions/${session.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-200 p-4 transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] dark:border-neutral-800"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium tabular-nums">{formatEnergy(session)}</p>
                    <p className="mt-0.5 truncate text-xs text-neutral-500">
                      connector {session.connectorNumber}
                      {session.transactionId !== null ? ` · txn ${session.transactionId}` : ''}
                    </p>
                  </div>
                  <StatusBadge
                    tone={sessionTone(session.status)}
                    label={SESSION_STATUS_LABELS[session.status]}
                  />
                </Link>
              ))}
            </div>
          </section>
        </>
      )}
    </main>
  );
}

export default function MonitorPage() {
  return (
    <RequireAuth roles={['super_admin', 'cpo_admin', 'operator']}>
      <MonitorContent />
    </RequireAuth>
  );
}
