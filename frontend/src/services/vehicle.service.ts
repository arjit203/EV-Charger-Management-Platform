import { apiRequest } from './apiClient';
import type { ConnectorType, Vehicle, VehiclePayload } from '@/types/api';

export interface VehicleInput {
  make: string;
  model: string;
  registrationNumber: string;
  connectorType: ConnectorType;
  batteryCapacityKwh?: number;
}

/**
 * Driver self-service only.
 *
 * Note no function here takes an owner id. The backend derives ownership from the
 * authenticated request and rejects a `userId`/`ownerId` in the body with 422, so there is
 * nothing for the client to get wrong.
 */
export async function listMyVehicles(): Promise<Vehicle[]> {
  const { vehicles } = await apiRequest<{ vehicles: Vehicle[] }>('/users/me/vehicles', {
    cache: 'no-store',
  });
  return vehicles;
}

export async function getMyVehicle(vehicleId: string): Promise<Vehicle> {
  const { vehicle } = await apiRequest<VehiclePayload>(`/users/me/vehicles/${vehicleId}`, {
    cache: 'no-store',
  });
  return vehicle;
}

export async function createMyVehicle(input: VehicleInput): Promise<Vehicle> {
  const { vehicle } = await apiRequest<VehiclePayload>('/users/me/vehicles', {
    method: 'POST',
    body: input,
  });
  return vehicle;
}

export async function updateMyVehicle(
  vehicleId: string,
  input: Partial<VehicleInput> & { isActive?: boolean },
): Promise<Vehicle> {
  const { vehicle } = await apiRequest<VehiclePayload>(`/users/me/vehicles/${vehicleId}`, {
    method: 'PATCH',
    body: input,
  });
  return vehicle;
}

/** Soft delete — the vehicle is deactivated, not destroyed, so charging history survives. */
export async function deactivateMyVehicle(vehicleId: string): Promise<Vehicle> {
  const { vehicle } = await apiRequest<VehiclePayload>(`/users/me/vehicles/${vehicleId}`, {
    method: 'DELETE',
  });
  return vehicle;
}
