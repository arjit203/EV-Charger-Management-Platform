import { apiRequest } from './apiClient';
import type {
  Charger,
  ChargerPayload,
  ChargerStatus,
  ChargerType,
  Connector,
  ConnectorPayload,
  ConnectorStatus,
  ConnectorType,
  Paginated,
} from '@/types/api';

export interface ChargerInput {
  stationId: string;
  name: string;
  chargerCode: string;
  ocppId: string;
  manufacturer: string;
  model: string;
  chargerType: ChargerType;
  powerKw: number;
  firmwareVersion?: string;
}

export interface ListChargersParams {
  page?: number;
  limit?: number;
  stationId?: string;
  status?: ChargerStatus;
  chargerType?: ChargerType;
  manufacturer?: string;
  companyId?: string;
  search?: string;
}

/** Scoped server-side: admins see their own company's chargers, super_admin sees all. */
export function listChargers(params: ListChargersParams = {}): Promise<Paginated<Charger>> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const suffix = query.toString() ? `?${query}` : '';
  return apiRequest<Paginated<Charger>>(`/chargers${suffix}`, { cache: 'no-store' });
}

export async function getCharger(chargerId: string): Promise<Charger> {
  const { charger } = await apiRequest<ChargerPayload>(`/chargers/${chargerId}`, { cache: 'no-store' });
  return charger;
}

/**
 * The station is verified against the caller's company scope on the server, and the
 * charger's company is copied from it — never from anything sent here.
 */
export async function createCharger(input: ChargerInput): Promise<Charger> {
  const { charger } = await apiRequest<ChargerPayload>('/chargers', { method: 'POST', body: input });
  return charger;
}

/** Cannot change station, company or status — the backend rejects all three. */
export async function updateCharger(
  chargerId: string,
  input: Partial<Omit<ChargerInput, 'stationId'>>,
): Promise<Charger> {
  const { charger } = await apiRequest<ChargerPayload>(`/chargers/${chargerId}`, {
    method: 'PATCH',
    body: input,
  });
  return charger;
}

/** Deliberately does not affect connector statuses — they are independent. */
export async function setChargerStatus(chargerId: string, status: ChargerStatus): Promise<Charger> {
  const { charger } = await apiRequest<ChargerPayload>(`/chargers/${chargerId}/status`, {
    method: 'PATCH',
    body: { status },
  });
  return charger;
}

/* ------------------------------- connectors ------------------------------- */

export interface ConnectorInput {
  connectorNumber: number;
  connectorType: ConnectorType;
  powerKw: number;
}

/**
 * Connectors are always addressed through their charger. That nesting is what makes the
 * server verify the Company → Station → Charger chain on every connector call.
 */
export async function listConnectors(chargerId: string): Promise<Connector[]> {
  const { connectors } = await apiRequest<{ connectors: Connector[] }>(
    `/chargers/${chargerId}/connectors`,
    { cache: 'no-store' },
  );
  return connectors;
}

export async function createConnector(
  chargerId: string,
  input: ConnectorInput,
): Promise<Connector> {
  const { connector } = await apiRequest<ConnectorPayload>(`/chargers/${chargerId}/connectors`, {
    method: 'POST',
    body: input,
  });
  return connector;
}

export async function updateConnector(
  chargerId: string,
  connectorId: string,
  input: Partial<ConnectorInput> & { errorCode?: string | null },
): Promise<Connector> {
  const { connector } = await apiRequest<ConnectorPayload>(
    `/chargers/${chargerId}/connectors/${connectorId}`,
    { method: 'PATCH', body: input },
  );
  return connector;
}

export async function setConnectorStatus(
  chargerId: string,
  connectorId: string,
  status: ConnectorStatus,
): Promise<Connector> {
  const { connector } = await apiRequest<ConnectorPayload>(
    `/chargers/${chargerId}/connectors/${connectorId}/status`,
    { method: 'PATCH', body: { status } },
  );
  return connector;
}
