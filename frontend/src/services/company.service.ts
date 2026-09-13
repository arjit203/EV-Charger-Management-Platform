import { apiRequest } from './apiClient';
import type {
  Company,
  CompanyPayload,
  CompanyStatus,
  CompanyType,
  Paginated,
} from '@/types/api';

export interface CompanyInput {
  name: string;
  legalName?: string;
  type?: CompanyType;
  contactEmail?: string;
  contactPhone?: string;
  address?: Partial<{
    line1: string;
    city: string;
    state: string;
    country: string;
    postalCode: string;
  }>;
}

export interface ListCompaniesParams {
  page?: number;
  limit?: number;
  status?: CompanyStatus;
  type?: CompanyType;
  search?: string;
}

/** super_admin only — the backend answers 403 for every other role. */
export function listCompanies(params: ListCompaniesParams = {}): Promise<Paginated<Company>> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const suffix = query.toString() ? `?${query}` : '';
  return apiRequest<Paginated<Company>>(`/companies${suffix}`, { cache: 'no-store' });
}

/**
 * The caller's own company (cpo_admin / operator).
 *
 * Note there is no id in this URL — the backend derives the company from the authenticated
 * request, so there is nothing here a caller could tamper with.
 */
export async function getMyCompany(): Promise<Company> {
  const { company } = await apiRequest<CompanyPayload>('/companies/me', { cache: 'no-store' });
  return company;
}

export async function getCompany(companyId: string): Promise<Company> {
  const { company } = await apiRequest<CompanyPayload>(`/companies/${companyId}`, {
    cache: 'no-store',
  });
  return company;
}

export async function createCompany(input: CompanyInput): Promise<Company> {
  const { company } = await apiRequest<CompanyPayload>('/companies', {
    method: 'POST',
    body: input,
  });
  return company;
}

export async function updateCompany(
  companyId: string,
  input: Partial<CompanyInput>,
): Promise<Company> {
  const { company } = await apiRequest<CompanyPayload>(`/companies/${companyId}`, {
    method: 'PATCH',
    body: input,
  });
  return company;
}

/** Status has its own endpoint so suspension is never a side effect of an edit. */
export async function setCompanyStatus(
  companyId: string,
  status: CompanyStatus,
): Promise<Company> {
  const { company } = await apiRequest<CompanyPayload>(`/companies/${companyId}/status`, {
    method: 'PATCH',
    body: { status },
  });
  return company;
}

/*
 * REMOVED IN MODULE 3: `createCompanyUser`.
 *
 * Staff creation moved to `createStaffUser` in user.service.ts, backed by POST /users.
 * The old backend route was retired rather than left running in parallel.
 */
