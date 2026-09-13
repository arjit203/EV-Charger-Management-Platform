/**
 * Request validation for connectors.
 *
 * Note there is no `chargerId` field in any schema: the parent charger comes from the URL
 * path and is verified against the caller's company scope before anything is read or
 * written. `.strict()` means sending one is a 422.
 */

import { z } from 'zod';

import { CONNECTOR_STATUSES, CONNECTOR_TYPES } from '../constants/connector';

const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid 24-character resource id');

/** Both ids appear in the nested route, so both are validated together. */
export const connectorParamsSchema = z.object({
  chargerId: objectId,
  connectorId: objectId,
});

const powerKw = z.coerce
  .number()
  .min(1, 'Power rating must be at least 1 kW')
  .max(1000, 'Power rating must be at most 1000 kW');

export const createConnectorSchema = z
  .object({
    /** Physical position, starting at 1. OCPP addresses connectors by this number. */
    connectorNumber: z.coerce
      .number()
      .int('Connector number must be a whole number')
      .min(1, 'Connector number starts at 1')
      .max(8, 'A charger can have at most 8 connectors'),
    connectorType: z.enum(CONNECTOR_TYPES),
    powerKw,
  })
  .strict();

export const updateConnectorSchema = z
  .object({
    connectorNumber: z.coerce.number().int().min(1).max(8).optional(),
    connectorType: z.enum(CONNECTOR_TYPES).optional(),
    powerKw: powerKw.optional(),
    errorCode: z.string().trim().max(64).nullable().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update.',
  });

export const connectorStatusSchema = z.object({ status: z.enum(CONNECTOR_STATUSES) }).strict();

export const listConnectorsQuerySchema = z
  .object({
    status: z.enum(CONNECTOR_STATUSES).optional(),
    connectorType: z.enum(CONNECTOR_TYPES).optional(),
  })
  .strict();

export type CreateConnectorInput = z.infer<typeof createConnectorSchema>;
export type UpdateConnectorInput = z.infer<typeof updateConnectorSchema>;
export type ConnectorStatusInput = z.infer<typeof connectorStatusSchema>;
export type ListConnectorsQuery = z.infer<typeof listConnectorsQuerySchema>;
