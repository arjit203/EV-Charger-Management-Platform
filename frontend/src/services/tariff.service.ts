/**
 * Tariff API calls.
 *
 * THE MONEY BOUNDARY: a form collects rupees because that is what a human types, and the API
 * accepts `pricePerKwh` in rupees and converts to integer paise server-side. Everything coming
 * BACK is paise. There is no path where a rupee float is stored or calculated with.
 */

import { apiRequest } from './apiClient';
import type { Paginated, Tariff, TariffPayload, TariffStatus } from '@/types/api';

export interface TariffInput {
  name: string;
  /** In RUPEES. The backend converts to paise and rounds. */
  pricePerKwh: number;
  /** super_admin only — they have no company of their own. A scoped caller sending it gets 422. */
  companyId?: string;
}

export interface ListTariffsParams {
  page?: number;
  limit?: number;
  status?: TariffStatus;
  companyId?: string;
}

export function listTariffs(params: ListTariffsParams = {}): Promise<Paginated<Tariff>> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const suffix = query.toString() ? `?${query}` : '';
  return apiRequest<Paginated<Tariff>>(`/tariffs${suffix}`, { cache: 'no-store' });
}

export async function getTariff(tariffId: string): Promise<Tariff> {
  const { tariff } = await apiRequest<TariffPayload>(`/tariffs/${tariffId}`, { cache: 'no-store' });
  return tariff;
}

/** Created INACTIVE. Activating is a separate call, because it swaps out the company's rate. */
export async function createTariff(input: TariffInput): Promise<Tariff> {
  const { tariff } = await apiRequest<TariffPayload>('/tariffs', { method: 'POST', body: input });
  return tariff;
}

export async function updateTariff(
  tariffId: string,
  input: Partial<Omit<TariffInput, 'companyId'>>,
): Promise<Tariff> {
  const { tariff } = await apiRequest<TariffPayload>(`/tariffs/${tariffId}`, {
    method: 'PATCH',
    body: input,
  });
  return tariff;
}

/**
 * Activate or deactivate.
 *
 * Activating deactivates whichever tariff is currently in force — the server does the swap in a
 * transaction, so the company is never left with two rates or none.
 */
export async function setTariffStatus(tariffId: string, status: TariffStatus): Promise<Tariff> {
  const { tariff } = await apiRequest<TariffPayload>(`/tariffs/${tariffId}/status`, {
    method: 'PATCH',
    body: { status },
  });
  return tariff;
}
