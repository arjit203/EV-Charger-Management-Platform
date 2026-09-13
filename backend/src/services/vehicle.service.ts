/**
 * Vehicle business logic — every function scoped to the authenticated owner.
 *
 * There is no administrative surface here at all. Vehicles are personal property; an admin
 * who needs a driver's details uses the user endpoints. That keeps this file's rule
 * absolute and easy to audit: **every query goes through `applyOwnerScope`.**
 *
 * `404` rather than `403` for someone else's vehicle is deliberate. Within a driver's own
 * namespace there is no meaningful difference between "this vehicle isn't yours" and "this
 * vehicle doesn't exist", and answering 403 would confirm that a given vehicle id is real.
 */

import { Vehicle, toPublicVehicle, type PublicVehicle } from '../models/vehicle.model';
import { ApiError } from '../utils/ApiError';
import { applyOwnerScope } from '../utils/ownerScope';
import type { AuthUser } from '../types/express';
import type { CreateVehicleInput, UpdateVehicleInput } from '../validators/vehicle.validator';

export async function listMyVehicles(actor: AuthUser): Promise<PublicVehicle[]> {
  const vehicles = await Vehicle.find(applyOwnerScope(actor)).sort({ createdAt: -1 });
  return vehicles.map(toPublicVehicle);
}

export async function getMyVehicle(actor: AuthUser, vehicleId: string): Promise<PublicVehicle> {
  const vehicle = await Vehicle.findOne(applyOwnerScope(actor, { _id: vehicleId }));
  if (!vehicle) throw ApiError.notFound('Vehicle not found.');
  return toPublicVehicle(vehicle);
}

/**
 * Create a vehicle for the authenticated driver.
 *
 * `userId` comes from the token. The validator has no `ownerId`/`userId` field and is
 * strict, so sending one is a 422 — a driver cannot write a vehicle into another account.
 */
export async function createMyVehicle(
  actor: AuthUser,
  input: CreateVehicleInput,
): Promise<PublicVehicle> {
  const existing = await Vehicle.findOne({
    registrationNumber: input.registrationNumber,
  }).select('_id');

  if (existing) {
    // Checked across ALL owners, not just this driver's: a plate identifies one physical
    // car, so another account already holding it is a conflict, not a private duplicate.
    throw ApiError.conflict('A vehicle with this registration number already exists.');
  }

  const vehicle = await Vehicle.create({ ...input, userId: actor.id });
  return toPublicVehicle(vehicle);
}

export async function updateMyVehicle(
  actor: AuthUser,
  vehicleId: string,
  input: UpdateVehicleInput,
): Promise<PublicVehicle> {
  if (input.registrationNumber) {
    const clash = await Vehicle.findOne({
      registrationNumber: input.registrationNumber,
      _id: { $ne: vehicleId },
    }).select('_id');

    if (clash) throw ApiError.conflict('A vehicle with this registration number already exists.');
  }

  const vehicle = await Vehicle.findOneAndUpdate(
    applyOwnerScope(actor, { _id: vehicleId }),
    { $set: input },
    { new: true, runValidators: true },
  );

  if (!vehicle) throw ApiError.notFound('Vehicle not found.');
  return toPublicVehicle(vehicle);
}

/**
 * Deactivate a vehicle. A SOFT delete.
 *
 * Module 7's charging sessions will reference `vehicleId`; removing the row would orphan
 * the driver's charging history and any receipt attached to it. Reactivation is a normal
 * PATCH with `isActive: true`.
 */
export async function deactivateMyVehicle(
  actor: AuthUser,
  vehicleId: string,
): Promise<PublicVehicle> {
  const vehicle = await Vehicle.findOneAndUpdate(
    applyOwnerScope(actor, { _id: vehicleId }),
    { $set: { isActive: false } },
    { new: true },
  );

  if (!vehicle) throw ApiError.notFound('Vehicle not found.');
  return toPublicVehicle(vehicle);
}
