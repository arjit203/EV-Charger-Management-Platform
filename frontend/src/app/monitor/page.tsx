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
 *
 * FILTERS COME IN TWO KINDS, and the split is the point:
 *
 *   SCOPE   company, station          -> sent to the SERVER. They decide which data is loaded at
 *                                        all, and they do not change while you watch.
 *   STATE   health, AC/DC, search     -> applied HERE, in memory. Health changes second to
 *                                        second: a charger that drops offline must jump into the
 *                                        "Offline" view the instant its event arrives, without a
 *                                        refetch. A server-side health filter would freeze the
 *                                        view at load time — the opposite of a live page.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { listStations } from '@/services/station.service';
import { CompanyFilter, FILTER_SELECT_CLASS, PowerTypeFilter } from '@/components/filters';
import type {
  Charger,
  ChargerHardwareStatus,
  ChargerType,
  ChargingSession,
  ConnectorStatus,
} from '@/types/api';

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

/**
 * The views an operations room actually switches between. "Needs attention" first: the whole
 * point of a live board is to surface the machines someone has to go and look at.
 */
type Health = 'all' | 'attention' | 'charging' | 'online' | 'offline' | 'faulted';

const HEALTH_LABELS: Record<Health, string> = {
  all: 'All',
  attention: 'Needs attention',
  charging: 'Charging',
  online: 'Online',
  offline: 'Offline',
  faulted: 'Faulted',
};

const CHARGER_LIMIT = 100;

// Stable empties, so the memoised views below do not recompute on every render while loading.
const NO_CHARGERS: Charger[] = [];
const NO_SESSIONS: ChargingSession[] = [];

function isFaulted(charger: Charger): boolean {
  return charger.hardwareStatus !== 'operative' || charger.status === 'faulted';
}

function matchesHealth(charger: Charger, health: Health, charging: Set<string>): boolean {
  switch (health) {
    case 'attention':
      return !charger.isOnline || isFaulted(charger);
    case 'charging':
      return charging.has(charger.id);
    case 'online':
      return charger.isOnline;
    case 'offline':
      return !charger.isOnline;
    case 'faulted':
      return isFaulted(charger);
    default:
      return true;
  }
}

function MonitorContent() {
  const { isConnected, reconnectCount } = useSocket();

  // SCOPE filters — sent to the server.
  const [companyId, setCompanyId] = useState('');
  const [stationId, setStationId] = useState('');
  // STATE filters — applied in memory, so live events move chargers between views instantly.
  const [health, setHealth] = useState<Health>('all');
  const [powerType, setPowerType] = useState<ChargerType | ''>('');
  const [search, setSearch] = useState('');

  const loadStations = useCallback(
    () => listStations({ limit: 100, companyId: companyId || undefined }),
    [companyId],
  );
  const { state: stationState } = useAsyncData(loadStations);

  const load = useCallback(async () => {
    const scope = { companyId: companyId || undefined, stationId: stationId || undefined };
    const [chargerPage, sessionPage] = await Promise.all([
      listChargers({ limit: CHARGER_LIMIT, ...scope }),
      listSessions({ active: true, limit: 50, ...scope }),
    ]);
    return { chargers: chargerPage.items, chargerTotal: chargerPage.total, sessions: sessionPage.items };
  }, [companyId, stationId]);

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
  const chargers = state.status === 'ok' ? state.data.chargers : NO_CHARGERS;
  const sessions = state.status === 'ok' ? state.data.sessions : NO_SESSIONS;

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
    // The socket delivers everything in the viewer's rooms. A session outside the chosen
    // company or station must not slip into a filtered board just because it started.
    if (companyId && session.companyId !== companyId) return;
    if (stationId && session.stationId !== stationId) return;

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

  /* ------------------------------------------------ derived, never stored ------ */

  const chargingIds = useMemo(() => new Set(sessions.map((s) => s.chargerId)), [sessions]);

  // Power type and search narrow the set the health chips count over.
  const narrowed = useMemo(() => {
    const term = search.trim().toLowerCase();
    return chargers.filter(
      (charger) =>
        (!powerType || charger.chargerType === powerType) &&
        (!term ||
          charger.name.toLowerCase().includes(term) ||
          charger.chargerCode.toLowerCase().includes(term) ||
          charger.ocppId.toLowerCase().includes(term)),
    );
  }, [chargers, powerType, search]);

  const healthCounts = useMemo(() => {
    const counts = {} as Record<Health, number>;
    for (const key of Object.keys(HEALTH_LABELS) as Health[]) {
      counts[key] = narrowed.filter((charger) => matchesHealth(charger, key, chargingIds)).length;
    }
    return counts;
  }, [narrowed, chargingIds]);

  const visibleChargers = narrowed.filter((charger) => matchesHealth(charger, health, chargingIds));
  const visibleChargerIds = new Set(narrowed.map((charger) => charger.id));
  const visibleSessions = sessions.filter(
    (session) =>
      (!powerType || session.chargerType === powerType) && visibleChargerIds.has(session.chargerId),
  );
  const liveConnectors = Object.values(connectors).filter((c) => visibleChargerIds.has(c.chargerId));
  const chargerTotal = state.status === 'ok' ? state.data.chargerTotal : 0;

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

      {/* ------------------------------------------------------------- filters */}
      <div className="mt-6 flex flex-wrap gap-3">
        <CompanyFilter
          value={companyId}
          onChange={(value) => {
            setCompanyId(value);
            setStationId(''); // a station from the previous company would match nothing
          }}
        />
        <select
          value={stationId}
          onChange={(event) => setStationId(event.target.value)}
          aria-label="Filter by station"
          disabled={stationState.status !== 'ok'}
          className={FILTER_SELECT_CLASS}
        >
          <option value="">All stations</option>
          {stationState.status === 'ok' &&
            stationState.data.items.map((station) => (
              <option key={station.id} value={station.id}>
                {station.name}
              </option>
            ))}
        </select>
        <PowerTypeFilter value={powerType} onChange={setPowerType} />
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Charger name, code or OCPP id"
          aria-label="Search chargers"
          className={`min-w-0 flex-1 ${FILTER_SELECT_CLASS}`}
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Filter by health">
        {(Object.keys(HEALTH_LABELS) as Health[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setHealth(key)}
            aria-pressed={health === key}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              health === key
                ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'border-neutral-300 hover:bg-neutral-500/10 dark:border-neutral-700'
            } ${key === 'attention' && healthCounts.attention > 0 && health !== key ? 'text-red-600 dark:text-red-400' : ''}`}
          >
            {HEALTH_LABELS[key]}
            {state.status === 'ok' && <span className="ml-1.5 tabular-nums opacity-70">{healthCounts[key]}</span>}
          </button>
        ))}
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
              Chargers ({visibleChargers.length})
            </h2>
            {chargerTotal > chargers.length && (
              <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">
                Watching the first {chargers.length} of {chargerTotal} chargers. Pick a station to
                narrow it down.
              </p>
            )}
            <div className="mt-3 space-y-2">
              {visibleChargers.length === 0 && (
                <p className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
                  {chargers.length === 0
                    ? 'No chargers yet.'
                    : health === 'attention'
                      ? 'Nothing needs attention right now.'
                      : 'No chargers match these filters.'}
                </p>
              )}
              {visibleChargers.map((charger) => (
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
                      {charger.chargerType} {charger.powerKw} kW
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
              Charging now ({visibleSessions.length})
            </h2>
            <div className="mt-3 space-y-2">
              {visibleSessions.length === 0 && (
                <p className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
                  Nothing charging right now.
                </p>
              )}
              {visibleSessions.map((session) => (
                <Link
                  key={session.id}
                  href={`/sessions/${session.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-200 p-4 transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] dark:border-neutral-800"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium tabular-nums">{formatEnergy(session)}</p>
                    <p className="mt-0.5 truncate text-xs text-neutral-500">
                      {session.companyName && `${session.companyName} · `}
                      connector {session.connectorNumber}
                      {session.connectorType && ` · ${session.connectorType}`}
                      {session.chargerType && ` · ${session.chargerType}`}
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
