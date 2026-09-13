/**
 * Request validation for company endpoints.
 *
 * Every schema is `.strict()`, for the same reason Module 1's register schema is: unknown
 * keys are REJECTED, not silently stripped. That turns an attempt to smuggle a field into
 * a visible 4xx instead of an invisible no-op.
 */

import { z } from 'zod';

import { COMPANY_STATUSES, COMPANY_TYPES } from '../constants/company';

/** A MongoDB ObjectId as it appears in a URL. */
const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid 24-character resource id');

export const companyIdParamSchema = z.object({ companyId: objectId });

const addressSchema = z
  .object({
    line1: z.string().trim().max(200).optional(),
    city: z.string().trim().max(100).optional(),
    state: z.string().trim().max(100).optional(),
    country: z.string().trim().max(100).optional(),
    postalCode: z.string().trim().max(20).optional(),
  })
  .strict();

export const createCompanySchema = z
  .object({
    name: z.string().trim().min(2, 'Name must be at least 2 characters').max(120),
    legalName: z.string().trim().max(200).optional(),
    type: z.enum(COMPANY_TYPES).optional(),
    contactEmail: z.email('Enter a valid email address').max(254).optional(),
    contactPhone: z.string().trim().min(7).max(20).optional(),
    address: addressSchema.optional(),
  })
  .strict();

/**
 * General update. Deliberately has NO `status` field.
 *
 * Because the schema is strict, an edit form that posts a stale `status` is rejected rather
 * than silently suspending a company. Changing status is always a deliberate act through
 * PATCH /companies/:companyId/status.
 */
export const updateCompanySchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    legalName: z.string().trim().max(200).optional(),
    type: z.enum(COMPANY_TYPES).optional(),
    contactEmail: z.email('Enter a valid email address').max(254).optional(),
    contactPhone: z.string().trim().min(7).max(20).optional(),
    address: addressSchema.optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update.',
  });

export const companyStatusSchema = z.object({ status: z.enum(COMPANY_STATUSES) }).strict();

export const listCompaniesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(COMPANY_STATUSES).optional(),
    type: z.enum(COMPANY_TYPES).optional(),
    search: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export type CreateCompanyInput = z.infer<typeof createCompanySchema>;
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;
export type CompanyStatusInput = z.infer<typeof companyStatusSchema>;
export type ListCompaniesQuery = z.infer<typeof listCompaniesQuerySchema>;
