/**
 * Connector HTTP handlers.
 *
 * Every handler passes the `chargerId` from the URL to the service, which verifies the whole
 * Company -> Station -> Charger chain before touching a connector. No handler trusts that id
 * on its own.
 */

import type { Request, Response } from 'express';

import * as connectorService from '../services/connector.service';
import { ApiError } from '../utils/ApiError';
import { sendSuccess } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import type { ConnectorStatus } from '../constants/connector';
import type {
  ConnectorStatusInput,
  CreateConnectorInput,
  ListConnectorsQuery,
  UpdateConnectorInput,
} from '../validators/connector.validator';

function requireUser(req: Request) {
  if (!req.user) throw ApiError.unauthorized('Authentication required.');
  return req.user;
}

/** GET /chargers/:chargerId/connectors */
export const listConnectors = asyncHandler(async (req: Request, res: Response) => {
  const connectors = await connectorService.listConnectors(
    requireUser(req),
    String(req.params.chargerId),
    req.query as unknown as ListConnectorsQuery,
  );
  sendSuccess(res, { connectors }, 'Connectors retrieved');
});

/** GET /chargers/:chargerId/connectors/:connectorId */
export const getConnector = asyncHandler(async (req: Request, res: Response) => {
  const connector = await connectorService.getConnector(
    requireUser(req),
    String(req.params.chargerId),
    String(req.params.connectorId),
  );
  sendSuccess(res, { connector }, 'Connector retrieved');
});

/** POST /chargers/:chargerId/connectors */
export const createConnector = asyncHandler(async (req: Request, res: Response) => {
  const connector = await connectorService.createConnector(
    requireUser(req),
    String(req.params.chargerId),
    req.body as CreateConnectorInput,
  );
  sendSuccess(res, { connector }, 'Connector added successfully', 201);
});

/** PATCH /chargers/:chargerId/connectors/:connectorId */
export const updateConnector = asyncHandler(async (req: Request, res: Response) => {
  const connector = await connectorService.updateConnector(
    requireUser(req),
    String(req.params.chargerId),
    String(req.params.connectorId),
    req.body as UpdateConnectorInput,
  );
  sendSuccess(res, { connector }, 'Connector updated successfully');
});

/** PATCH /chargers/:chargerId/connectors/:connectorId/status */
export const updateConnectorStatus = asyncHandler(async (req: Request, res: Response) => {
  const { status } = req.body as ConnectorStatusInput;
  const connector = await connectorService.setConnectorStatus(
    requireUser(req),
    String(req.params.chargerId),
    String(req.params.connectorId),
    status as ConnectorStatus,
  );
  sendSuccess(res, { connector }, `Connector marked ${status}`);
});
