/**
 * Station HTTP handlers. Thin: read the request, call a service, send the envelope.
 * No access decisions here — roles are checked in middleware, ownership inside the queries.
 */

import type { Request, Response } from 'express';

import * as stationService from '../services/station.service';
import * as stationMapService from '../services/stationMap.service';
import { ApiError } from '../utils/ApiError';
import { sendSuccess } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import type { StationStatus } from '../constants/station';
import type {
  CreateStationInput,
  ListStationsQuery,
  MapStationsQuery,
  PublicStationsQuery,
  StationStatusInput,
  UpdateStationInput,
} from '../validators/station.validator';

function requireUser(req: Request) {
  if (!req.user) throw ApiError.unauthorized('Authentication required.');
  return req.user;
}

/** POST /stations — super_admin (any company) or cpo_admin (their own). */
export const createStation = asyncHandler(async (req: Request, res: Response) => {
  const station = await stationService.createStation(
    requireUser(req),
    req.body as CreateStationInput,
  );
  sendSuccess(res, { station }, 'Station created successfully', 201);
});

/** GET /stations — scoped by company for cpo_admin and operator. */
export const listStations = asyncHandler(async (req: Request, res: Response) => {
  const result = await stationService.listStations(
    requireUser(req),
    req.query as unknown as ListStationsQuery,
  );
  sendSuccess(res, result, 'Stations retrieved');
});

/** GET /stations/:stationId */
export const getStationById = asyncHandler(async (req: Request, res: Response) => {
  const station = await stationService.getStationById(
    requireUser(req),
    String(req.params.stationId),
  );
  sendSuccess(res, { station }, 'Station retrieved');
});

/** PATCH /stations/:stationId — details only; cannot change status or company. */
export const updateStation = asyncHandler(async (req: Request, res: Response) => {
  const station = await stationService.updateStation(
    requireUser(req),
    String(req.params.stationId),
    req.body as UpdateStationInput,
  );
  sendSuccess(res, { station }, 'Station updated successfully');
});

/** PATCH /stations/:stationId/status */
export const updateStationStatus = asyncHandler(async (req: Request, res: Response) => {
  const { status } = req.body as StationStatusInput;
  const station = await stationService.setStationStatus(
    requireUser(req),
    String(req.params.stationId),
    status as StationStatus,
  );

  const message =
    status === 'active'
      ? 'Station activated'
      : status === 'inactive'
        ? 'Station deactivated'
        : 'Station suspended';

  sendSuccess(res, { station }, message);
});

/* -------------------------------------------------------------------------- */
/* Module 14 — map reads                                                      */
/* -------------------------------------------------------------------------- */

/** GET /stations/map — staff markers, company-scoped. */
export const listStationsForMap = asyncHandler(async (req: Request, res: Response) => {
  const result = await stationMapService.listStationsForMap(
    requireUser(req),
    req.query as unknown as MapStationsQuery,
  );

  sendSuccess(res, result, 'Map stations retrieved');
});

/**
 * GET /stations/public — active stations of active companies, across every company.
 *
 * Note what is NOT passed: the actor. This read is identical for everyone who can reach it,
 * and the service has nothing to scope by even if someone later tried.
 */
export const listPublicStations = asyncHandler(async (req: Request, res: Response) => {
  const result = await stationMapService.listPublicStations(
    req.query as unknown as PublicStationsQuery,
  );

  sendSuccess(res, result, 'Stations retrieved');
});

/** GET /stations/cities — the city dropdown for staff, company-scoped. */
export const listStationCities = asyncHandler(async (req: Request, res: Response) => {
  const cities = await stationMapService.listStationCities(requireUser(req));
  sendSuccess(res, { cities }, 'Cities retrieved');
});

/** GET /stations/public/cities — the city dropdown for driver discovery. */
export const listPublicStationCities = asyncHandler(async (_req: Request, res: Response) => {
  const cities = await stationMapService.listPublicStationCities();
  sendSuccess(res, { cities }, 'Cities retrieved');
});
