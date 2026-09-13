/**
 * Request validation for chargers.
 *
 * `.strict()` throughout. Note what the update schema omits: `stationId`, `companyId` and
 * `status`. A charger can never change site or owner through an edit form, and status has
 * its own endpoint.
 */

import { z } from 'zod';

import { CHARGER_STATUSES, CHARGER_TYPES } from '../constants/charger';

const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid 24-character resource id');

export const chargerIdParamSchema = z.object({ chargerId: objectId });

const powerKw = z.coerce
  .number()
  .min(1, 'Power rating must be at least 1 kW')
  .max(1000, 'Power rating must be at most 1000 kW');

export const createChargerSchema = z
  .object({
    /** Verified against the caller's company scope before anything is written. */
    stationId: objectId,
    name: z.string().trim().min(2, 'Charger name must be at least 2 characters').max(150),
    chargerCode: z
      .string()
      .trim()
      .min(1, 'Charger code is required')
      .max(40)
      .transform((v) => v.toUpperCase()),
    /** Globally unique — Module 6 matches an incoming connection on this. */
    ocppId: z.string().trim().min(3, 'OCPP identifier must be at least 3 characters').max(64),
    manufacturer: z.string().trim().min(1, 'Manufacturer is required').max(100),
    model: z.string().trim().min(1, 'Model is required').max(100),
    chargerType: z.enum(CHARGER_TYPES),
    powerKw,
    firmwareVersion: z.string().trim().max(50).optional(),
  })
  .strict();

export const updateChargerSchema = z
  .object({
    name: z.string().trim().min(2).max(150).optional(),
    chargerCode: z.string().trim().min(1).max(40).transform((v) => v.toUpperCase()).optional(),
    ocppId: z.string().trim().min(3).max(64).optional(),
    manufacturer: z.string().trim().min(1).max(100).optional(),
    model: z.string().trim().min(1).max(100).optional(),
    chargerType: z.enum(CHARGER_TYPES).optional(),
    powerKw: powerKw.optional(),
    firmwareVersion: z.string().trim().max(50).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update.',
  });

export const chargerStatusSchema = z.object({ status: z.enum(CHARGER_STATUSES) }).strict();

export const listChargersQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    stationId: objectId.optional(),
    status: z.enum(CHARGER_STATUSES).optional(),
    chargerType: z.enum(CHARGER_TYPES).optional(),
    manufacturer: z.string().trim().min(1).max(100).optional(),
    /** super_admin only. A company-scoped caller naming another company gets 403. */
    companyId: objectId.optional(),
    search: z.string().trim().min(1).max(150).optional(),
  })
  .strict();

/**
 * RemoteStartTransaction body (Module 6).
 *
 * `idTag` is the physical credential the hardware would normally read from an RFID card.
 * Module 7 replaces it with the identity of the driver who initiated the session.
 */
export const remoteStartSchema = z
  .object({
    connectorNumber: z.coerce.number().int().min(1).max(8),
    idTag: z
      .string()
      .trim()
      .min(4, 'idTag must be at least 4 characters')
      .max(40)
      .regex(/^[A-Za-z0-9-]+$/, 'idTag may contain only letters, numbers and hyphens'),
  })
  .strict();

export type RemoteStartInput = z.infer<typeof remoteStartSchema>;

export type CreateChargerInput = z.infer<typeof createChargerSchema>;
export type UpdateChargerInput = z.infer<typeof updateChargerSchema>;
export type ChargerStatusInput = z.infer<typeof chargerStatusSchema>;
export type ListChargersQuery = z.infer<typeof listChargersQuerySchema>;
