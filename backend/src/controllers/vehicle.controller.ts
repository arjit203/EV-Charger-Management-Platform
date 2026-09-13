/**
 * Vehicle HTTP handlers — all driver self-service.
 *
 * Every handler passes `req.user` to the service, which scopes the query by owner. No
 * handler ever reads an owner id from the body, params or query.
 */

import type { Request, Response } from 'express';

import * as vehicleService from '../services/vehicle.service';
import { ApiError } from '../utils/ApiError';
import { sendSuccess } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import type { CreateVehicleInput, UpdateVehicleInput } from '../validators/vehicle.validator';

function requireUser(req: Request) {
  if (!req.user) throw ApiError.unauthorized('Authentication required.');
  return req.user;
}

/** GET /users/me/vehicles */
export const listMyVehicles = asyncHandler(async (req: Request, res: Response) => {
  const vehicles = await vehicleService.listMyVehicles(requireUser(req));
  sendSuccess(res, { vehicles }, 'Vehicles retrieved');
});

/** POST /users/me/vehicles */
export const createMyVehicle = asyncHandler(async (req: Request, res: Response) => {
  const vehicle = await vehicleService.createMyVehicle(
    requireUser(req),
    req.body as CreateVehicleInput,
  );
  sendSuccess(res, { vehicle }, 'Vehicle added successfully', 201);
});

/** GET /users/me/vehicles/:vehicleId */
export const getMyVehicle = asyncHandler(async (req: Request, res: Response) => {
  const vehicle = await vehicleService.getMyVehicle(requireUser(req), String(req.params.vehicleId));
  sendSuccess(res, { vehicle }, 'Vehicle retrieved');
});

/** PATCH /users/me/vehicles/:vehicleId */
export const updateMyVehicle = asyncHandler(async (req: Request, res: Response) => {
  const vehicle = await vehicleService.updateMyVehicle(
    requireUser(req),
    String(req.params.vehicleId),
    req.body as UpdateVehicleInput,
  );
  sendSuccess(res, { vehicle }, 'Vehicle updated successfully');
});

/** DELETE /users/me/vehicles/:vehicleId — soft delete; see the service for why. */
export const deactivateMyVehicle = asyncHandler(async (req: Request, res: Response) => {
  const vehicle = await vehicleService.deactivateMyVehicle(
    requireUser(req),
    String(req.params.vehicleId),
  );
  sendSuccess(res, { vehicle }, 'Vehicle deactivated');
});
