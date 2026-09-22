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

import {
  CHARGER_HARDWARE_STATUSES,
  CHARGER_STATUSES,
  CHARGER_TYPES,
  type ChargerHardwareStatus,
  type ChargerStatus,
  type ChargerType,
} from '../constants/charger';

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
  /* --- Module 6: connectivity + self-reported health, written ONLY by the OCPP gateway --- */
  isOnline: boolean;
  lastHeartbeatAt: Date | null;
  hardwareStatus: ChargerHardwareStatus;
  faultCode: string | null;
  faultReportedAt: Date | null;
  authTokenHash?: string;
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

    /**
     * MODULE 6 — connectivity and self-reported health, DIFFERENT concerns from `status`.
     *
     *   status           administrative: a human says this machine is in maintenance
     *   isOnline         connectivity:   is the OCPP WebSocket currently up
     *   hardwareStatus   self-reported:  what the MACHINE says about itself (connectorId 0)
     *   Connector.status operational:    is THIS plug free / charging / faulted
     *
     * Four orthogonal things. These are written only by the gateway; Module 5's admin CRUD
     * cannot touch them, and the gateway never touches `status`. A charger can be online,
     * administratively available, and still reporting a fault — all three at once, which is
     * precisely why they are not one field.
     */
    isOnline: { type: Boolean, required: true, default: false, index: true },
    lastHeartbeatAt: { type: Date, default: null },

    /**
     * What the charge point last said about ITSELF, via `StatusNotification` on connectorId 0.
     *
     * `operative` is the default because silence is not a fault: a charger that has never sent
     * a charge-point-level status has not claimed to be broken, and defaulting to anything
     * else would take every existing charger out of service on deploy.
     */
    hardwareStatus: {
      type: String,
      enum: CHARGER_HARDWARE_STATUSES,
      required: true,
      default: 'operative',
      index: true,
    },

    /**
     * The OCPP `errorCode` that came with the fault — `GroundFailure`, `OverTemperature`,
     * `PowerMeterFailure` and so on. Kept because "faulted" alone does not tell an engineer
     * whether to drive out with a fuse or a whole new power module.
     */
    faultCode: { type: String, trim: true, maxlength: 64, default: null },

    /** When the fault was first reported. Cleared when the charger reports itself healthy. */
    faultReportedAt: { type: Date, default: null },

    /**
     * bcrypt hash of the charger's connection token (Module 6).
     *
     * `select: false` and never returned by any endpoint — the plaintext is shown exactly
     * once, when the charger is created or its token is regenerated, like an API key. A
     * database dump therefore yields no working charger credentials.
     */
    authTokenHash: { type: String, select: false },

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
  isOnline: boolean;
  lastHeartbeatAt: string | null;
  hardwareStatus: ChargerHardwareStatus;
  faultCode: string | null;
  faultReportedAt: string | null;
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
    isOnline: charger.isOnline,
    lastHeartbeatAt: charger.lastHeartbeatAt ? charger.lastHeartbeatAt.toISOString() : null,
    hardwareStatus: charger.hardwareStatus,
    faultCode: charger.faultCode ?? null,
    faultReportedAt: charger.faultReportedAt ? charger.faultReportedAt.toISOString() : null,
    createdBy: String(charger.createdBy),
    createdAt: charger.createdAt.toISOString(),
    updatedAt: charger.updatedAt.toISOString(),
  };
}
