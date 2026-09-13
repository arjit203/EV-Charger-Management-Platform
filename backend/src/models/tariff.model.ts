/**
 * Tariff — what a company charges for electricity.
 *
 * COMPANY-LEVEL, NOT STATION-LEVEL, and that is a deliberate choice rather than a simplification
 * waiting to be fixed. A CPO with forty stations almost always wants one pricing sheet across
 * them; per-station overrides bring a fallback rule with them ("which wins? what if the station
 * has none?") and there is no demonstrated need for that yet. Same call as Module 4's deferred
 * GeoJSON and Module 5's deferred connectivity fields.
 *
 * If it is ever needed, adding an optional `stationId` is purely ADDITIVE: null means "the
 * company default", and every row written today already satisfies that.
 *
 *   Company ──▶ Tariff ──▶ applies to every Station the company owns
 *
 * Six fields. Notably absent, each on purpose:
 *
 *   currency        one legal value is not a field — see utils/money.ts
 *   pricingType     one legal value; adding it later with a 'per_kwh' default is non-breaking
 *   effectiveFrom/To  with one active tariff and a rate snapshotted at session start, date
 *                     ranges add boundary questions nothing is asking
 */

import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

import {
  MAX_PRICE_PER_KWH_PAISE,
  MIN_PRICE_PER_KWH_PAISE,
  TARIFF_STATUSES,
  type TariffStatus,
} from '../constants/tariff';
import { paiseToRupees } from '../utils/money';

export interface ITariff {
  companyId: Types.ObjectId;
  name: string;
  /**
   * INTEGER PAISE per kilowatt-hour. ₹12.00/kWh is stored as 1200.
   *
   * Never rupees, never a float. See `utils/money.ts` for why — briefly: floats cannot
   * represent decimal fractions exactly, so a total built from them drifts, and the drift is
   * invisible until a customer disputes a bill.
   */
  pricePerKwhPaise: number;
  status: TariffStatus;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type TariffModel = Model<ITariff>;

const tariffSchema = new Schema<ITariff, TariffModel>(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },

    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },

    pricePerKwhPaise: {
      type: Number,
      required: true,
      min: MIN_PRICE_PER_KWH_PAISE,
      max: MAX_PRICE_PER_KWH_PAISE,
      // Guards the invariant at the schema level too: a fractional paise is not money.
      validate: {
        validator: Number.isInteger,
        message: 'Price must be a whole number of paise.',
      },
    },

    // New tariffs start inactive. Activating is a separate, deliberate act, because activation
    // is what deactivates the incumbent and changes what every future charge costs.
    status: { type: String, enum: TARIFF_STATUSES, required: true, default: 'inactive', index: true },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

/**
 * THE INVARIANT: at most ONE active tariff per company, enforced by MongoDB.
 *
 * The race this closes: two admins activate different tariffs at the same moment. Both pass an
 * application-level "is another one active?" check, both write, and the company now has two
 * rates with no deterministic answer to "what does a charge cost?".
 *
 * A partial unique index makes the second write fail with E11000, which Module 1's error
 * middleware already maps to 409. Identical mechanism and identical reasoning to Module 7's
 * one-open-session-per-connector: a rule that must hold under concurrency belongs in the
 * database, not in an `if`.
 *
 * `inactive` rows are excluded by the filter, so a company can keep any number of them for
 * history.
 */
tariffSchema.index(
  { companyId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'active' },
    name: 'one_active_tariff_per_company',
  },
);

/** The lookup performed on every session start: "this company's active tariff". */
tariffSchema.index({ companyId: 1, status: 1 });

export const Tariff = model<ITariff, TariffModel>('Tariff', tariffSchema);

export type TariffDocument = HydratedDocument<ITariff>;

/** Explicit allow-list, consistent with every other model in the project. */
export interface PublicTariff {
  id: string;
  companyId: string;
  name: string;
  pricePerKwhPaise: number;
  /** Convenience for display and for form inputs. NEVER fed back into a calculation. */
  pricePerKwhRupees: number;
  status: TariffStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export function toPublicTariff(tariff: TariffDocument): PublicTariff {
  return {
    id: String(tariff._id),
    companyId: String(tariff.companyId),
    name: tariff.name,
    pricePerKwhPaise: tariff.pricePerKwhPaise,
    pricePerKwhRupees: paiseToRupees(tariff.pricePerKwhPaise),
    status: tariff.status,
    createdBy: String(tariff.createdBy),
    createdAt: tariff.createdAt.toISOString(),
    updatedAt: tariff.updatedAt.toISOString(),
  };
}
