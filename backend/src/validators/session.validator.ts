/**
 * Request validation for charging sessions.
 *
 * Note how small the start payload is. A client sends ONE id — the connector it is standing in
 * front of — and nothing else. Station, charger, company and connector number are all derived
 * server-side by walking the relationships, because accepting them from the client would mean
 * trusting the client's idea of which charger a connector belongs to.
 *
 * `userId` is likewise absent and always will be: ownership comes from the verified token.
 * `.strict()` means an attempt to send either one is a visible 422 rather than a silent strip.
 */

import { z } from 'zod';

import { SESSION_STATUSES } from '../constants/session';

const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid 24-character resource id');

export const sessionIdParamSchema = z.object({ sessionId: objectId });
export const connectorIdParamSchema = z.object({ connectorId: objectId });

export const startSessionSchema = z
  .object({
    connectorId: objectId,
    /**
     * Optional. A driver with one car should not have to pick it, and a driver who has not
     * registered a car at all should still be able to charge — the platform bills for energy,
     * not for cars. When present it must be the caller's own and must fit the plug.
     */
    vehicleId: objectId.optional(),
  })
  .strict();

export const listSessionsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    status: z.enum(SESSION_STATUSES).optional(),
    /** Shorthand for "anything not finished" — the monitoring view's default. */
    active: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    stationId: objectId.optional(),
    chargerId: objectId.optional(),
    /** Honoured for super_admin only; ignored for everyone else, who is already scoped. */
    companyId: objectId.optional(),
  })
  .strict();

export const readingsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(2000).optional(),
  })
  .strict();

export type StartSessionInput = z.infer<typeof startSessionSchema>;
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;
export type ReadingsQuery = z.infer<typeof readingsQuerySchema>;
