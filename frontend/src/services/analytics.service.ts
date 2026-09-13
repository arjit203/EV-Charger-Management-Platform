/**
 * Analytics API calls.
 *
 * Every endpoint takes the same optional window, so one params type serves all four. Dates
 * are plain `YYYY-MM-DD` calendar dates, NOT ISO timestamps: the server rounds to whole UTC
 * days either way, and a format that cannot express a time cannot imply the time is honoured.
 *
 * `companyId` is for super_admin only. Anyone else sending it gets a 422 rather than being
 * silently rescoped — so the dashboard must not send it, and does not render the picker, for
 * a cpo_admin or operator.
 */

import { apiRequest } from './apiClient';
import type {
  AnalyticsOverview,
  RevenueSeriesPayload,
  SessionSeriesPayload,
  StationAnalyticsPayload,
} from '@/types/api';

export interface AnalyticsParams {
  /** Inclusive start, YYYY-MM-DD. Defaults server-side to 29 days before `to`. */
  from?: string;
  /** Inclusive END, YYYY-MM-DD — the whole of this day counts. Defaults to today, UTC. */
  to?: string;
  /** super_admin only. */
  companyId?: string;
}

function query(params: AnalyticsParams & { limit?: number }): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.toString() ? `?${search}` : '';
}

/*
 * `cache: 'no-store'` on every call, as everywhere else in this project. A cached dashboard
 * is worse than a slow one: it shows a number that was true and is not, with nothing on
 * screen to say so.
 */

export function getOverview(params: AnalyticsParams = {}): Promise<AnalyticsOverview> {
  return apiRequest<AnalyticsOverview>(`/analytics/overview${query(params)}`, { cache: 'no-store' });
}

export function getSessionSeries(params: AnalyticsParams = {}): Promise<SessionSeriesPayload> {
  return apiRequest<SessionSeriesPayload>(`/analytics/sessions${query(params)}`, { cache: 'no-store' });
}

export function getRevenueSeries(params: AnalyticsParams = {}): Promise<RevenueSeriesPayload> {
  return apiRequest<RevenueSeriesPayload>(`/analytics/revenue${query(params)}`, { cache: 'no-store' });
}

export function getTopStations(
  params: AnalyticsParams & { limit?: number } = {},
): Promise<StationAnalyticsPayload> {
  return apiRequest<StationAnalyticsPayload>(`/analytics/stations${query(params)}`, { cache: 'no-store' });
}
