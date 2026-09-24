'use client';

/**
 * Module 15 — the operations dashboard.
 *
 * This file is what the module exists to replace. Before now it was Module 1's placeholder —
 * a 2xl-wide column with a raw `companyId` dump, a future-tense list of what each role "will
 * be able to do", and eleven flat nav buttons that fourteen modules had each appended one line
 * to. All of that is gone for staff; the DRIVER's version is preserved verbatim in
 * `DriverHome`, which this page hands off to.
 *
 * ============================================================================
 * NOT ONE NUMBER ON THIS PAGE IS COMPUTED HERE.
 *
 * No revenue arithmetic, no energy summing, no cost calculation, no company
 * filtering. Every figure arrives already computed and already scoped by the
 * module that owns it — Module 13 for aggregates, Module 7 for sessions,
 * Modules 10 and 11 for the activity feed.
 *
 * The dashboard decides LAYOUT and EMPHASIS. The backend decides VALUES and
 * VISIBILITY. A component that computes a total is one that can disagree with
 * the ledger.
 * ============================================================================
 *
 * THE OPERATOR NEEDS NO SPECIAL CASE. Module 13 already made `/analytics/overview` OMIT the
 * `revenue` key for operators — not zero it, omit it — and never run the query. So
 * `{revenue && <StatCard/>}` is the entire mechanism, and the authorisation boundary is the
 * one Module 13 built and tested three modules ago.
 */

import { useCallback } from 'react';
import Link from 'next/link';

import { RequireAuth } from '@/components/RequireAuth';
import { DriverHome } from '@/components/dashboard/DriverHome';
import { ActiveSessions } from '@/components/dashboard/ActiveSessions';
import { FleetStatus } from '@/components/dashboard/FleetStatus';
import {
  RecentActivity,
  buildActivity,
  type ActivityItem,
} from '@/components/dashboard/RecentActivity';
import {
  EmptyState,
  ErrorState,
  Panel,
  Skeleton,
  SkeletonRows,
  StatCard,
} from '@/components/dashboard/primitives';
import { BarChart } from '@/components/charts/BarChart';
import { useAuth } from '@/context/AuthContext';
import { useAsyncData } from '@/hooks/useAsyncData';
import { toMessage } from '@/lib/formatApiError';
import { formatPaise } from '@/lib/money';
import {
  getOverview,
  getRevenueSeries,
  getSessionSeries,
  getTopStations,
} from '@/services/analytics.service';
import { listSessions } from '@/services/session.service';
import { listComplaints } from '@/services/complaint.service';
import { listPayments } from '@/services/wallet.service';
import type {
  AnalyticsOverview,
  ChargingSession,
  DailyPoint,
  DailyRevenuePoint,
  PaymentTransaction,
  StationBreakdown,
} from '@/types/api';

interface DashboardData {
  overview: AnalyticsOverview;
  sessionSeries: DailyPoint[];
  revenueSeries: DailyRevenuePoint[] | null;
  topStations: StationBreakdown[];
  active: ChargingSession[];
  activity: ActivityItem[];
}

function OperationsDashboard() {
  const { user } = useAuth();
  const canSeeRevenue = user?.role === 'super_admin' || user?.role === 'cpo_admin';

  /*
   * ONE PARALLEL FETCH OF ENDPOINTS THAT ALREADY EXIST. No new endpoint, and no giant
   * "everything" aggregate invented for the dashboard's convenience — each call belongs to
   * the module that owns that data, and each is already company-scoped server-side.
   *
   * `Promise.all` rather than a waterfall: none of these depends on another, so sequencing
   * them would make the page as slow as their sum instead of as slow as the slowest.
   */
  const load = useCallback(async (): Promise<DashboardData> => {
    const [
      overview,
      sessionSeries,
      revenueSeries,
      topStations,
      activePage,
      recentSessions,
      complaints,
      payments,
    ] = await Promise.all([
      getOverview(),
      getSessionSeries(),
      // Not merely hidden from an operator — never requested. The server would 403 it.
      canSeeRevenue ? getRevenueSeries() : Promise.resolve(null),
      getTopStations({ limit: 5 }),
      listSessions({ active: true, limit: 10 }),
      listSessions({ limit: 8 }),
      listComplaints({ limit: 5 }),
      canSeeRevenue ? listPayments(1, 5) : Promise.resolve({ items: [] as PaymentTransaction[] }),
    ]);

    return {
      overview,
      sessionSeries: sessionSeries.points,
      revenueSeries: revenueSeries?.points ?? null,
      topStations: topStations.stations,
      active: activePage.items,
      activity: buildActivity(recentSessions.items, complaints.items, payments.items, canSeeRevenue),
    };
  }, [canSeeRevenue]);

  const { state, reload } = useAsyncData(load);

  if (state.status === 'error') {
    return (
      <div className="p-4 sm:p-6">
        <ErrorState message={toMessage(state.error)} onRetry={() => void reload()} />
      </div>
    );
  }

  if (state.status === 'loading') {
    return (
      <div className="space-y-4 p-4 sm:p-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
        <SkeletonRows rows={4} />
      </div>
    );
  }

  const { overview, sessionSeries, revenueSeries, topStations, active, activity } = state.data;
  const { fleet, sessions, complaints, revenue } = overview;

  /*
   * "Today" is the LAST POINT of Module 13's daily series. That module zero-fills every day in
   * the window, so today is always present — reading it here avoids a second windowed request
   * for a single number, and cannot disagree with the chart drawn from the same array.
   */
  const today = sessionSeries[sessionSeries.length - 1];
  const todayRevenue = revenueSeries?.[revenueSeries.length - 1];
  const windowLabel = `last ${overview.range.days} days`;

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {/* ------------------------------------------------------------- cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Charging now"
          value={String(fleet.activeSessions)}
          sub="sessions in progress"
          href="/monitor"
        />
        <StatCard
          label="Sessions today"
          value={String(today?.sessions ?? 0)}
          sub={`${sessions.total} in the ${windowLabel}`}
          href="/sessions"
        />
        <StatCard
          label="Energy today"
          value={`${today?.energyKwh ?? 0} kWh`}
          sub={`${sessions.energyKwh.toLocaleString()} kWh in the ${windowLabel}`}
        />

        {/*
          * ABSENT for an operator, because the KEY is absent from the payload. There is no
          * role check here — the shape IS the permission, decided by Module 13.
          */}
        {revenue && (
          <StatCard
            label="Revenue today"
            value={formatPaise(todayRevenue?.revenuePaise ?? 0)}
            sub={`${formatPaise(revenue.revenuePaise)} in the ${windowLabel}`}
            href="/payments"
          />
        )}

        <StatCard
          label="Stations"
          value={String(fleet.stations)}
          sub="on your network"
          href="/stations"
        />
        <StatCard
          label="Chargers"
          value={String(fleet.chargers)}
          sub={`${fleet.connectors} connectors`}
          href="/chargers"
        />
        <StatCard
          label="Open complaints"
          value={String(complaints.openNow)}
          sub={`${complaints.total} filed in the ${windowLabel}`}
          href="/complaints"
          tone={complaints.openNow > 0 ? 'warn' : 'default'}
        />

        {revenue && revenue.unpaidPaise > 0 && (
          <StatCard
            label="Awaiting payment"
            value={formatPaise(revenue.unpaidPaise)}
            sub={`${revenue.unpaidSessions} delivered but uncollected`}
            href="/sessions"
            tone="warn"
          />
        )}
      </div>

      {/* ------------------------------------------------------ live sections */}
      <div className="grid gap-4 xl:grid-cols-2">
        <FleetStatus fleet={fleet} />
        <ActiveSessions initial={active} />
      </div>

      {/* --------------------------------------------------- insight sections */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel
          title={`Sessions · ${windowLabel}`}
          action={{ href: '/analytics', label: 'Analytics →' }}
        >
          <BarChart
            bars={sessionSeries.map((point) => ({
              label: point.date.slice(5),
              value: point.sessions,
              display: `${point.sessions} session${point.sessions === 1 ? '' : 's'}`,
            }))}
            emptyMessage="No sessions in this period."
          />
        </Panel>

        <Panel title="Busiest stations" action={{ href: '/analytics', label: 'Full breakdown →' }}>
          {topStations.length === 0 ? (
            <EmptyState message="No station activity yet." />
          ) : (
            <ul className="space-y-2">
              {topStations.map((station) => (
                <li
                  key={station.stationId}
                  className="flex items-baseline justify-between gap-3 text-sm"
                >
                  <Link
                    href={`/stations/${station.stationId}`}
                    className="min-w-0 flex-1 truncate underline underline-offset-2"
                  >
                    {station.name}
                  </Link>
                  <span className="shrink-0 tabular-nums text-neutral-500">
                    {station.revenuePaise !== undefined
                      ? formatPaise(station.revenuePaise)
                      : `${station.energyKwh} kWh`}
                    {' · '}
                    {station.sessions} sessions
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <RecentActivity items={activity} />

        {/*
          * The map is a NAVIGATION CARD, not an embedded Leaflet instance. Module 14 had to
          * isolate Leaflet behind `next/dynamic` with `ssr: false`, and the build caught a real
          * bug when a static import defeated that boundary. Reproducing that hazard for a
          * thumbnail is not a trade worth making.
          */}
        <Panel title="Network map" action={{ href: '/map', label: 'View full map →' }}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-2xl font-semibold tabular-nums">{fleet.stations}</p>
              <p className="text-xs text-neutral-500">
                stations · {fleet.chargers} chargers · {fleet.chargersOnline} online
              </p>
            </div>
            <Link
              href="/map"
              className="rounded-lg border border-neutral-300 px-3 py-2 text-sm transition-colors hover:bg-neutral-500/10 dark:border-neutral-700"
            >
              Open map
            </Link>
          </div>
        </Panel>
      </div>
    </div>
  );
}

/**
 * The role branch.
 *
 * A driver gets their own page, unchanged. `AppShell` independently renders no sidebar for
 * them, so their experience is exactly what it was before this module.
 */
function DashboardRouter() {
  const { user } = useAuth();
  if (!user) return null; // RequireAuth guarantees this; TypeScript cannot know it.

  return user.role === 'driver' ? <DriverHome /> : <OperationsDashboard />;
}

export default function DashboardPage() {
  return (
    <RequireAuth>
      <DashboardRouter />
    </RequireAuth>
  );
}
