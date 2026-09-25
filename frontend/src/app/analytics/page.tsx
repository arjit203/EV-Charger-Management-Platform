'use client';

/**
 * Module 13 — the analytics dashboard.
 *
 * Staff only. A driver has no route here at all: their "analytics" is their own charging
 * history, which `/sessions` has shown since Module 7, and a second page answering a
 * question already answered is surface without a feature.
 *
 * TWO KINDS OF NUMBER LIVE ON THIS PAGE, and they are labelled differently on purpose:
 *
 *   WINDOWED   sessions, energy, revenue, complaints filed — "in the last 30 days"
 *   SNAPSHOT   stations, chargers, connectors, active sessions, open complaints — "now"
 *
 * Mixing them silently is how a dashboard lies: a fleet count that quietly excluded chargers
 * installed before the window would be wrong in a way nobody would ever catch by looking.
 *
 * Charts are hand-rolled SVG — see `components/charts`. No charting library is installed and
 * none is added for this.
 */

import { useCallback, useMemo, useState } from 'react';

import { RequireAuth } from '@/components/RequireAuth';
import { BarChart, HorizontalBarChart } from '@/components/charts/BarChart';
import { LineChart } from '@/components/charts/LineChart';
import { useAuth } from '@/context/AuthContext';
import { useAsyncData } from '@/hooks/useAsyncData';
import { toMessage } from '@/lib/formatApiError';
import { formatPaise } from '@/lib/money';
import { listCompanies } from '@/services/company.service';
import {
  getOverview,
  getRevenueSeries,
  getSessionSeries,
  getTopStations,
} from '@/services/analytics.service';
import type {
  AnalyticsOverview,
  RevenueSeriesPayload,
  SessionSeriesPayload,
  StationAnalyticsPayload,
} from '@/types/api';

/* -------------------------------------------------------------------------- */
/* Dates — UTC, matching the server exactly                                   */
/* -------------------------------------------------------------------------- */

/**
 * The presets compute their dates in UTC because the SERVER's window is UTC.
 *
 * Using the browser's local date here would put a user in IST past 05:30 on a different
 * "today" from the one the API resolves, and the range they picked would quietly not be the
 * range they got. One timezone, end to end, and it is UTC.
 */
const MS_PER_DAY = 86_400_000;

function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  return utcDateKey(new Date(Date.now() - days * MS_PER_DAY));
}

/** Labels a `YYYY-MM-DD` key as "14 Sep" for a chart axis. */
function shortDate(key: string): string {
  return new Date(`${key}T00:00:00.000Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

const PRESETS = [
  { label: 'Today', days: 0 },
  { label: '7 days', days: 6 },
  { label: '30 days', days: 29 },
  { label: '90 days', days: 89 },
] as const;

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

function Card({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'default' | 'warn';
}) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-[var(--surface)] p-4 dark:border-neutral-800">
      <p className="text-xs uppercase tracking-wide text-neutral-500">{label}</p>
      <p
        className={`mt-1 text-2xl font-semibold tabular-nums ${
          tone === 'warn' ? 'text-amber-600 dark:text-amber-500' : ''
        }`}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-neutral-500">{sub}</p>}
    </div>
  );
}

function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-xl border border-neutral-200 bg-[var(--surface)] p-4 dark:border-neutral-800">
      <header className="mb-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {hint && <p className="text-xs text-neutral-500">{hint}</p>}
      </header>
      {children}
    </section>
  );
}

/** A status breakdown as a row of counts. Zero-valued statuses are shown, not hidden. */
function StatusRow({ counts }: { counts: Record<string, number> }) {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
      {Object.entries(counts).map(([status, count]) => (
        <li key={status} className="flex items-baseline gap-1.5">
          <span className="tabular-nums font-medium">{count}</span>
          <span className="text-neutral-500">{status.replace(/_/g, ' ')}</span>
        </li>
      ))}
    </ul>
  );
}

interface Loaded {
  overview: AnalyticsOverview;
  sessions: SessionSeriesPayload;
  stations: StationAnalyticsPayload;
  /** Null when the caller is an operator — the server never even ran the query. */
  revenue: RevenueSeriesPayload | null;
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

function AnalyticsDashboard() {
  const { user } = useAuth();

  const isPlatformAdmin = user?.role === 'super_admin';
  const canSeeRevenue = isPlatformAdmin || user?.role === 'cpo_admin';

  const [from, setFrom] = useState(() => daysAgo(29));
  const [to, setTo] = useState(() => daysAgo(0));
  const [companyId, setCompanyId] = useState('');

  /*
   * `companyId` is sent ONLY by a platform admin. A cpo_admin or operator sending it gets a
   * 422 rather than being silently rescoped — so the picker below is not merely hidden for
   * them, the parameter is never attached.
   */
  const params = useMemo(
    () => ({ from, to, ...(isPlatformAdmin && companyId ? { companyId } : {}) }),
    [from, to, companyId, isPlatformAdmin],
  );

  const load = useCallback(async (): Promise<Loaded> => {
    const [overview, sessions, stations, revenue] = await Promise.all([
      getOverview(params),
      getSessionSeries(params),
      getTopStations({ ...params, limit: 8 }),
      canSeeRevenue ? getRevenueSeries(params) : Promise.resolve(null),
    ]);

    return { overview, sessions, stations, revenue };
  }, [params, canSeeRevenue]);

  const { state } = useAsyncData(load);

  // Only a platform admin has a company to choose; everyone else is already scoped.
  const loadCompanies = useCallback(
    () => (isPlatformAdmin ? listCompanies({ limit: 100 }) : Promise.resolve(null)),
    [isPlatformAdmin],
  );
  const { state: companiesState } = useAsyncData(loadCompanies);

  const activePreset = PRESETS.find((p) => p.days === 0
    ? from === daysAgo(0) && to === daysAgo(0)
    : from === daysAgo(p.days) && to === daysAgo(0));

  function applyPreset(days: number) {
    setFrom(daysAgo(days));
    setTo(daysAgo(0));
  }

  return (
    <main className="page page-flow space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <p className="text-sm text-neutral-500">
            Sessions, energy and revenue. All dates are UTC and both ends are inclusive.
          </p>
        </div>
      </header>

      {/* ------------------------------------------------------------ filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-neutral-200 bg-[var(--surface)] p-4 dark:border-neutral-800">
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => applyPreset(preset.days)}
              className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                activePreset?.label === preset.label
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'border-neutral-300 hover:bg-neutral-500/10 dark:border-neutral-700'
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          From
          <input
            type="date"
            value={from}
            max={to}
            onChange={(event) => setFrom(event.target.value)}
            className="rounded-lg border border-neutral-300 bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          To
          <input
            type="date"
            value={to}
            min={from}
            onChange={(event) => setTo(event.target.value)}
            className="rounded-lg border border-neutral-300 bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
          />
        </label>

        {/* Platform admin only. A scoped caller has exactly one company and cannot ask. */}
        {isPlatformAdmin && (
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Company
            <select
              value={companyId}
              onChange={(event) => setCompanyId(event.target.value)}
              className="rounded-lg border border-neutral-300 bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
            >
              <option value="">All companies</option>
              {companiesState.status === 'ok' &&
                companiesState.data?.items.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
            </select>
          </label>
        )}
      </div>

      {state.status === 'loading' && <p className="text-sm text-neutral-500">Crunching numbers&hellip;</p>}

      {state.status === 'error' && (
        <p className="rounded-lg border border-red-300 bg-red-500/5 p-4 text-sm text-red-700 dark:border-red-900 dark:text-red-400">
          {toMessage(state.error)}
        </p>
      )}

      {state.status === 'ok' && (
        <Dashboard data={state.data} canSeeRevenue={canSeeRevenue} />
      )}
    </main>
  );
}

function Dashboard({ data, canSeeRevenue }: { data: Loaded; canSeeRevenue: boolean }) {
  const { overview, sessions, stations, revenue } = data;
  const { fleet } = overview;

  const windowLabel = `${overview.range.days} day${overview.range.days === 1 ? '' : 's'}`;

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------------- cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Card
          label="Stations"
          value={String(fleet.stations)}
          sub={`${fleet.chargers} chargers, ${fleet.connectors} connectors — now`}
        />
        <Card
          label="Chargers online"
          value={`${fleet.chargersOnline} / ${fleet.chargers}`}
          sub={fleet.chargersOffline > 0 ? `${fleet.chargersOffline} offline — now` : 'all connected — now'}
        />
        <Card
          label="Charging now"
          value={String(fleet.activeSessions)}
          sub="sessions occupying a connector"
        />
        <Card
          label="Sessions"
          value={String(overview.sessions.total)}
          sub={`in the last ${windowLabel}`}
        />
        <Card
          label="Energy delivered"
          value={`${overview.sessions.energyKwh.toLocaleString('en-IN')} kWh`}
          sub={`in the last ${windowLabel}`}
        />

        {/*
         * ABSENT, not zero, for an operator. `revenue === undefined` means "you may not see
         * this", which is a different statement from "nothing was earned" — so the card is
         * not rendered at all rather than rendered blank.
         */}
        {canSeeRevenue && overview.revenue && (
          <Card
            label="Revenue collected"
            value={formatPaise(overview.revenue.revenuePaise)}
            sub={`${overview.revenue.payments} payment${overview.revenue.payments === 1 ? '' : 's'} in the last ${windowLabel}`}
          />
        )}

        {canSeeRevenue && overview.revenue && overview.revenue.unpaidPaise > 0 && (
          <Card
            label="Awaiting payment"
            value={formatPaise(overview.revenue.unpaidPaise)}
            sub={`${overview.revenue.unpaidSessions} session${overview.revenue.unpaidSessions === 1 ? '' : 's'} delivered but not collected`}
            tone="warn"
          />
        )}

        <Card
          label="Open complaints"
          value={String(overview.complaints.openNow)}
          sub={`${overview.complaints.total} filed in the last ${windowLabel}`}
          tone={overview.complaints.openNow > 0 ? 'warn' : 'default'}
        />
      </div>

      {/* ------------------------------------------------------------ charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Sessions per day" hint="Counted on the day the charge STARTED.">
          <BarChart
            bars={sessions.points.map((point) => ({
              label: shortDate(point.date),
              value: point.sessions,
              display: `${point.sessions} session${point.sessions === 1 ? '' : 's'}`,
            }))}
            unit="sessions"
          />
        </Panel>

        <Panel title="Energy per day" hint="From each session's metered total, not raw meter readings.">
          <LineChart
            points={sessions.points.map((point) => ({
              label: shortDate(point.date),
              value: point.energyKwh,
              display: `${point.energyKwh} kWh`,
            }))}
          />
        </Panel>

        {canSeeRevenue && revenue && (
          <Panel
            title="Revenue per day"
            hint="Counted on the day the money MOVED — a charge settled later lands on the later day."
          >
            <LineChart
              colorClass="text-sky-600"
              points={revenue.points.map((point) => ({
                label: shortDate(point.date),
                value: point.revenuePaise,
                display: formatPaise(point.revenuePaise),
              }))}
            />
          </Panel>
        )}

        <Panel
          title="Busiest stations"
          hint={canSeeRevenue ? 'Ranked by revenue collected.' : 'Ranked by energy delivered.'}
        >
          <HorizontalBarChart
            bars={stations.stations.map((station) => ({
              label: station.name,
              value: canSeeRevenue ? (station.revenuePaise ?? 0) : station.energyWh,
              display: canSeeRevenue
                ? `${formatPaise(station.revenuePaise ?? 0)} · ${station.sessions} sessions`
                : `${station.energyKwh} kWh · ${station.sessions} sessions`,
            }))}
          />
        </Panel>
      </div>

      {/* ------------------------------------------------------- breakdowns */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Chargers right now" hint="A snapshot of this instant, not a rate over the window.">
          <StatusRow counts={fleet.chargersByStatus} />
          <p className="mt-3 text-xs text-neutral-500">
            Connector state
          </p>
          <div className="mt-1">
            <StatusRow counts={fleet.connectorsByStatus} />
          </div>
        </Panel>

        <Panel title={`Sessions by outcome — last ${windowLabel}`}>
          <StatusRow counts={overview.sessions.byStatus} />
          <p className="mt-3 text-xs text-neutral-500">Complaints filed</p>
          <div className="mt-1">
            <StatusRow counts={overview.complaints.byStatus} />
          </div>
        </Panel>
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  return (
    <RequireAuth roles={['super_admin', 'cpo_admin', 'operator']}>
      <AnalyticsDashboard />
    </RequireAuth>
  );
}
