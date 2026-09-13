/**
 * Vehicle — an EV owned by a driver.
 *
 * A separate collection rather than an array on the user, for two reasons:
 *   1. A driver can own several (a car and a scooter, with different connector types).
 *   2. Module 7's ChargingSession must reference WHICH vehicle was charged, and that needs
 *      a stable `_id` to point at. An array element buried in a user document has none.
 *
 * Ownership is `userId` and nothing else. Note it is deliberately NOT `companyId`: a driver
 * belongs to no company (`companyId` is null for drivers, locked in Module 1), so a company
 * filter would match every driver's vehicles simultaneously. Personal resources are scoped
 * by person.
 */

import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

import { CONNECTOR_TYPES, type ConnectorType } from '../constants/vehicle';

export interface IVehicle {
  userId: Types.ObjectId;
  make: string;
  model: string;
  registrationNumber: string;
  batteryCapacityKwh?: number;
  connectorType: ConnectorType;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type VehicleModel = Model<IVehicle>;

const vehicleSchema = new Schema<IVehicle, VehicleModel>(
  {
    // Indexed because EVERY vehicle query is scoped by owner — without it, each read
    // scans the whole collection.
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    make: { type: String, required: true, trim: true, maxlength: 60 },
    model: { type: String, required: true, trim: true, maxlength: 60 },

    // Unique because a registration plate identifies one physical car. Two accounts
    // claiming the same plate is a data error worth blocking at the database, not just
    // in application code.
    registrationNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      minlength: 4,
      maxlength: 20,
    },

    /** Usable pack size in kWh. Module 7 uses it to estimate charge percentage. */
    batteryCapacityKwh: { type: Number, min: 0.5, max: 400 },

    connectorType: { type: String, enum: CONNECTOR_TYPES, required: true },

    /**
     * Soft-delete flag. `DELETE` sets this to false rather than removing the row, because
     * Module 7's charging sessions will reference `vehicleId` — destroying the vehicle
     * would orphan the driver's charging history and any receipt attached to it.
     */
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

export const Vehicle = model<IVehicle, VehicleModel>('Vehicle', vehicleSchema);

export type VehicleDocument = HydratedDocument<IVehicle>;

/** Explicit allow-list, same reasoning as `toPublicUser` / `toPublicCompany`. */
export interface PublicVehicle {
  id: string;
  userId: string;
  make: string;
  model: string;
  registrationNumber: string;
  batteryCapacityKwh: number | null;
  connectorType: ConnectorType;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toPublicVehicle(vehicle: VehicleDocument): PublicVehicle {
  return {
    id: String(vehicle._id),
    userId: String(vehicle.userId),
    make: vehicle.make,
    model: vehicle.model,
    registrationNumber: vehicle.registrationNumber,
    batteryCapacityKwh: vehicle.batteryCapacityKwh ?? null,
    connectorType: vehicle.connectorType,
    isActive: vehicle.isActive,
    createdAt: vehicle.createdAt.toISOString(),
    updatedAt: vehicle.updatedAt.toISOString(),
  };
}
