/**
 * MeterReading — one sample of the charger's energy counter during a session.
 *
 * The charger sends MeterValues every few seconds while charging. Each one is a snapshot:
 * "at 10:05:00, my lifetime counter read 12,500 Wh".
 *
 * WHY STORE EVERY SAMPLE instead of only keeping the latest number on the session?
 *   - the live graph in Module 8 needs the curve, not just the endpoint
 *   - a billing dispute in Module 10/11 is settled by the samples, not by one aggregate
 *   - if a session dies mid-charge, the last stored sample is what we bill from
 *
 * This is the first table in the project that grows without bound, so it is written to be cheap:
 * no denormalised company/station, no allow-list of a dozen fields — just the session link, the
 * timestamp and the numbers.
 */

import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

export interface IMeterReading {
  sessionId: Types.ObjectId;
  /**
   * The CHARGER's timestamp for this sample, taken from the OCPP payload — NOT our clock.
   *
   * It is the charger that measured the energy, so it is the charger's clock that describes
   * when. Our own receive time is kept separately as `createdAt`; the gap between the two is
   * network and queue delay, which matters when a charger buffers offline readings and floods
   * them on reconnect.
   */
  meterTimestamp: Date;
  /** Cumulative lifetime counter in watt-hours, exactly as the charger reported it. */
  energyWh: number;
  /** Instantaneous power in kW, if the charger sent it. Cosmetic — never used for billing. */
  powerKw: number | null;
  /** State of charge %, if the car reported it through the charger. */
  socPercent: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export type MeterReadingModel = Model<IMeterReading>;

const meterReadingSchema = new Schema<IMeterReading, MeterReadingModel>(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'ChargingSession', required: true },
    meterTimestamp: { type: Date, required: true },
    energyWh: { type: Number, required: true, min: 0 },
    powerKw: { type: Number, default: null, min: 0 },
    socPercent: { type: Number, default: null, min: 0, max: 100 },
  },
  { timestamps: true },
);

/**
 * IDEMPOTENCY — the same reading twice is stored once.
 *
 * OCPP chargers genuinely resend. A flaky link makes a charger repeat a MeterValues it already
 * sent; a charger that buffered readings while offline replays the whole backlog on reconnect.
 * Without this index the graph would grow duplicate points.
 *
 * The duplicate insert throws E11000, which the service swallows deliberately: a repeat is
 * expected traffic, not a client error. That is the difference between this index and the
 * session's — both use uniqueness, but one surfaces as 409 and one is silently absorbed.
 */
meterReadingSchema.index(
  { sessionId: 1, meterTimestamp: 1 },
  { unique: true, name: 'one_reading_per_session_timestamp' },
);

export const MeterReading = model<IMeterReading, MeterReadingModel>(
  'MeterReading',
  meterReadingSchema,
);

export type MeterReadingDocument = HydratedDocument<IMeterReading>;

export interface PublicMeterReading {
  id: string;
  sessionId: string;
  meterTimestamp: string;
  energyWh: number;
  powerKw: number | null;
  socPercent: number | null;
}

export function toPublicMeterReading(reading: MeterReadingDocument): PublicMeterReading {
  return {
    id: String(reading._id),
    sessionId: String(reading.sessionId),
    meterTimestamp: reading.meterTimestamp.toISOString(),
    energyWh: reading.energyWh,
    powerKw: reading.powerKw,
    socPercent: reading.socPercent,
  };
}
