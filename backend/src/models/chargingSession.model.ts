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

import { calculateAmountPaise, paiseToRupees } from '../utils/money';
import {
  SESSION_PAYMENT_STATUSES,
  type SessionPaymentStatus,
  SESSION_STATUSES,
  STOP_REASONS,
  OPEN_SESSION_STATUSES,
  type SessionStatus,
  type StopReason,
} from '../constants/session';
import { CHARGER_TYPES, type ChargerType } from '../constants/charger';
import { CONNECTOR_TYPES, type ConnectorType } from '../constants/connector';
import { ALL_ROLES, type Role } from '../constants/roles';

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
  /**
   * SNAPSHOTS of the hardware at start — AC/DC and the plug standard.
   *
   * Copied, not joined, for the same reason the price is: a session is a billing record (a CDR
   * in OCPI terms), and it must describe the equipment that was actually used even if the
   * charger is later reconfigured or the connector replaced. It also makes "all DC sessions"
   * or "all CHAdeMO sessions" a plain indexed filter instead of a join.
   *
   * Null only on sessions created before the field existed, until the backfill runs.
   */
  chargerType: ChargerType | null;
  connectorType: ConnectorType | null;

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

  /**
   * WHO asked for the stop, when it came from the platform rather than the charger's own button.
   *
   * `stopReason: 'Remote'` only says the stop arrived over OCPP. It cannot tell the driver pressing
   * Stop apart from an operator force-stopping their car — and the driver deserves to know which,
   * because one of them was not their decision. Every CPMS keeps this on the CDR for the same
   * reason: the first support call after a force-stop is "why did my charge end?".
   */
  stoppedByRole: Role | null;
  /** The staff member's stated reason for a force-stop. Shown to the driver. Null otherwise. */
  stopNote: string | null;

  /* ----------------------------- Module 9: pricing ---------------------------- */

  /** Provenance only. The snapshot below is what actually prices the session. */
  appliedTariffId: Types.ObjectId | null;
  appliedPricePerKwhPaise: number | null;
  amountPaise: number | null;

  /** Module 10. A denormalised projection of the session's PaymentTransaction. */
  paymentStatus: SessionPaymentStatus;

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

    /** Snapshots — see the interface note. */
    chargerType: { type: String, enum: CHARGER_TYPES, default: null },
    connectorType: { type: String, enum: CONNECTOR_TYPES, default: null },

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

    stoppedByRole: { type: String, enum: ALL_ROLES, default: null },
    stopNote: { type: String, trim: true, maxlength: 200, default: null },

    /* ---------------------------- Module 9: pricing --------------------------- */

    /**
     * WHICH tariff was in force. Provenance, not pricing.
     *
     * Kept alongside the snapshot below so an operator answering "why was I charged this?" in
     * Module 11 can point at the actual tariff document. Do NOT "simplify" this away on the
     * grounds that the snapshot already holds the number - the number says WHAT was charged,
     * this says WHICH price sheet said so, and a dispute needs both.
     */
    appliedTariffId: { type: Schema.Types.ObjectId, ref: 'Tariff', default: null },

    /**
     * THE RATE, SNAPSHOTTED WHEN THE SESSION STARTED. This is what prices the session.
     *
     * A `tariffId` reference alone would be wrong, and subtly so: an admin editing the rate
     * while a car is charging would retroactively reprice a session already in progress. Two
     * drivers plugging in at the same moment could be billed differently for the same
     * electricity depending on when the edit landed.
     *
     * Copying the VALUE at start time locks the price the instant charging is requested.
     * Whatever happens to the Tariff document afterwards - edited, deactivated, superseded -
     * cannot move this number. Same reasoning as Module 5's denormalised companyId
     * (denormalise when the source cannot be trusted to stay stable), applied to a field that
     * is explicitly EXPECTED to change.
     */
    appliedPricePerKwhPaise: { type: Number, default: null, min: 0 },

    /**
     * The final charge, in integer paise. Null until the session reaches a terminal state.
     *
     * Written by the pre('save') hook below, never by a caller, and NEVER from client input.
     */
    amountPaise: { type: Number, default: null, min: 0 },

    /**
     * MODULE 10 — has this charge been collected?
     *
     * A SEPARATE STATE MACHINE from `status`, and the separation is the point. A session can be
     * `completed` and `unpaid` at the same time: the electricity flowed, and the driver's wallet
     * was short. That is a correct state, not an error - you cannot un-deliver electricity.
     *
     *   unpaid  priced, not yet collected (the default the moment an amount exists)
     *   paid    settled, money actually moved
     *
     * There is deliberately no `failed` here. A short wallet is not a permanent failure - the
     * session stays `unpaid` and settles by itself when the driver tops up. The detail of WHY
     * it has not settled lives on the PaymentTransaction.
     *
     * DENORMALISED, and safe because of how it is written: this field and the authoritative
     * PaymentTransaction are updated inside the SAME transaction, so they cannot drift.
     */
    paymentStatus: {
      type: String,
      enum: SESSION_PAYMENT_STATUSES,
      required: true,
      default: 'unpaid',
      index: true,
    },
  },
  { timestamps: true },
);

/**
 * PRICE THE SESSION THE MOMENT IT ENDS - however it ends.
 *
 * This is a schema hook rather than a line in each service on purpose. A session reaches a
 * terminal state in FIVE places across two files:
 *
 *   sessionEvents.onStopTransaction            the normal end
 *   sessionEvents.failOpenSessionsForCharger   charger vanished mid-charge
 *   sessionEvents.sweepUnconfirmedSessions     start never confirmed
 *   chargingSession.markFailed                 charger rejected or timed out
 *   chargingSession.stopSession                stop requested while the charger was offline
 *
 * Pricing at each is five chances to forget, and a sixth call site added in a later module
 * would silently produce an unpriced session that Module 10 cannot settle. Putting it here
 * makes it structurally impossible to skip - the same instinct as the partial unique indexes,
 * applied to a different kind of correctness problem.
 *
 * FAILED SESSIONS ARE PRICED TOO. A session that died after delivering 0.4 kWh delivered real
 * electricity; billing zero would mean giving energy away on every network blip. A failure with
 * no energy prices at zero on its own, with no special case - which is why the condition below
 * is about the STATUS, not about how the session ended.
 *
 * Guarded on `amountPaise === null`, so a later save that touches some unrelated field cannot
 * recompute and overwrite a settled amount. Once priced, the number is final.
 *
 * Pure arithmetic on fields already present: no I/O, no await, no ordering hazard.
 */
chargingSessionSchema.pre('save', function computeAmount() {
  const isTerminal = this.status === 'completed' || this.status === 'failed';

  if (!isTerminal || this.amountPaise !== null) return;
  if (this.appliedPricePerKwhPaise === null) return;

  this.amountPaise = calculateAmountPaise(this.energyConsumedWh, this.appliedPricePerKwhPaise);

  /*
   * MODULE 10 — a session that cost nothing is settled on the spot.
   *
   * A start that failed before any energy flowed prices at zero. There is nothing to collect,
   * so it needs no wallet movement, no ledger entry and no PaymentTransaction - marking it paid
   * here keeps it out of the settlement sweeper forever.
   *
   * Everything else is left `unpaid` for the settlement service. Note what this hook does NOT
   * do: any I/O. Pricing is pure arithmetic and belongs here; collecting money is I/O with its
   * own failure modes and a transaction boundary, and would otherwise run inside whatever
   * happened to call save() - an OCPP message handler, the heartbeat sweep, anything.
   */
  if (this.amountPaise === 0) this.paymentStatus = 'paid';
});

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

/**
 * ONE OPEN SESSION PER DRIVER, enforced by MongoDB for the same reason as the per-connector rule.
 *
 * A driver has one car plugged in at a time; a second open session on the same account is either
 * a double-tap or a mistake, and either way it would hold a second plug hostage and bill energy
 * nobody can explain. The service checks first so it can name the session already running; this
 * index is what holds when two taps race past that check.
 */
chargingSessionSchema.index(
  { userId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: OPEN_SESSION_STATUSES } },
    name: 'one_open_session_per_driver',
  },
);

/** "My charging history, newest first" — the driver's main query. */
chargingSessionSchema.index({ userId: 1, startedAt: -1 });

/** The admin list, and the range scans Module 13's analytics will run. */
chargingSessionSchema.index({ companyId: 1, startedAt: -1 });

/**
 * The session LISTS sort by `requestedAt` (a session that never started still has one), which
 * the `startedAt` indexes above cannot serve — every page sorted the company's whole history
 * in memory.
 */
chargingSessionSchema.index({ companyId: 1, requestedAt: -1 });
chargingSessionSchema.index({ userId: 1, requestedAt: -1 });

/** The 5-second sweep for starts the charger never confirmed: status + age. */
chargingSessionSchema.index({ status: 1, requestedAt: 1 });

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
  chargerType: ChargerType | null;
  connectorType: ConnectorType | null;
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
  stoppedByRole: Role | null;
  stopNote: string | null;

  /**
   * Display labels, resolved at read time by `withSessionLabels` — never stored, so a renamed
   * station reads correctly. Absent on the bare real-time payloads; the client keeps the ones it
   * already has.
   */
  companyName?: string | null;
  stationName?: string | null;
  stationAddress?: string | null;
  stationCity?: string | null;
  chargerName?: string | null;
  powerKw?: number | null;
  /** Staff only — a driver already knows who they are. */
  driverName?: string | null;
  driverEmail?: string | null;

  /** Module 9. Null until the session ends. */
  appliedTariffId: string | null;
  appliedPricePerKwhPaise: number | null;
  amountPaise: number | null;
  /** Module 10 — has it been collected? Separate from `status`. */
  paymentStatus: SessionPaymentStatus;
  /**
   * Display convenience. Also what lets the browser show a LIVE cost estimate while charging:
   * Module 8 already streams `energyConsumedKwh`, so the estimate is that times the rate,
   * computed client-side with no new backend event.
   */
  amountRupees: number | null;

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
    chargerType: session.chargerType ?? null,
    connectorType: session.connectorType ?? null,
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
    stoppedByRole: session.stoppedByRole ?? null,
    stopNote: session.stopNote ?? null,
    appliedTariffId: session.appliedTariffId ? String(session.appliedTariffId) : null,
    appliedPricePerKwhPaise: session.appliedPricePerKwhPaise,
    amountPaise: session.amountPaise,
    paymentStatus: session.paymentStatus,
    amountRupees: session.amountPaise === null ? null : paiseToRupees(session.amountPaise),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}
