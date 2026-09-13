/**
 * OCPP diagnostics HTTP handler.
 *
 * Module 6 also exposed remote-start and remote-stop here. Module 7 retired them: commanding a
 * charger to deliver power is now only possible through the session service, so that a record
 * of the charge always exists before any energy flows.
 *
 * What remains is a read-only window into the live gateway — useful for an admin asking "is
 * this machine actually connected right now?", and incapable of changing anything.
 */

import type { Request, Response } from 'express';

import * as commandService from '../services/chargerCommand.service';
import { ApiError } from '../utils/ApiError';
import { sendSuccess } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';

function requireUser(req: Request) {
  if (!req.user) throw ApiError.unauthorized('Authentication required.');
  return req.user;
}

/** GET /chargers/:chargerId/connection — live gateway state, not the database mirror. */
export const getConnectionState = asyncHandler(async (req: Request, res: Response) => {
  const connection = await commandService.getConnectionState(
    requireUser(req),
    String(req.params.chargerId),
  );
  sendSuccess(res, { connection }, 'Connection state retrieved');
});
