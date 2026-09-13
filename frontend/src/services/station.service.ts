import { apiRequest } from './apiClient';
import type { Paginated, Station, StationPayload, StationStatus } from '@/types/api';

export interface StationInput {
  name: string;
  stationCode: string;
  address: string;
  city: string;
  state: string;
  country: string;
  postalCode?: string;
  latitude: number;
  longitude: number;
  contactPhone?: string;
  openingHours?: string;
  /** Only used by super_admin. A cpo_admin's company is taken from their token. */
  companyId?: string;
}

export interface ListStationsParams {
  page?: number;
  limit?: number;
  status?: StationStatus;
  city?: string;
  /** super_admin only — the backend refuses a scoped role naming another company. */
  companyId?: string;
  search?: string;
}

/**
 * super_admin sees every station; cpo_admin and operator see only their own company's.
 * The scoping happens server-side inside the query, so this call is identical for all roles.
 */
export function listStations(params: ListStationsParams = {}): Promise<Paginated<Station>> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const suffix = query.toString() ? `?${query}` : '';
  return apiRequest<Paginated<Station>>(`/stations${suffix}`, { cache: 'no-store' });
}

export async function getStation(stationId: string): Promise<Station> {
  const { station } = await apiRequest<StationPayload>(`/stations/${stationId}`, {
    cache: 'no-store',
  });
  return station;
}

export async function createStation(input: StationInput): Promise<Station> {
  const { station } = await apiRequest<StationPayload>('/stations', {
    method: 'POST',
    body: input,
  });
  return station;
}

/** Details only — the backend rejects `status` and `companyId` here. */
export async function updateStation(
  stationId: string,
  input: Partial<StationInput>,
): Promise<Station> {
  const { station } = await apiRequest<StationPayload>(`/stations/${stationId}`, {
    method: 'PATCH',
    body: input,
  });
  return station;
}

/**
 * Change status. A cpo_admin may set `active`/`inactive`; only a super_admin may set or
 * clear `suspended`, which is a platform sanction.
 */
export async function setStationStatus(
  stationId: string,
  status: StationStatus,
): Promise<Station> {
  const { station } = await apiRequest<StationPayload>(`/stations/${stationId}/status`, {
    method: 'PATCH',
    body: { status },
  });
  return station;
}
