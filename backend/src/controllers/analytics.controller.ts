/**
 * Analytics HTTP handlers. Thin, as always — every decision lives in the service.
 *
 * There is no `:id` anywhere in this module, so there are no params to validate and no
 * 403-vs-404 question to answer: nothing here addresses a single resource. The only
 * authorisation that matters is the company scope the service applies to every pipeline,
 * plus the revenue restriction enforced in the router.
 */

import type { Request, Response } from 'express';

import * as analyticsService from '../services/analytics.service';
import { ApiError } from '../utils/ApiError';
import { sendSuccess } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import type {
  AnalyticsRangeQuery,
  TopStationsQuery,
} from '../validators/analytics.validator';

function requireUser(req: Request) {
  if (!req.user) throw ApiError.unauthorized('Authentication required.');
  return req.user;
}

/** GET /analytics/overview — every summary card in one round trip. */
export const getOverview = asyncHandler(async (req: Request, res: Response) => {
  const overview = await analyticsService.getOverview(
    requireUser(req),
    req.query as unknown as AnalyticsRangeQuery,
  );

  sendSuccess(res, overview, 'Analytics overview retrieved');
});

/** GET /analytics/sessions — sessions and energy per day. */
export const getSessionSeries = asyncHandler(async (req: Request, res: Response) => {
  const series = await analyticsService.getSessionSeries(
    requireUser(req),
    req.query as unknown as AnalyticsRangeQuery,
  );

  sendSuccess(res, series, 'Session analytics retrieved');
});

/** GET /analytics/revenue — money collected per day. */
export const getRevenueSeries = asyncHandler(async (req: Request, res: Response) => {
  const series = await analyticsService.getRevenueSeries(
    requireUser(req),
    req.query as unknown as AnalyticsRangeQuery,
  );

  sendSuccess(res, series, 'Revenue analytics retrieved');
});

/** GET /analytics/stations — the busiest stations in the window. */
export const getTopStations = asyncHandler(async (req: Request, res: Response) => {
  const result = await analyticsService.getTopStations(
    requireUser(req),
    req.query as unknown as TopStationsQuery,
  );

  sendSuccess(res, result, 'Station analytics retrieved');
});
