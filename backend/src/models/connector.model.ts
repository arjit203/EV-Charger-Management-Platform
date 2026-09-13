/**
 * Connector — an individual plug on a charger.
 *
 * A separate collection rather than fields on the charger, for two reasons:
 *   1. A two-plug charger can have one connector occupied and one free — two independent
 *      states on one machine, which a flat field cannot represent.
 *   2. Module 7's ChargingSession must reference WHICH plug is in use, and that needs a
 *      stable `_id` to point at.
 *
 * Ownership is `chargerId` only. There is deliberately no denormalised `companyId`:
 * connectors are always reached through their charger (`/chargers/:chargerId/connectors`),
 * so the company is verified once at the charger hop and the connector query is then a
 * simple `{ chargerId }`. Adding one would be denormalisation with no query to serve.
 */

import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

import {
  CONNECTOR_STATUSES,
  CONNECTOR_TYPES,
  type ConnectorStatus,
  type ConnectorType,
} from '../constants/connector';

export interface IConnector {
  chargerId: Types.ObjectId;
  connectorNumber: number;
  connectorType: ConnectorType;
  powerKw: number;
  status: ConnectorStatus;
  errorCode?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ConnectorModel = Model<IConnector>;

const connectorSchema = new Schema<IConnector, ConnectorModel>(
  {
    /** Parent machine. Immutable — a plug cannot move to another charger. */
    chargerId: { type: Schema.Types.ObjectId, ref: 'Charger', required: true, index: true },

    /**
     * Physical position on the charger, starting at 1.
     *
     * Not cosmetic: OCPP addresses connectors by number, so Module 6 will use this to route
     * a StatusNotification or a RemoteStartTransaction to the right plug.
     */
    connectorNumber: { type: Number, required: true, min: 1, max: 8 },

    /** Shared enum with the driver's Vehicle, so Module 7 can match car to plug. */
    connectorType: { type: String, enum: CONNECTOR_TYPES, required: true },

    /** This plug's rating, which can be lower than the charger's maximum. */
    powerKw: { type: Number, required: true, min: 1, max: 1000 },

    status: { type: String, enum: CONNECTOR_STATUSES, required: true, default: 'available', index: true },

    /** Populated by Module 6 from OCPP fault reports. Admin-settable meanwhile. */
    errorCode: { type: String, trim: true, maxlength: 64, default: null },
  },
  { timestamps: true },
);

/**
 * A charger cannot have two connectors numbered the same — enforced at the database, so two
 * concurrent creates cannot both slip through an application-level check.
 */
connectorSchema.index({ chargerId: 1, connectorNumber: 1 }, { unique: true });

export const Connector = model<IConnector, ConnectorModel>('Connector', connectorSchema);

export type ConnectorDocument = HydratedDocument<IConnector>;

export interface PublicConnector {
  id: string;
  chargerId: string;
  connectorNumber: number;
  connectorType: ConnectorType;
  powerKw: number;
  status: ConnectorStatus;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toPublicConnector(connector: ConnectorDocument): PublicConnector {
  return {
    id: String(connector._id),
    chargerId: String(connector.chargerId),
    connectorNumber: connector.connectorNumber,
    connectorType: connector.connectorType,
    powerKw: connector.powerKw,
    status: connector.status,
    errorCode: connector.errorCode ?? null,
    createdAt: connector.createdAt.toISOString(),
    updatedAt: connector.updatedAt.toISOString(),
  };
}
