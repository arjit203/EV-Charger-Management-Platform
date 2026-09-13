/**
 * Charging session HTTP handlers.
 *
 * Thin, as every controller in this project is. The only thing worth noticing here is the
 * status code on start: 202, not 201.
 */

import type { Request, Response } from 'express';

import * as sessionService from '../services/chargingSession.service';
import { ApiError } from '../utils/ApiError';
import { sendSuccess } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import type { ListSessionsQuery, ReadingsQuery, StartSessionInput } from '../validators/session.validator';

function requireUser(req: Request) {
  if (!req.user) throw ApiError.unauthorized('Authentication required.');
  return req.user;
}

/**
 * POST /charging/sessions
 *
 * 202 ACCEPTED, not 201 Created — and the distinction is the honest one.
 *
 * 201 would claim the charging session exists and is running. It is not: the charger has said
 * "Accepted, I will try", and nothing is charging until StartTransaction arrives moments later.
 * The client gets a session in `initiating` and polls (or, from Module 8, is pushed the
 * transition over Socket.IO).
 *
 * This is what a real physical side effect looks like in an API: the request succeeded, the
 * world has not caught up yet.
 */
export const startSession = asyncHandler(async (req: Request, res: Response) => {
  const session = await sessionService.startSession(
    requireUser(req),
    req.body as StartSessionInput,
  );

  sendSuccess(res, { session }, 'Charging start requested', 202);
});

/** POST /charging/sessions/:sessionId/stop */
export const stopSession = asyncHandler(async (req: Request, res: Response) => {
  const session = await sessionService.stopSession(requireUser(req), String(req.params.sessionId));

  const message =
    session.status === 'stopping' ? 'Charging stop requested' : `Session ${session.status}`;

  sendSuccess(res, { session }, message, 202);
});

/** GET /charging/sessions */
export const listSessions = asyncHandler(async (req: Request, res: Response) => {
  const result = await sessionService.listSessions(
    requireUser(req),
    req.query as unknown as ListSessionsQuery,
  );

  sendSuccess(res, result, 'Charging sessions retrieved');
});

/** GET /charging/sessions/active — the driver's own in-progress session, or null. */
export const getActiveSession = asyncHandler(async (req: Request, res: Response) => {
  const session = await sessionService.getActiveSessionForDriver(requireUser(req));
  sendSuccess(res, { session }, session ? 'Active session retrieved' : 'No active session');
});

/** GET /charging/sessions/:sessionId */
export const getSessionById = asyncHandler(async (req: Request, res: Response) => {
  const session = await sessionService.getSessionById(
    requireUser(req),
    String(req.params.sessionId),
  );

  sendSuccess(res, { session }, 'Charging session retrieved');
});

/** GET /charging/sessions/:sessionId/readings — the energy curve. */
export const listSessionReadings = asyncHandler(async (req: Request, res: Response) => {
  const { limit } = req.query as unknown as ReadingsQuery;

  const readings = await sessionService.listSessionReadings(
    requireUser(req),
    String(req.params.sessionId),
    limit,
  );

  sendSuccess(res, { readings, count: readings.length }, 'Meter readings retrieved');
});

/** GET /charging/connectors/:connectorId — what the QR code on the plug resolves to. */
export const getConnectorForCharging = asyncHandler(async (req: Request, res: Response) => {
  const connector = await sessionService.getConnectorForCharging(String(req.params.connectorId));
  sendSuccess(res, { connector }, 'Connector retrieved');
});
