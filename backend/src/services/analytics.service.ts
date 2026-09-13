/**
 * Analytics — the first service in this project that only READS.
 *
 * It owns no collection, defines no state machine, emits nothing and writes nothing. Every
 * number it returns is derived from rows Modules 4-11 already wrote. That makes its risks
 * different from every module before it: nothing here can corrupt data, and everything here
 * can MISREPORT it. A wrong number on a dashboard is believed.
 *
 * So the discipline in this file is about sources, not safety:
 *
 *   - revenue comes from PAID `session_debit` payments (see `REVENUE_MATCH`), never from
 *     every paid payment, because a wallet recharge is a deposit and not a sale;
 *   - energy comes from `ChargingSession.energyConsumedWh`, never from summing the
 *     cumulative meter readings that produced it;
 *   - sessions and energy are anchored on `startedAt`, revenue on `paidAt`, because Module
 *     10 deliberately allows those to fall on different days;
 *   - every aggregation is DEFAULTED, because `$group` over an empty match returns no
 *     documents at all - not a zero - and a fresh company must read 0, never `null`.
 *
 * THE SCOPING RULE IS UNCHANGED: `applyCompanyScope` is the FIRST stage of every pipeline.
 * `companyId` denormalised onto sessions (Module 7) and payments (Module 10) is what lets a
 * `$match` do the scoping directly instead of a `$lookup` across three collections - this is
 * the module those denormalisations were argued for.
 *
 * D3 - LIVE QUERIES. NO CACHE, NO ROLLUP COLLECTION, NO BACKGROUND JOB. Same reasoning as
 * every other deferral in this project: a rollup buys speed this dataset does not need, and
 * pays for it with a second source of truth that can silently drift from the first. The
 * trigger for revisiting is a MEASUREMENT, not a guess - when an overview query on a
 * realistic dataset stops returning fast enough to feel instant.
 */

import { Types } from 'mongoose';

import { Charger } from '../models/charger.model';
import { ChargingSession } from '../models/chargingSession.model';
import { Company } from '../models/company.model';
import { Complaint } from '../models/complaint.model';
import { Connector } from '../models/connector.model';
import { PaymentTransaction } from '../models/paymentTransaction.model';
import { Station } from '../models/station.model';

import { DEFAULT_TOP_STATIONS, MAX_RANGE_DAYS, REVENUE_MATCH } from '../constants/analytics';
import { CHARGER_STATUSES, type ChargerStatus } from '../constants/charger';
import { COMPLAINT_STATUSES, type ComplaintStatus } from '../constants/complaint';
import { CONNECTOR_STATUSES, type ConnectorStatus } from '../constants/connector';
import { ROLES } from '../constants/roles';
import { OPEN_SESSION_STATUSES, SESSION_STATUSES, type SessionStatus } from '../constants/session';

import { ApiError } from '../utils/ApiError';
import { applyCompanyScope } from '../utils/companyScope';
import { daysInRange, eachUtcDay, resolveRange, type DateRange } from '../utils/dateRange';
import { paiseToRupees } from '../utils/money';

import type { AuthUser } from '../types/express';
import type { AnalyticsRangeQuery, TopStationsQuery } from '../validators/analytics.validator';

/* -------------------------------------------------------------------------- */
/* Scope                                                                      */
/* -------------------------------------------------------------------------- */

/** The `companyId` constraint, or `{}` for an unscoped platform admin. */
type CompanyFilter = { companyId?: Types.ObjectId };

interface AnalyticsScope {
  companyFilter: CompanyFilter;
  range: DateRange;
}

/**
 * Can this caller see money?
 *
 * OPERATOR IS NARROWER THAN CPO_ADMIN, and this is where that difference is drawn. An
 * operator runs hardware: they need to know what is charging, what is faulted and what has
 * been complained about. A company's income is not operational data, and every earlier
 * module resolved the same hedge the same way - Modules 5 and 9 both made the operator
 * read-only precisely where commercial decisions live.
 */
export function canSeeRevenue(actor: AuthUser): boolean {
  return actor.role === ROLES.SUPER_ADMIN || actor.role === ROLES.CPO_ADMIN;
}

/**
 * Resolve the caller's window and the company constraint that goes in front of every
 * pipeline.
 *
 * A company-scoped caller naming a `companyId` is REJECTED, not silently overridden. The
 * cost of ignoring it is higher here than anywhere else in the project: for a write, a
 * dropped field means the row lands in the right place anyway; for a READ, it means a
 * cpo_admin who believes they are looking at a rival's revenue is shown their own, with
 * nothing on screen to say so. Module 9 established the rule - a dropped field looks like
 * success - and a misattributed chart is the worst version of it.
 */
async function resolveScope(actor: AuthUser, query: AnalyticsRangeQuery): Promise<AnalyticsScope> {
  const range = resolveRange(query.from, query.to);

  if (daysInRange(range) > MAX_RANGE_DAYS) {
    throw ApiError.badRequest(`A range may cover at most ${MAX_RANGE_DAYS} days.`);
  }

  if (actor.role === ROLES.SUPER_ADMIN) {
    if (!query.companyId) return { companyFilter: {}, range };

    // Verified rather than trusted: an id that matches no company would otherwise return a
    // confident wall of zeros, which reads as "this CPO earned nothing" rather than "typo".
    const company = await Company.findById(query.companyId).select('_id');
    if (!company) throw ApiError.notFound('Company not found.');

    return { companyFilter: { companyId: company._id }, range };
  }

  if (query.companyId) {
    throw ApiError.validation(
      'companyId cannot be set: analytics always cover your own company.',
      { field: 'companyId' },
    );
  }

  // Throws 403 if a company-scoped role somehow has no company - fails closed, as always.
  return { companyFilter: applyCompanyScope(actor, {}) as CompanyFilter, range };
}

/* -------------------------------------------------------------------------- */
/* Zero-filling helpers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every status in an enum, mapped to 0.
 *
 * THE MOST LIKELY WAY THIS MODULE BREAKS ON A FRESH DATABASE. `$group` over a match that
 * hits nothing returns an EMPTY ARRAY - not a document containing zero - so a response
 * built straight from the result is missing keys entirely and the frontend renders
 * `undefined`. Starting from a fully-zeroed record and overwriting what the database
 * actually returned means a brand-new company reads 0 everywhere, which is true, instead of
 * blank, which is not an answer.
 */
function zeroedByStatus<T extends string>(statuses: readonly T[]): Record<T, number> {
  return Object.fromEntries(statuses.map((status) => [status, 0])) as Record<T, number>;
}

/** Watt-hours -> kWh for display. Three decimals: a 5 Wh charge should not read as 0. */
function toKwh(energyWh: number): number {
  return Number((energyWh / 1000).toFixed(3));
}

/* -------------------------------------------------------------------------- */
/* Public shapes                                                              */
/* -------------------------------------------------------------------------- */

export interface FleetSnapshot {
  stations: number;
  chargers: number;
  chargersOnline: number;
  chargersOffline: number;
  chargersByStatus: Record<ChargerStatus, number>;
  connectors: number;
  connectorsByStatus: Record<ConnectorStatus, number>;
  /** Sessions occupying a connector RIGHT NOW. A snapshot, not a count over the window. */
  activeSessions: number;
}

export interface SessionTotals {
  total: number;
  byStatus: Record<SessionStatus, number>;
  energyWh: number;
  energyKwh: number;
}

export interface RevenueTotals {
  revenuePaise: number;
  revenueRupees: number;
  payments: number;
  /** Electricity delivered but not yet collected - Module 10's failure path, in money. */
  unpaidSessions: number;
  unpaidPaise: number;
  unpaidRupees: number;
}

export interface ComplaintTotals {
  total: number;
  byStatus: Record<ComplaintStatus, number>;
  /** Open or in progress RIGHT NOW, whatever day they were filed. A snapshot. */
  openNow: number;
}

export interface AnalyticsOverview {
  range: { from: string; to: string; days: number };
  fleet: FleetSnapshot;
  sessions: SessionTotals;
  /** ABSENT for an operator. Not null - the key is missing because they may not see it. */
  revenue?: RevenueTotals;
  complaints: ComplaintTotals;
}

export interface DailyPoint {
  date: string;
  sessions: number;
  energyWh: number;
  energyKwh: number;
}

export interface DailyRevenuePoint {
  date: string;
  revenuePaise: number;
  revenueRupees: number;
  payments: number;
}

export interface StationBreakdown {
  stationId: string;
  name: string;
  stationCode: string;
  sessions: number;
  energyWh: number;
  energyKwh: number;
  /** ABSENT for an operator, for the same reason as `AnalyticsOverview.revenue`. */
  revenuePaise?: number;
  revenueRupees?: number;
}

/* -------------------------------------------------------------------------- */
/* Building blocks — one concern each, reused by the endpoints below          */
/* -------------------------------------------------------------------------- */

/**
 * The fleet, as it stands RIGHT NOW.
 *
 * DELIBERATELY NOT DATE-FILTERED, and that is the D6 decision in code: this is a snapshot
 * of the present, not a rate over the window. Charger utilisation - busy time over total
 * time - is not built at all, because every session in this project is triggered by hand
 * and a utilisation figure computed from staged traffic would be a meaningless number
 * wearing the costume of a metric.
 */
async function getFleetSnapshot(scope: AnalyticsScope): Promise<FleetSnapshot> {
  const { companyFilter } = scope;

  const [stations, chargerRows, connectorRows, activeSessions] = await Promise.all([
    Station.countDocuments(companyFilter),

    Charger.aggregate<{ _id: ChargerStatus; count: number; online: number }>([
      { $match: companyFilter },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          online: { $sum: { $cond: ['$isOnline', 1, 0] } },
        },
      },
    ]),

    /*
     * Connectors carry no `companyId` - they hang off a charger (Module 5's decision: a
     * connector is a part of a machine, not an independently owned thing). So the pipeline
     * STARTS at Charger, where the scope filter can use the `{ companyId, status }` index,
     * and reaches connectors through it. Starting at Connector would mean scoping after the
     * join, which is the fetch-then-filter shape this project does not allow.
     */
    Charger.aggregate<{ _id: ConnectorStatus; count: number }>([
      { $match: companyFilter },
      {
        $lookup: {
          from: Connector.collection.name,
          localField: '_id',
          foreignField: 'chargerId',
          as: 'connectors',
        },
      },
      { $unwind: '$connectors' },
      { $group: { _id: '$connectors.status', count: { $sum: 1 } } },
    ]),

    ChargingSession.countDocuments({
      ...companyFilter,
      status: { $in: OPEN_SESSION_STATUSES },
    }),
  ]);

  const chargersByStatus = zeroedByStatus(CHARGER_STATUSES);
  let chargers = 0;
  let chargersOnline = 0;

  for (const row of chargerRows) {
    chargersByStatus[row._id] = row.count;
    chargers += row.count;
    chargersOnline += row.online;
  }

  const connectorsByStatus = zeroedByStatus(CONNECTOR_STATUSES);
  let connectors = 0;

  for (const row of connectorRows) {
    connectorsByStatus[row._id] = row.count;
    connectors += row.count;
  }

  return {
    stations,
    chargers,
    chargersOnline,
    chargersOffline: chargers - chargersOnline,
    chargersByStatus,
    connectors,
    connectorsByStatus,
    activeSessions,
  };
}

/**
 * Sessions and energy over the window, in ONE pass.
 *
 * They are not split into two functions because they are the same documents grouped the
 * same way - counting them twice would run an identical pipeline to read a second field.
 *
 * Matching on `startedAt` also does a second, useful job for free: it excludes sessions
 * that never started. An `initiating` session the charger never confirmed has
 * `startedAt: null`, delivered nothing, and has no business in a count of charges.
 *
 * D2 in one line: `$sum: '$energyConsumedWh'`. MeterReading is never summed here - those
 * are cumulative counters, and adding them up multiplies the answer by how chatty the
 * charger happens to be.
 */
async function getSessionTotals(scope: AnalyticsScope): Promise<SessionTotals> {
  const rows = await ChargingSession.aggregate<{
    _id: SessionStatus;
    count: number;
    energyWh: number;
  }>([
    {
      $match: {
        ...scope.companyFilter,
        startedAt: { $gte: scope.range.from, $lte: scope.range.to },
      },
    },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        energyWh: { $sum: '$energyConsumedWh' },
      },
    },
  ]);

  const byStatus = zeroedByStatus(SESSION_STATUSES);
  let total = 0;
  let energyWh = 0;

  for (const row of rows) {
    byStatus[row._id] = row.count;
    total += row.count;
    energyWh += row.energyWh;
  }

  return { total, byStatus, energyWh, energyKwh: toKwh(energyWh) };
}

/**
 * Money collected over the window, plus money still owed.
 *
 * D1 lives in `REVENUE_MATCH`: paid `session_debit` payments only. A `wallet_recharge` is a
 * driver putting money ON DEPOSIT - the platform now owes them electricity - and counting it
 * as revenue means a Rs500 top-up followed by a Rs60 charge reports Rs560 earned against
 * Rs60 actually sold.
 *
 * The filter is easy to think is redundant, because recharges carry `companyId: null` and a
 * company-scoped caller's filter already excludes them. It is not redundant: super_admin has
 * no company filter at all, so for the one caller who sees the whole platform, this line is
 * the entire difference between a real number and an inflated one.
 *
 * `unpaid` is anchored on `startedAt` rather than `paidAt` for the obvious reason - money
 * that was never collected has no payment date.
 */
async function getRevenueTotals(scope: AnalyticsScope): Promise<RevenueTotals> {
  const [paidRows, unpaidRows] = await Promise.all([
    PaymentTransaction.aggregate<{ _id: null; revenuePaise: number; payments: number }>([
      {
        $match: {
          ...scope.companyFilter,
          ...REVENUE_MATCH,
          paidAt: { $gte: scope.range.from, $lte: scope.range.to },
        },
      },
      { $group: { _id: null, revenuePaise: { $sum: '$amountPaise' }, payments: { $sum: 1 } } },
    ]),

    ChargingSession.aggregate<{ _id: null; unpaidPaise: number; unpaidSessions: number }>([
      {
        $match: {
          ...scope.companyFilter,
          paymentStatus: 'unpaid',
          amountPaise: { $ne: null },
          startedAt: { $gte: scope.range.from, $lte: scope.range.to },
        },
      },
      { $group: { _id: null, unpaidPaise: { $sum: '$amountPaise' }, unpaidSessions: { $sum: 1 } } },
    ]),
  ]);

  // `?? 0` is not defensive noise - an empty match yields NO row, so this is the normal
  // path for any company that has not sold anything yet.
  const revenuePaise = paidRows[0]?.revenuePaise ?? 0;
  const unpaidPaise = unpaidRows[0]?.unpaidPaise ?? 0;

  return {
    revenuePaise,
    revenueRupees: paiseToRupees(revenuePaise),
    payments: paidRows[0]?.payments ?? 0,
    unpaidSessions: unpaidRows[0]?.unpaidSessions ?? 0,
    unpaidPaise,
    unpaidRupees: paiseToRupees(unpaidPaise),
  };
}

/** Complaints filed in the window, plus how many are outstanding right now. */
async function getComplaintTotals(scope: AnalyticsScope): Promise<ComplaintTotals> {
  const [rows, openNow] = await Promise.all([
    Complaint.aggregate<{ _id: ComplaintStatus; count: number }>([
      {
        $match: {
          ...scope.companyFilter,
          createdAt: { $gte: scope.range.from, $lte: scope.range.to },
        },
      },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),

    /*
     * NOT date-filtered, on purpose, and labelled `openNow` so the two cannot be confused.
     * A ticket filed two months ago and still open is exactly what an operations dashboard
     * needs to surface, and a window of the last 30 days would hide it.
     */
    Complaint.countDocuments({
      ...scope.companyFilter,
      status: { $in: ['open', 'in_progress'] },
    }),
  ]);

  const byStatus = zeroedByStatus(COMPLAINT_STATUSES);
  let total = 0;

  for (const row of rows) {
    byStatus[row._id] = row.count;
    total += row.count;
  }

  return { total, byStatus, openNow };
}

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                  */
/* -------------------------------------------------------------------------- */

/** GET /analytics/overview — the summary cards, in one round trip. */
export async function getOverview(
  actor: AuthUser,
  query: AnalyticsRangeQuery,
): Promise<AnalyticsOverview> {
  const scope = await resolveScope(actor, query);
  const showRevenue = canSeeRevenue(actor);

  const [fleet, sessions, complaints, revenue] = await Promise.all([
    getFleetSnapshot(scope),
    getSessionTotals(scope),
    getComplaintTotals(scope),
    // Not merely hidden from the response - NOT QUERIED. An operator's request never asks
    // the database about money in the first place.
    showRevenue ? getRevenueTotals(scope) : Promise.resolve(undefined),
  ]);

  return {
    range: {
      from: scope.range.from.toISOString(),
      to: scope.range.to.toISOString(),
      days: daysInRange(scope.range),
    },
    fleet,
    sessions,
    complaints,
    ...(revenue ? { revenue } : {}),
  };
}

/**
 * GET /analytics/sessions — sessions and energy per day.
 *
 * Zero-filled across the whole window. See `eachUtcDay`: an aggregation returns only days
 * that had rows, and a chart drawn from that alone silently closes the gaps, turning three
 * sessions scattered over a fortnight into three adjacent bars that look like a busy week.
 */
export async function getSessionSeries(
  actor: AuthUser,
  query: AnalyticsRangeQuery,
): Promise<{ range: { from: string; to: string }; points: DailyPoint[]; totals: SessionTotals }> {
  const scope = await resolveScope(actor, query);

  const [rows, totals] = await Promise.all([
    ChargingSession.aggregate<{ _id: string; sessions: number; energyWh: number }>([
      {
        $match: {
          ...scope.companyFilter,
          startedAt: { $gte: scope.range.from, $lte: scope.range.to },
        },
      },
      {
        $group: {
          // `timezone: 'UTC'` is explicit rather than relied upon. The default happens to be
          // UTC, and a default that decides which DAY a charge belongs to deserves to be
          // written down where someone reading the pipeline can see it.
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt', timezone: 'UTC' } },
          sessions: { $sum: 1 },
          energyWh: { $sum: '$energyConsumedWh' },
        },
      },
    ]),
    getSessionTotals(scope),
  ]);

  const byDate = new Map(rows.map((row) => [row._id, row]));

  const points: DailyPoint[] = eachUtcDay(scope.range).map((date) => {
    const row = byDate.get(date);
    const energyWh = row?.energyWh ?? 0;
    return { date, sessions: row?.sessions ?? 0, energyWh, energyKwh: toKwh(energyWh) };
  });

  return {
    range: { from: scope.range.from.toISOString(), to: scope.range.to.toISOString() },
    points,
    totals,
  };
}

/** GET /analytics/revenue — money collected per day. cpo_admin and super_admin only. */
export async function getRevenueSeries(
  actor: AuthUser,
  query: AnalyticsRangeQuery,
): Promise<{
  range: { from: string; to: string };
  points: DailyRevenuePoint[];
  totals: RevenueTotals;
}> {
  const scope = await resolveScope(actor, query);

  const [rows, totals] = await Promise.all([
    PaymentTransaction.aggregate<{ _id: string; revenuePaise: number; payments: number }>([
      {
        $match: {
          ...scope.companyFilter,
          ...REVENUE_MATCH,
          paidAt: { $gte: scope.range.from, $lte: scope.range.to },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$paidAt', timezone: 'UTC' } },
          revenuePaise: { $sum: '$amountPaise' },
          payments: { $sum: 1 },
        },
      },
    ]),
    getRevenueTotals(scope),
  ]);

  const byDate = new Map(rows.map((row) => [row._id, row]));

  const points: DailyRevenuePoint[] = eachUtcDay(scope.range).map((date) => {
    const revenuePaise = byDate.get(date)?.revenuePaise ?? 0;
    return {
      date,
      revenuePaise,
      revenueRupees: paiseToRupees(revenuePaise),
      payments: byDate.get(date)?.payments ?? 0,
    };
  });

  return {
    range: { from: scope.range.from.toISOString(), to: scope.range.to.toISOString() },
    points,
    totals,
  };
}

/**
 * GET /analytics/stations — the busiest stations in the window.
 *
 * Two aggregations rather than one, merged in memory, because the two facts live in
 * different collections and are anchored on different dates:
 *
 *   sessions + energy   ChargingSession, by `startedAt`, which carries `stationId`
 *   revenue             PaymentTransaction, by `paidAt`, which does NOT
 *
 * A payment knows its session, not its station, so per-station revenue reaches `stationId`
 * through a `$lookup` on the session. Keeping the revenue side rooted in PaymentTransaction
 * matters more than the convenience of one pipeline: summing `ChargingSession.amountPaise`
 * for paid sessions would be a SECOND definition of revenue, and the moment two definitions
 * exist they are one bug away from disagreeing. There is one, and it is `REVENUE_MATCH`.
 */
export async function getTopStations(
  actor: AuthUser,
  query: TopStationsQuery,
): Promise<{ range: { from: string; to: string }; stations: StationBreakdown[] }> {
  const scope = await resolveScope(actor, query);
  const limit = query.limit ?? DEFAULT_TOP_STATIONS;
  const showRevenue = canSeeRevenue(actor);

  const [usageRows, revenueRows] = await Promise.all([
    ChargingSession.aggregate<{ _id: Types.ObjectId; sessions: number; energyWh: number }>([
      {
        $match: {
          ...scope.companyFilter,
          startedAt: { $gte: scope.range.from, $lte: scope.range.to },
        },
      },
      {
        $group: {
          _id: '$stationId',
          sessions: { $sum: 1 },
          energyWh: { $sum: '$energyConsumedWh' },
        },
      },
    ]),

    showRevenue
      ? PaymentTransaction.aggregate<{ _id: Types.ObjectId; revenuePaise: number }>([
          {
            $match: {
              ...scope.companyFilter,
              ...REVENUE_MATCH,
              paidAt: { $gte: scope.range.from, $lte: scope.range.to },
            },
          },
          {
            $lookup: {
              from: ChargingSession.collection.name,
              localField: 'chargingSessionId',
              foreignField: '_id',
              as: 'session',
            },
          },
          // Not `preserveNullAndEmptyArrays` - a session debit without a session cannot be
          // attributed to a station, and inventing a bucket for it would misreport rather
          // than omit. Module 10 makes `chargingSessionId` required for this purpose.
          { $unwind: '$session' },
          { $group: { _id: '$session.stationId', revenuePaise: { $sum: '$amountPaise' } } },
        ])
      : Promise.resolve([]),
  ]);

  const revenueByStation = new Map(revenueRows.map((row) => [String(row._id), row.revenuePaise]));

  // A station can earn in the window without a session STARTING in it - a charge that began
  // yesterday and settled today. Both key sets are merged so neither view loses a station.
  const stationIds = new Set<string>([
    ...usageRows.map((row) => String(row._id)),
    ...revenueByStation.keys(),
  ]);

  if (stationIds.size === 0) {
    return {
      range: { from: scope.range.from.toISOString(), to: scope.range.to.toISOString() },
      stations: [],
    };
  }

  const stations = await Station.find({
    _id: { $in: [...stationIds].map((id) => new Types.ObjectId(id)) },
  })
    .select('name stationCode')
    .lean();

  const usageByStation = new Map(usageRows.map((row) => [String(row._id), row]));

  const breakdown: StationBreakdown[] = stations.map((station) => {
    const id = String(station._id);
    const usage = usageByStation.get(id);
    const energyWh = usage?.energyWh ?? 0;
    const revenuePaise = revenueByStation.get(id) ?? 0;

    return {
      stationId: id,
      name: station.name,
      stationCode: station.stationCode,
      sessions: usage?.sessions ?? 0,
      energyWh,
      energyKwh: toKwh(energyWh),
      ...(showRevenue ? { revenuePaise, revenueRupees: paiseToRupees(revenuePaise) } : {}),
    };
  });

  /*
   * Sorted by revenue where it is visible, by energy where it is not. An operator cannot see
   * money, so ordering their list by it would leak the ranking - the exact information the
   * 403 on /analytics/revenue exists to withhold. Hiding a column while sorting by it is how
   * a permission boundary leaks through a side channel.
   */
  breakdown.sort((a, b) =>
    showRevenue
      ? (b.revenuePaise ?? 0) - (a.revenuePaise ?? 0) || b.energyWh - a.energyWh
      : b.energyWh - a.energyWh || b.sessions - a.sessions,
  );

  return {
    range: { from: scope.range.from.toISOString(), to: scope.range.to.toISOString() },
    stations: breakdown.slice(0, limit),
  };
}
