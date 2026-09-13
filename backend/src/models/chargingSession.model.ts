/**
 * ChargingSession — one car's visit to one plug.
 *
 * This is the BUSINESS TRANSACTION that Module 6's protocol plumbing exists to serve:
 *
 *   Module 6 answers  "can the charger talk to us?"
 *   Module 7 answers  "who charged, where, for how long, and how much energy flowed?"
 *
 * A charger is a permanent asset; a session is a temporary event. One charger accumulates
 * thousands of sessions over its life — confusing the two is like confusing a cash register
 * with a sale.
 */

import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

import {
  SESSION_STATUSES,
  STOP_REASONS,
  OPEN_SESSION_STATUSES,
  type SessionStatus,
  type StopReason,
} from '../constants/session';

export interface IChargingSession {
  /** OWNERSHIP. Always from the verified token, never from a request body. */
  userId: Types.ObjectId;
  /** Which car was charged. Optional — Module 3 built Vehicle for exactly this. */
  vehicleId: Types.ObjectId | null;

  companyId: Types.ObjectId;
  stationId: Types.ObjectId;
  chargerId: Types.ObjectId;
  connectorId: Types.ObjectId;
  connectorNumber: number;

  /** The CHARGER's id for this transaction. Null until StartTransaction confirms. */
  transactionId: number | null;
  /** The credential this session issued to the charger. See the schema note below. */
  idTag: string;

  status: SessionStatus;

  requestedAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;

  startMeterWh: number | null;
  lastMeterWh: number | null;
  endMeterWh: number | null;
  energyConsumedWh: number;

  stopReason: StopReason | null;
  failureReason: string | null;

  createdAt: Date;
  updatedAt: Date;
}

export type ChargingSessionModel = Model<IChargingSession>;

const chargingSessionSchema = new Schema<IChargingSession, ChargingSessionModel>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', default: null },

    /**
     * DENORMALISED from the verified charger at creation, never from input.
     *
     * Safe for the same reason as Module 5's charger: a charger's company and station are both
     * immutable. It buys a single-filter company scope, and lets Module 13's analytics use
     * `$match: { companyId }` as the FIRST aggregation stage instead of joining three
     * collections.
     */
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
    stationId: { type: Schema.Types.ObjectId, ref: 'Station', required: true },

    chargerId: { type: Schema.Types.ObjectId, ref: 'Charger', required: true },
    connectorId: { type: Schema.Types.ObjectId, ref: 'Connector', required: true },

    /** Denormalised: OCPP addresses connectors by number, and this survives a connector edit. */
    connectorNumber: { type: Number, required: true, min: 1, max: 8 },

    /**
     * The OCPP transaction id — the CHARGER's identifier for this event, which it echoes in
     * every MeterValues and StopTransaction.
     *
     * Distinct from this document's `_id` on purpose. The OCPP id is an integer scoped to the
     * protocol and reused across restarts of real hardware; `_id` is the permanent record key
     * that payments and complaints will reference later and that hardware never sees.
     */
    transactionId: { type: Number, default: null },

    /**
     * The OCPP idTag issued for THIS session — a random 20-character token.
     *
     * This is what finally makes Module 6's `Authorize` handler real. Until now it accepted
     * any well-formed tag, because there was nothing to check a tag against. Now there is:
     * a tag is valid only while an open session is holding it, so a charger cannot authorize
     * a driver who never asked to charge.
     *
     * It is also the correlation key. When StartTransaction arrives, the tag identifies which
     * session it belongs to precisely, without guessing from connector numbers.
     */
    idTag: { type: String, required: true },

    status: { type: String, enum: SESSION_STATUSES, required: true, default: 'initiating' },

    /** requestedAt != startedAt: the gap is the OCPP round trip to the charger and back. */
    requestedAt: { type: Date, required: true, default: () => new Date() },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },

    // Cumulative counter readings, in watt-hours. Wh rather than kWh to match what OCPP
    // carries and to avoid float drift on small increments.
    startMeterWh: { type: Number, default: null },
    lastMeterWh: { type: Number, default: null },
    endMeterWh: { type: Number, default: null },

    /** Always >= 0. A cumulative meter cannot deliver negative energy. */
    energyConsumedWh: { type: Number, required: true, default: 0, min: 0 },

    stopReason: { type: String, enum: STOP_REASONS, default: null },
    failureReason: { type: String, maxlength: 200, default: null },
  },
  { timestamps: true },
);

/**
 * THE CONCURRENCY GUARANTEE — one open session per connector, enforced by MongoDB.
 *
 * The race this closes: two drivers press start on the same connector at the same moment.
 * Both pass an application-level "is there an active session?" check, and both insert. Classic
 * check-then-act.
 *
 * A partial unique index makes the second insert fail with E11000, which Module 1's error
 * middleware already maps to 409. Same philosophy as ocppId, stationCode and connectorNumber:
 * if a rule must hold under concurrency, the database enforces it, not an `if`.
 */
chargingSessionSchema.index(
  { connectorId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: OPEN_SESSION_STATUSES } },
    name: 'one_open_session_per_connector',
  },
);

/** "My charging history, newest first" — the driver's main query. */
chargingSessionSchema.index({ userId: 1, startedAt: -1 });

/** The admin list, and the range scans Module 13's analytics will run. */
chargingSessionSchema.index({ companyId: 1, startedAt: -1 });

/** "Any open session on this charger?" — run on every charger disconnect. */
chargingSessionSchema.index({ chargerId: 1, status: 1 });

/**
 * Correlating an inbound OCPP message to its session.
 *
 * PARTIAL, NOT SPARSE — a distinction that cost a real bug. A sparse index only skips
 * documents where the field is ABSENT, and every session stores `transactionId: null` until
 * the charger confirms. Under `sparse` the second unconfirmed session in the database collides
 * with the first on a null-vs-null duplicate, and starting a charge fails for no visible
 * reason. Filtering on `$type: 'number'` indexes only sessions that actually have an id.
 */
chargingSessionSchema.index(
  { transactionId: 1 },
  {
    unique: true,
    partialFilterExpression: { transactionId: { $type: 'number' } },
    name: 'unique_confirmed_transaction_id',
  },
);

/** Authorize and StartTransaction both look a session up by the tag they were given. */
chargingSessionSchema.index({ idTag: 1 }, { unique: true });

export const ChargingSession = model<IChargingSession, ChargingSessionModel>(
  'ChargingSession',
  chargingSessionSchema,
);

export type ChargingSessionDocument = HydratedDocument<IChargingSession>;

/** Explicit allow-list, consistent with every other model in the project. */
export interface PublicChargingSession {
  id: string;
  userId: string;
  vehicleId: string | null;
  companyId: string;
  stationId: string;
  chargerId: string;
  connectorId: string;
  connectorNumber: number;
  transactionId: number | null;
  status: SessionStatus;
  /**
   * Returned ONLY to the session's own driver and to staff. It is a live credential while the
   * session is open, so it is not part of any public/aggregate view.
   */
  idTag: string;
  requestedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  startMeterWh: number | null;
  lastMeterWh: number | null;
  endMeterWh: number | null;
  energyConsumedWh: number;
  /** Convenience for the UI — the same number the bill will be based on in Module 9/10. */
  energyConsumedKwh: number;
  /** Null while the session is still running. */
  durationSeconds: number | null;
  stopReason: StopReason | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toPublicChargingSession(
  session: ChargingSessionDocument,
): PublicChargingSession {
  const endForDuration = session.endedAt ?? null;

  return {
    id: String(session._id),
    userId: String(session.userId),
    vehicleId: session.vehicleId ? String(session.vehicleId) : null,
    companyId: String(session.companyId),
    stationId: String(session.stationId),
    chargerId: String(session.chargerId),
    connectorId: String(session.connectorId),
    connectorNumber: session.connectorNumber,
    transactionId: session.transactionId,
    status: session.status,
    idTag: session.idTag,
    requestedAt: session.requestedAt.toISOString(),
    startedAt: session.startedAt ? session.startedAt.toISOString() : null,
    endedAt: endForDuration ? endForDuration.toISOString() : null,
    startMeterWh: session.startMeterWh,
    lastMeterWh: session.lastMeterWh,
    endMeterWh: session.endMeterWh,
    energyConsumedWh: session.energyConsumedWh,
    energyConsumedKwh: Number((session.energyConsumedWh / 1000).toFixed(3)),
    durationSeconds:
      session.startedAt && endForDuration
        ? Math.max(0, Math.round((endForDuration.getTime() - session.startedAt.getTime()) / 1000))
        : null,
    stopReason: session.stopReason,
    failureReason: session.failureReason,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}
