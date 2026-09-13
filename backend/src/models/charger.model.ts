/**
 * Charger — the physical machine (EVSE) installed at a station.
 *
 *   Station  "Connaught Place"        <- a location            (Module 4)
 *     └── Charger  DEL-CP-01-A        <- THIS: a machine
 *           └── Connector  CCS2 60kW  <- a plug                (connector.model.ts)
 *
 * Module 6's OCPP gateway resolves an incoming WebSocket connection to a row in this
 * collection using `ocppId` — see the comment on that field.
 */

import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

import { CHARGER_STATUSES, CHARGER_TYPES, type ChargerStatus, type ChargerType } from '../constants/charger';

export interface ICharger {
  stationId: Types.ObjectId;
  companyId: Types.ObjectId;
  name: string;
  chargerCode: string;
  ocppId: string;
  manufacturer: string;
  model: string;
  chargerType: ChargerType;
  powerKw: number;
  firmwareVersion?: string;
  status: ChargerStatus;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type ChargerModel = Model<ICharger>;

const chargerSchema = new Schema<ICharger, ChargerModel>(
  {
    /** Parent site. Immutable — relocating hardware between sites is a deliberate later feature. */
    stationId: { type: Schema.Types.ObjectId, ref: 'Station', required: true, index: true },

    /**
     * DENORMALISED from the station, and safe to denormalise because a station can never
     * change company: Module 4's update schema has no `companyId` field and rejects one.
     * So this mirror cannot go stale.
     *
     * It buys two things: `applyCompanyScope` works directly on Charger with no `$lookup`,
     * and Module 6's gateway — which looks a charger up by `ocppId` on every connection —
     * gets the company without a join on a hot path.
     *
     * Always set server-side from the VERIFIED station. Never accepted from a request body.
     */
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },

    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 150 },

    /** Site-facing label, e.g. "01". Unique PER STATION — site signage numbers per site. */
    chargerCode: { type: String, required: true, trim: true, uppercase: true, minlength: 1, maxlength: 40 },

    /**
     * OCPP charge point identity — GLOBALLY UNIQUE, and deliberately the OPPOSITE rule to
     * every other identifier in this project (stationCode is per company, chargerCode is per
     * station).
     *
     * DO NOT "fix" this for consistency. When a charger connects in Module 6 it sends a
     * BootNotification carrying only this identity. The gateway has NO company context at
     * that moment — it must answer "which charger record is this?" across the entire
     * platform. If two companies could share an identity, the gateway could not tell which
     * hardware connected, and could route a remote start to the wrong company's charger.
     *
     * Accepted trade-off: a 409 here reveals that some other company already uses that
     * identity. In practice these are vendor serial numbers, so collisions are unlikely,
     * and an unroutable charger connection would be far worse.
     */
    ocppId: { type: String, required: true, unique: true, trim: true, minlength: 3, maxlength: 64 },

    manufacturer: { type: String, required: true, trim: true, maxlength: 100 },
    model: { type: String, required: true, trim: true, maxlength: 100 },

    chargerType: { type: String, enum: CHARGER_TYPES, required: true },

    /** Maximum output in kW. Individual connectors carry their own rating. */
    powerKw: { type: Number, required: true, min: 1, max: 1000 },

    /** Recorded for asset management only. Firmware updates are not implemented. */
    firmwareVersion: { type: String, trim: true, maxlength: 50 },

    status: { type: String, enum: CHARGER_STATUSES, required: true, default: 'available', index: true },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

/** Unique per station — two sites in one company may each have a charger "01". */
chargerSchema.index({ stationId: 1, chargerCode: 1 }, { unique: true });

/** The common filtered list: "my company's available chargers". */
chargerSchema.index({ companyId: 1, status: 1 });

export const Charger = model<ICharger, ChargerModel>('Charger', chargerSchema);

export type ChargerDocument = HydratedDocument<ICharger>;

/** Explicit allow-list, consistent with every other model in the project. */
export interface PublicCharger {
  id: string;
  stationId: string;
  companyId: string;
  name: string;
  chargerCode: string;
  ocppId: string;
  manufacturer: string;
  model: string;
  chargerType: ChargerType;
  powerKw: number;
  firmwareVersion: string | null;
  status: ChargerStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export function toPublicCharger(charger: ChargerDocument): PublicCharger {
  return {
    id: String(charger._id),
    stationId: String(charger.stationId),
    companyId: String(charger.companyId),
    name: charger.name,
    chargerCode: charger.chargerCode,
    ocppId: charger.ocppId,
    manufacturer: charger.manufacturer,
    model: charger.model,
    chargerType: charger.chargerType,
    powerKw: charger.powerKw,
    firmwareVersion: charger.firmwareVersion ?? null,
    status: charger.status,
    createdBy: String(charger.createdBy),
    createdAt: charger.createdAt.toISOString(),
    updatedAt: charger.updatedAt.toISOString(),
  };
}
