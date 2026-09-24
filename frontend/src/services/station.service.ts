import { apiRequest } from './apiClient';
import type {
  MapStation,
  MapStationsPayload,
  Paginated,
  PublicMapStation,
  Station,
  StationPayload,
  StationStatus,
} from '@/types/api';

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

/* -------------------------------------------------------------------------- */
/* Module 14 — map reads                                                      */
/* -------------------------------------------------------------------------- */

export interface MapStationsParams {
  search?: string;
  city?: string;
  status?: StationStatus;
  /** super_admin only, and only on the staff map. */
  companyId?: string;
  limit?: number;
}

function mapQuery(params: MapStationsParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.toString() ? `?${search}` : '';
}

/**
 * Staff markers — company-scoped by the backend.
 *
 * Which of these two functions the UI calls is decided by role, but that is a CONVENIENCE,
 * not the boundary: a driver calling this one gets 403 from the server.
 */
export function getMapStations(
  params: MapStationsParams = {},
): Promise<MapStationsPayload<MapStation>> {
  return apiRequest<MapStationsPayload<MapStation>>(`/stations/map${mapQuery(params)}`, {
    cache: 'no-store',
  });
}

/**
 * Driver discovery — active stations of active companies, across every company.
 *
 * No `status` and no `companyId` parameter exist here, matching the backend: the endpoint
 * serves active stations only, and never reveals which company owns one.
 */
export interface NearParams {
  lat: number;
  lng: number;
  radiusKm?: number;
}

/**
 * Driver discovery. With `near`, the server returns only stations within the radius, nearest
 * first, each with `distanceKm`.
 */
export function getPublicStations(
  params: Pick<MapStationsParams, 'search' | 'city' | 'limit'> & Partial<NearParams> = {},
): Promise<MapStationsPayload<PublicMapStation>> {
  return apiRequest<MapStationsPayload<PublicMapStation>>(`/stations/public${mapQuery(params)}`, {
    cache: 'no-store',
  });
}

/**
 * The cities that actually have stations — the options for the City dropdown.
 *
 * A dropdown rather than a text box because the filter matches EXACTLY: typing "Delhi" for a
 * station stored as "New Delhi" returned nothing and looked broken. Picking the stored value
 * cannot miss. Drivers and staff get different lists, matching the two station reads.
 */
export async function listStationCities(audience: 'staff' | 'driver'): Promise<string[]> {
  const { cities } = await apiRequest<{ cities: string[] }>(
    audience === 'driver' ? '/stations/public/cities' : '/stations/cities',
    { cache: 'no-store' },
  );
  return cities;
}
