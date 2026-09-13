/**
 * Charger HTTP handlers. Thin: read the request, call a service, send the envelope.
 * Roles are checked in middleware; the ownership chain is verified inside the service.
 */

import type { Request, Response } from 'express';

import * as chargerService from '../services/charger.service';
import { ApiError } from '../utils/ApiError';
import { sendSuccess } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import type { ChargerStatus } from '../constants/charger';
import type {
  ChargerStatusInput,
  CreateChargerInput,
  ListChargersQuery,
  UpdateChargerInput,
} from '../validators/charger.validator';

function requireUser(req: Request) {
  if (!req.user) throw ApiError.unauthorized('Authentication required.');
  return req.user;
}

/**
 * POST /chargers — the station in the body is verified against the caller's company scope.
 *
 * The response includes `authToken` exactly once. It is the charger's OCPP connection secret
 * and is stored hashed, so it can never be retrieved again — only regenerated.
 */
export const createCharger = asyncHandler(async (req: Request, res: Response) => {
  const { charger, authToken } = await chargerService.createCharger(
    requireUser(req),
    req.body as CreateChargerInput,
  );
  sendSuccess(
    res,
    { charger, authToken },
    'Charger created. Save the connection token now — it cannot be shown again.',
    201,
  );
});

/** POST /chargers/:chargerId/token — issue a new connection token, invalidating the old one. */
export const regenerateChargerToken = asyncHandler(async (req: Request, res: Response) => {
  const { charger, authToken } = await chargerService.regenerateChargerToken(
    requireUser(req),
    String(req.params.chargerId),
  );
  sendSuccess(
    res,
    { charger, authToken },
    'New connection token issued. Save it now — it cannot be shown again.',
  );
});

/** GET /chargers */
export const listChargers = asyncHandler(async (req: Request, res: Response) => {
  const result = await chargerService.listChargers(
    requireUser(req),
    req.query as unknown as ListChargersQuery,
  );
  sendSuccess(res, result, 'Chargers retrieved');
});

/** GET /chargers/:chargerId */
export const getChargerById = asyncHandler(async (req: Request, res: Response) => {
  const charger = await chargerService.getChargerById(
    requireUser(req),
    String(req.params.chargerId),
  );
  sendSuccess(res, { charger }, 'Charger retrieved');
});

/** PATCH /chargers/:chargerId — cannot move site, company or status. */
export const updateCharger = asyncHandler(async (req: Request, res: Response) => {
  const charger = await chargerService.updateCharger(
    requireUser(req),
    String(req.params.chargerId),
    req.body as UpdateChargerInput,
  );
  sendSuccess(res, { charger }, 'Charger updated successfully');
});

/** PATCH /chargers/:chargerId/status — does not cascade to connectors, by design. */
export const updateChargerStatus = asyncHandler(async (req: Request, res: Response) => {
  const { status } = req.body as ChargerStatusInput;
  const charger = await chargerService.setChargerStatus(
    requireUser(req),
    String(req.params.chargerId),
    status as ChargerStatus,
  );
  sendSuccess(res, { charger }, `Charger marked ${status}`);
});
