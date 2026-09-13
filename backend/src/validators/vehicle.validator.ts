/**
 * Request validation for vehicles.
 *
 * Note what is absent: there is no `userId` or `ownerId` field in any schema, and
 * `.strict()` means sending one is a 422. Ownership is taken from the authenticated
 * request, never from the body — a driver cannot create a vehicle in someone else's
 * account even by asking.
 */

import { z } from 'zod';

import { CONNECTOR_TYPES } from '../constants/vehicle';

const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid 24-character resource id');

export const vehicleIdParamSchema = z.object({ vehicleId: objectId });

export const createVehicleSchema = z
  .object({
    make: z.string().trim().min(1, 'Make is required').max(60),
    model: z.string().trim().min(1, 'Model is required').max(60),
    registrationNumber: z
      .string()
      .trim()
      .min(4, 'Registration number looks too short')
      .max(20)
      .transform((value) => value.toUpperCase()),
    batteryCapacityKwh: z.coerce.number().min(0.5).max(400).optional(),
    connectorType: z.enum(CONNECTOR_TYPES),
  })
  .strict();

export const updateVehicleSchema = z
  .object({
    make: z.string().trim().min(1).max(60).optional(),
    model: z.string().trim().min(1).max(60).optional(),
    registrationNumber: z
      .string()
      .trim()
      .min(4)
      .max(20)
      .transform((value) => value.toUpperCase())
      .optional(),
    batteryCapacityKwh: z.coerce.number().min(0.5).max(400).optional(),
    connectorType: z.enum(CONNECTOR_TYPES).optional(),
    /** Lets a driver reactivate a vehicle they previously deactivated. */
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update.',
  });

export type CreateVehicleInput = z.infer<typeof createVehicleSchema>;
export type UpdateVehicleInput = z.infer<typeof updateVehicleSchema>;
