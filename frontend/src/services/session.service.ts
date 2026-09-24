/**
 * Charging session API calls.
 *
 * Note what is NOT here: no `remoteStart`, no `remoteStop`, no charger command of any kind.
 * Module 6 had those; Module 7 retired them so that a charger can only be told to deliver
 * power as part of a session that is already recorded. The frontend follows the same rule —
 * there is simply no function to call.
 */

import { apiRequest } from './apiClient';
import type {
  ActiveSessionPayload,
  ChargingSession,
  ConnectorChargingPayload,
  StationConnectorsPayload,
  ChargerType,
  ConnectorChargingView,
  ConnectorType,
  MeterReading,
  Paginated,
  ReadingsPayload,
  SessionPayload,
  SessionStatus,
} from '@/types/api';

export interface ListSessionsParams {
  page?: number;
  limit?: number;
  status?: SessionStatus;
  active?: boolean;
  stationId?: string;
  chargerId?: string;
  companyId?: string;
  chargerType?: ChargerType;
  connectorType?: ConnectorType;
}

/**
 * Scoped entirely server-side, and differently per role: a driver gets their own sessions,
 * staff get their company's. The frontend sends the same request either way and filters
 * nothing itself.
 */
export function listSessions(params: ListSessionsParams = {}): Promise<Paginated<ChargingSession>> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const suffix = query.toString() ? `?${query}` : '';
  return apiRequest<Paginated<ChargingSession>>(`/charging/sessions${suffix}`, { cache: 'no-store' });
}

export async function getSession(sessionId: string): Promise<ChargingSession> {
  const { session } = await apiRequest<SessionPayload>(`/charging/sessions/${sessionId}`, {
    cache: 'no-store',
  });
  return session;
}

/** The driver's own in-progress session, or null. Drivers only. */
export async function getActiveSession(): Promise<ChargingSession | null> {
  const { session } = await apiRequest<ActiveSessionPayload>('/charging/sessions/active', {
    cache: 'no-store',
  });
  return session;
}

export async function getSessionReadings(sessionId: string): Promise<MeterReading[]> {
  const { readings } = await apiRequest<ReadingsPayload>(
    `/charging/sessions/${sessionId}/readings`,
    { cache: 'no-store' },
  );
  return readings;
}

/** What the QR code on a plug resolves to — one connector, with a usable/not-usable verdict. */
export async function getConnectorForCharging(
  connectorId: string,
): Promise<ConnectorChargingView> {
  const { connector } = await apiRequest<ConnectorChargingPayload>(
    `/charging/connectors/${connectorId}`,
    { cache: 'no-store' },
  );
  return connector;
}

/** Every plug at one station, so a driver can pick one instead of being handed an id. */
export async function listStationConnectors(
  stationId: string,
): Promise<ConnectorChargingView[]> {
  const { connectors } = await apiRequest<StationConnectorsPayload>(
    `/charging/stations/${stationId}/connectors`,
    { cache: 'no-store' },
  );
  return connectors;
}

/**
 * Start charging. Driver only.
 *
 * Resolves with a session in `initiating`, NOT `active` — the API answers 202, meaning the
 * charger has been asked. The screen then polls until the charger confirms. `userId` is never
 * sent: the server takes it from the token.
 */
export async function startSession(input: {
  connectorId: string;
  vehicleId?: string;
}): Promise<ChargingSession> {
  const { session } = await apiRequest<SessionPayload>('/charging/sessions', {
    method: 'POST',
    body: input,
  });
  return session;
}

/**
 * Stop charging.
 *
 * One call, two meanings, decided by the server from the caller's role: a driver stops their
 * own session, an operator or CPO admin force-stops one at their own station.
 */
export async function stopSession(sessionId: string): Promise<ChargingSession> {
  const { session } = await apiRequest<SessionPayload>(`/charging/sessions/${sessionId}/stop`, {
    method: 'POST',
  });
  return session;
}
