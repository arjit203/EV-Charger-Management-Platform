/**
 * Request validation for tariffs.
 *
 * THE MONEY BOUNDARY IS HERE. A form sends rupees because that is what a human types; the
 * database stores integer paise. This file is the single place that conversion happens, so
 * there is exactly one line in the project where a decimal rupee value exists at all.
 *
 * `.strict()` as always — an attempt to send `status`, or a `companyId` from a company-scoped
 * caller, is a visible 422 rather than a silent strip.
 */

import { z } from 'zod';

import {
  MAX_PRICE_PER_KWH_PAISE,
  MIN_PRICE_PER_KWH_PAISE,
  TARIFF_STATUSES,
} from '../constants/tariff';
import { rupeesToPaise } from '../utils/money';

const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid 24-character resource id');

export const tariffIdParamSchema = z.object({ tariffId: objectId });

/**
 * A rate in RUPEES, converted to integer paise immediately.
 *
 * `rupeesToPaise` rounds rather than truncating, which matters: `12.34 * 100` is
 * `1233.9999999999998` in IEEE-754, and truncation would quietly charge ₹12.33.
 *
 * The bounds are checked AFTER conversion so the error message and the stored value are talking
 * about the same number.
 */
const pricePerKwh = z.coerce
  .number()
  .positive('Price must be greater than zero')
  .transform(rupeesToPaise)
  .refine((paise) => paise >= MIN_PRICE_PER_KWH_PAISE, {
    message: 'Price must be at least ₹0.01 per kWh',
  })
  .refine((paise) => paise <= MAX_PRICE_PER_KWH_PAISE, {
    message: 'Price must be at most ₹1000 per kWh',
  });

export const createTariffSchema = z
  .object({
    name: z.string().trim().min(2, 'Name is too short').max(80),
    /** In rupees. Stored as paise. */
    pricePerKwh,
    /**
     * super_admin only — they have no company of their own, so they must name one. A
     * company-scoped caller sending this gets a 422: their company comes from their account,
     * and an attempt to override it should be visible in the logs rather than ignored.
     */
    companyId: objectId.optional(),
  })
  .strict();

export const updateTariffSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    pricePerKwh: pricePerKwh.optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update.',
  });

/** Status is its own endpoint: activating swaps out the incumbent, which is not an edit. */
export const tariffStatusSchema = z.object({ status: z.enum(TARIFF_STATUSES) }).strict();

export const listTariffsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    status: z.enum(TARIFF_STATUSES).optional(),
    companyId: objectId.optional(),
  })
  .strict();

type CreateTariffParsed = z.infer<typeof createTariffSchema>;
type UpdateTariffParsed = z.infer<typeof updateTariffSchema>;

/**
 * The service sees paise, not rupees.
 *
 * Zod's `transform` has already converted, so the field is renamed here to make that impossible
 * to misread downstream — a variable called `pricePerKwh` holding 1200 would be a trap.
 */
export interface CreateTariffInput {
  name: string;
  pricePerKwhPaise: number;
  companyId?: string;
}

export interface UpdateTariffInput {
  name?: string;
  pricePerKwhPaise?: number;
}

export function toCreateInput(parsed: CreateTariffParsed): CreateTariffInput {
  return { name: parsed.name, pricePerKwhPaise: parsed.pricePerKwh, companyId: parsed.companyId };
}

export function toUpdateInput(parsed: UpdateTariffParsed): UpdateTariffInput {
  const input: UpdateTariffInput = {};
  if (parsed.name !== undefined) input.name = parsed.name;
  if (parsed.pricePerKwh !== undefined) input.pricePerKwhPaise = parsed.pricePerKwh;
  return input;
}

export type ListTariffsQuery = z.infer<typeof listTariffsQuerySchema>;
export type TariffStatusInput = z.infer<typeof tariffStatusSchema>;
