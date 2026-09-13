/**
 * Tariff HTTP handlers. Thin, as always.
 *
 * The one thing worth noticing: the request body arrives with a rupee `pricePerKwh` which the
 * validator has already transformed into paise. `toCreateInput` / `toUpdateInput` rename it so
 * the service can only ever see a field called `pricePerKwhPaise`.
 */

import type { Request, Response } from 'express';

import * as tariffService from '../services/tariff.service';
import { ApiError } from '../utils/ApiError';
import { sendSuccess } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import {
  toCreateInput,
  toUpdateInput,
  type ListTariffsQuery,
  type TariffStatusInput,
} from '../validators/tariff.validator';
import type { createTariffSchema, updateTariffSchema } from '../validators/tariff.validator';
import type { z } from 'zod';

function requireUser(req: Request) {
  if (!req.user) throw ApiError.unauthorized('Authentication required.');
  return req.user;
}

/** POST /tariffs — created inactive; activating it is a separate call. */
export const createTariff = asyncHandler(async (req: Request, res: Response) => {
  const parsed = req.body as z.infer<typeof createTariffSchema>;

  const tariff = await tariffService.createTariff(requireUser(req), toCreateInput(parsed));

  sendSuccess(res, { tariff }, 'Tariff created', 201);
});

/** GET /tariffs */
export const listTariffs = asyncHandler(async (req: Request, res: Response) => {
  const result = await tariffService.listTariffs(
    requireUser(req),
    req.query as unknown as ListTariffsQuery,
  );

  sendSuccess(res, result, 'Tariffs retrieved');
});

/** GET /tariffs/:tariffId */
export const getTariffById = asyncHandler(async (req: Request, res: Response) => {
  const tariff = await tariffService.getTariffById(requireUser(req), String(req.params.tariffId));
  sendSuccess(res, { tariff }, 'Tariff retrieved');
});

/** PATCH /tariffs/:tariffId */
export const updateTariff = asyncHandler(async (req: Request, res: Response) => {
  const parsed = req.body as z.infer<typeof updateTariffSchema>;

  const tariff = await tariffService.updateTariff(
    requireUser(req),
    String(req.params.tariffId),
    toUpdateInput(parsed),
  );

  sendSuccess(res, { tariff }, 'Tariff updated');
});

/** PATCH /tariffs/:tariffId/status — activating swaps out the company's current tariff. */
export const setTariffStatus = asyncHandler(async (req: Request, res: Response) => {
  const { status } = req.body as TariffStatusInput;

  const tariff = await tariffService.setTariffStatus(
    requireUser(req),
    String(req.params.tariffId),
    status,
  );

  sendSuccess(res, { tariff }, `Tariff ${status === 'active' ? 'activated' : 'deactivated'}`);
});
