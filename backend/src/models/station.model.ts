/**
 * Station — the physical SITE where chargers are installed.
 *
 * A station is a place, not a machine:
 *
 *   Station  "Connaught Place, New Delhi"     <- a location
 *     └── Charger  DEL-014                    <- a machine at that location  (Module 5)
 *           └── Connector  CCS2 60kW          <- what a car plugs into        (Module 5)
 *
 * It is a separate entity because location data belongs to the site, not the machine.
 * Ten chargers in one car park share one address, one set of coordinates and one set of
 * opening hours — repeating that on every charger would duplicate data and let it drift.
 *
 * Ownership is `companyId`: every station belongs to exactly one CPO, which is what makes
 * revenue attribution and cross-company isolation possible.
 */

import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

import { STATION_STATUSES, type StationStatus } from '../constants/station';

export interface IStation {
  companyId: Types.ObjectId;
  name: string;
  stationCode: string;
  address: string;
  city: string;
  state: string;
  country: string;
  postalCode?: string;
  latitude: number;
  longitude: number;
  /**
   * GeoJSON copy of latitude/longitude, for "stations near me". DERIVED — never written
   * directly; the pre-validate hook below keeps it in step with the two plain numbers.
   */
  location?: { type: 'Point'; coordinates: [number, number] };
  status: StationStatus;
  contactPhone?: string;
  openingHours?: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type StationModel = Model<IStation>;

const stationSchema = new Schema<IStation, StationModel>(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },

    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 150 },

    /**
     * Human-readable site identifier, e.g. "DEL-CP-01".
     *
     * Not decoration: you cannot tell a field technician "go to station
     * 6aa6696c5a4fbcb3cdae0038". Unique PER COMPANY, not globally — two different CPOs may
     * legitimately both use "DEL-001", and a global constraint would let one company's
     * naming block another's, leaking the existence of their stations through 409s.
     */
    stationCode: { type: String, required: true, trim: true, uppercase: true, minlength: 2, maxlength: 40 },

    address: { type: String, required: true, trim: true, maxlength: 250 },
    city: { type: String, required: true, trim: true, maxlength: 100 },
    state: { type: String, required: true, trim: true, maxlength: 100 },
    country: { type: String, required: true, trim: true, maxlength: 100 },
    postalCode: { type: String, trim: true, maxlength: 20 },

    // The source of truth for position, and what the maps read. `location` below is derived
    // from these two — the additive migration this comment used to promise, now that
    // "stations near me" exists.
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },

    /**
     * GeoJSON Point for geospatial queries. Note the order: GeoJSON is [LONGITUDE, LATITUDE],
     * the reverse of how people say coordinates — the single most common geo bug.
     */
    location: {
      type: { type: String, enum: ['Point'], default: undefined },
      coordinates: { type: [Number], default: undefined },
    },

    status: { type: String, enum: STATION_STATUSES, required: true, default: 'active', index: true },

    /** Someone a driver can call when a site is blocked or a barrier is down. */
    contactPhone: { type: String, trim: true, maxlength: 20 },

    /**
     * Free text, e.g. "24x7" or "06:00-22:00".
     *
     * Deliberately NOT a structured per-day schedule: that is a real feature with real
     * complexity (holidays, split shifts, timezones) and no consumer yet.
     */
    openingHours: { type: String, trim: true, maxlength: 120 },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

/**
 * Unique per company — see the `stationCode` comment above.
 * This enforces the rule at the database, not just in application code, so two concurrent
 * creates cannot both slip through.
 */
stationSchema.index({ companyId: 1, stationCode: 1 }, { unique: true });

/** The common list view: "my company's active stations". */
stationSchema.index({ companyId: 1, status: 1 });

/** "Stations near me" — `$geoNear` requires a 2dsphere index and refuses to run without one. */
stationSchema.index({ location: '2dsphere' });

/**
 * Keep `location` in step with latitude/longitude on every create and save. Every write path
 * in the services goes through `create()` or `save()`, so this is the one place it can drift
 * — and it cannot, because it is recomputed every time.
 */
stationSchema.pre('validate', function syncLocation() {
  if (typeof this.latitude === 'number' && typeof this.longitude === 'number') {
    this.location = { type: 'Point', coordinates: [this.longitude, this.latitude] };
  }
});

export const Station = model<IStation, StationModel>('Station', stationSchema);

export type StationDocument = HydratedDocument<IStation>;

/** Explicit allow-list, same reasoning as `toPublicUser` / `toPublicCompany`. */
export interface PublicStation {
  id: string;
  companyId: string;
  name: string;
  stationCode: string;
  address: string;
  city: string;
  state: string;
  country: string;
  postalCode: string | null;
  latitude: number;
  longitude: number;
  status: StationStatus;
  contactPhone: string | null;
  openingHours: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export function toPublicStation(station: StationDocument): PublicStation {
  return {
    id: String(station._id),
    companyId: String(station.companyId),
    name: station.name,
    stationCode: station.stationCode,
    address: station.address,
    city: station.city,
    state: station.state,
    country: station.country,
    postalCode: station.postalCode ?? null,
    latitude: station.latitude,
    longitude: station.longitude,
    status: station.status,
    contactPhone: station.contactPhone ?? null,
    openingHours: station.openingHours ?? null,
    createdBy: String(station.createdBy),
    createdAt: station.createdAt.toISOString(),
    updatedAt: station.updatedAt.toISOString(),
  };
}
