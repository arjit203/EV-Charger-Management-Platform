/**
 * OCPP command HTTP handlers.
 *
 * Thin as always. The ownership check and the charger-state checks live in the service; the
 * wire format lives in the gateway. This layer only translates HTTP to a service call.
 */

import type { Request, Response } from 'express';

import * as commandService from '../services/chargerCommand.service';
import { ApiError } from '../utils/ApiError';
import { sendSuccess } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import type { RemoteStartInput } from '../validators/charger.validator';

function requireUser(req: Request) {
  if (!req.user) throw ApiError.unauthorized('Authentication required.');
  return req.user;
}

/** POST /chargers/:chargerId/commands/remote-start */
export const remoteStart = asyncHandler(async (req: Request, res: Response) => {
  const { connectorNumber, idTag } = req.body as RemoteStartInput;

  const result = await commandService.remoteStart(
    requireUser(req),
    String(req.params.chargerId),
    connectorNumber,
    idTag,
  );

  sendSuccess(res, result, result.accepted ? 'Remote start accepted' : 'Remote start rejected by charger');
});

/** POST /chargers/:chargerId/commands/remote-stop */
export const remoteStop = asyncHandler(async (req: Request, res: Response) => {
  const result = await commandService.remoteStop(requireUser(req), String(req.params.chargerId));
  sendSuccess(res, result, result.accepted ? 'Remote stop accepted' : 'Remote stop rejected by charger');
});

/** GET /chargers/:chargerId/connection — live gateway state, not the database mirror. */
export const getConnectionState = asyncHandler(async (req: Request, res: Response) => {
  const connection = await commandService.getConnectionState(
    requireUser(req),
    String(req.params.chargerId),
  );
  sendSuccess(res, { connection }, 'Connection state retrieved');
});
