/**
 * Connector business logic — HOP 3 of the ownership chain.
 *
 * Every function here starts by calling `assertChargerInScope`, which resolves the parent
 * charger through the caller's company scope. That single call verifies the whole chain:
 *
 *   caller's company -> station -> charger
 *
 * Only then is the connector touched, filtered by `chargerId`. A `chargerId` supplied by a
 * malicious client resolves to nothing, so there is no path to another company's connectors.
 */

import { type QueryFilter } from 'mongoose';

import {
  Connector,
  toPublicConnector,
  type IConnector,
  type PublicConnector,
} from '../models/connector.model';
import { assertChargerInScope } from './charger.service';
import type { ConnectorStatus } from '../constants/connector';
import { ApiError } from '../utils/ApiError';
import type { AuthUser } from '../types/express';
import type {
  CreateConnectorInput,
  ListConnectorsQuery,
  UpdateConnectorInput,
} from '../validators/connector.validator';

/**
 * Within a charger's own namespace, "not yours" and "doesn't exist" are the same fact, so a
 * plain 404 is correct here — the company check already happened at the charger hop.
 */
const connectorNotFound = () => ApiError.notFound('Connector not found.');

export async function listConnectors(
  actor: AuthUser,
  chargerId: string,
  query: ListConnectorsQuery,
): Promise<PublicConnector[]> {
  const charger = await assertChargerInScope(actor, chargerId);

  const filter: QueryFilter<IConnector> = { chargerId: charger._id };
  if (query.status) filter.status = query.status;
  if (query.connectorType) filter.connectorType = query.connectorType;

  const connectors = await Connector.find(filter).sort({ connectorNumber: 1 });
  return connectors.map(toPublicConnector);
}

export async function getConnector(
  actor: AuthUser,
  chargerId: string,
  connectorId: string,
): Promise<PublicConnector> {
  const charger = await assertChargerInScope(actor, chargerId);

  // Scoped by BOTH ids: a connector id from another charger cannot be read through this one.
  const connector = await Connector.findOne({ _id: connectorId, chargerId: charger._id });
  if (!connector) throw connectorNotFound();

  return toPublicConnector(connector);
}

export async function createConnector(
  actor: AuthUser,
  chargerId: string,
  input: CreateConnectorInput,
): Promise<PublicConnector> {
  const charger = await assertChargerInScope(actor, chargerId);

  // The compound unique index enforces this too; checking first gives a clearer message.
  const clash = await Connector.findOne({
    chargerId: charger._id,
    connectorNumber: input.connectorNumber,
  }).select('_id');

  if (clash) {
    throw ApiError.conflict(`This charger already has a connector numbered ${input.connectorNumber}.`);
  }

  const connector = await Connector.create({ ...input, chargerId: charger._id });
  return toPublicConnector(connector);
}

export async function updateConnector(
  actor: AuthUser,
  chargerId: string,
  connectorId: string,
  input: UpdateConnectorInput,
): Promise<PublicConnector> {
  const charger = await assertChargerInScope(actor, chargerId);

  const connector = await Connector.findOne({ _id: connectorId, chargerId: charger._id });
  if (!connector) throw connectorNotFound();

  if (input.connectorNumber && input.connectorNumber !== connector.connectorNumber) {
    const clash = await Connector.findOne({
      chargerId: charger._id,
      connectorNumber: input.connectorNumber,
      _id: { $ne: connector._id },
    }).select('_id');

    if (clash) {
      throw ApiError.conflict(`This charger already has a connector numbered ${input.connectorNumber}.`);
    }
  }

  connector.set(input);
  await connector.save();

  return toPublicConnector(connector);
}

export async function setConnectorStatus(
  actor: AuthUser,
  chargerId: string,
  connectorId: string,
  status: ConnectorStatus,
): Promise<PublicConnector> {
  const charger = await assertChargerInScope(actor, chargerId);

  const connector = await Connector.findOne({ _id: connectorId, chargerId: charger._id });
  if (!connector) throw connectorNotFound();

  connector.status = status;
  await connector.save();

  return toPublicConnector(connector);
}
