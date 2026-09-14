/**
 * Request validation for stations.
 *
 * Every schema is `.strict()`, so unknown keys are REJECTED rather than silently stripped —
 * the same reasoning as Modules 1–3. Note what the update schema deliberately omits:
 * `status` and `companyId`. A station can never change owner through an edit form, and
 * status changes go through their own endpoint.
 */

import { z } from 'zod';

import { MAX_MAP_STATIONS, STATION_STATUSES } from '../constants/station';

const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid 24-character resource id');

export const stationIdParamSchema = z.object({ stationId: objectId });

/** Latitude and longitude must be real geographic coordinates, not just numbers. */
const latitude = z.coerce
  .number()
  .min(-90, 'Latitude must be between -90 and 90')
  .max(90, 'Latitude must be between -90 and 90');

const longitude = z.coerce
  .number()
  .min(-180, 'Longitude must be between -180 and 180')
  .max(180, 'Longitude must be between -180 and 180');

export const createStationSchema = z
  .object({
    name: z.string().trim().min(2, 'Station name must be at least 2 characters').max(150),
    stationCode: z
      .string()
      .trim()
      .min(2, 'Station code must be at least 2 characters')
      .max(40)
      .transform((value) => value.toUpperCase()),
    address: z.string().trim().min(3, 'Address is required').max(250),
    city: z.string().trim().min(1, 'City is required').max(100),
    state: z.string().trim().min(1, 'State is required').max(100),
    country: z.string().trim().min(1, 'Country is required').max(100),
    postalCode: z.string().trim().max(20).optional(),
    latitude,
    longitude,
    contactPhone: z.string().trim().min(7).max(20).optional(),
    openingHours: z.string().trim().max(120).optional(),

    /**
     * Only meaningful for a super_admin, who may create a station for any company.
     * For a cpo_admin the company is taken from their token, and a value here that isn't
     * theirs is refused with 403 rather than quietly overwritten — so the attempt stays
     * visible instead of looking like a normal request.
     */
    companyId: objectId.optional(),
  })
  .strict();

export const updateStationSchema = z
  .object({
    name: z.string().trim().min(2).max(150).optional(),
    stationCode: z.string().trim().min(2).max(40).transform((v) => v.toUpperCase()).optional(),
    address: z.string().trim().min(3).max(250).optional(),
    city: z.string().trim().min(1).max(100).optional(),
    state: z.string().trim().min(1).max(100).optional(),
    country: z.string().trim().min(1).max(100).optional(),
    postalCode: z.string().trim().max(20).optional(),
    latitude: latitude.optional(),
    longitude: longitude.optional(),
    contactPhone: z.string().trim().min(7).max(20).optional(),
    openingHours: z.string().trim().max(120).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update.',
  });

export const stationStatusSchema = z.object({ status: z.enum(STATION_STATUSES) }).strict();

export const listStationsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(STATION_STATUSES).optional(),
    city: z.string().trim().min(1).max(100).optional(),
    /** super_admin only. A company-scoped caller naming another company gets 403. */
    companyId: objectId.optional(),
    search: z.string().trim().min(1).max(150).optional(),
  })
  .strict();

export type CreateStationInput = z.infer<typeof createStationSchema>;
export type UpdateStationInput = z.infer<typeof updateStationSchema>;
export type StationStatusInput = z.infer<typeof stationStatusSchema>;
export type ListStationsQuery = z.infer<typeof listStationsQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Module 14 — map reads                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Staff map query. Same filter vocabulary as the admin list, minus pagination.
 *
 * There is no `page`: a map has no next page. `limit` caps the marker set instead, and the
 * response carries a `truncated` flag so a clipped view can say so rather than quietly
 * pretend it is complete.
 */
export const mapStationsQuerySchema = z
  .object({
    status: z.enum(STATION_STATUSES).optional(),
    city: z.string().trim().min(1).max(100).optional(),
    search: z.string().trim().min(1).max(150).optional(),
    /** super_admin only. A company-scoped caller naming another company gets 403. */
    companyId: objectId.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_MAP_STATIONS).optional(),
  })
  .strict();

/**
 * Driver discovery query. DELIBERATELY NARROWER THAN THE STAFF ONE.
 *
 * No `status` — the endpoint serves active stations only, and offering the parameter would
 * imply a driver can ask for inactive ones.
 *
 * No `companyId` — this is the project's one cross-company read, and the response shape
 * exists precisely to remove company identity. A filter that takes a company id would hand
 * back, through the query string, the very thing the payload strips. `.strict()` turns the
 * attempt into a 400 rather than ignoring it.
 */
export const publicStationsQuerySchema = z
  .object({
    city: z.string().trim().min(1).max(100).optional(),
    search: z.string().trim().min(1).max(150).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_MAP_STATIONS).optional(),
  })
  .strict();

export type MapStationsQuery = z.infer<typeof mapStationsQuerySchema>;
export type PublicStationsQuery = z.infer<typeof publicStationsQuerySchema>;
