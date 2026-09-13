import { apiRequest } from './apiClient';
import type { Paginated, Role, User, UserPayload, UserStatus } from '@/types/api';

export interface ListUsersParams {
  page?: number;
  limit?: number;
  role?: Role;
  status?: UserStatus;
  /** super_admin only — the backend refuses a cpo_admin naming another company. */
  companyId?: string;
  search?: string;
}

/**
 * super_admin sees everyone; cpo_admin sees only their own company's STAFF.
 *
 * Drivers never appear in a cpo_admin's results — they have no `companyId`, so a company
 * filter structurally cannot match one. That is by design, not a missing feature.
 */
export function listUsers(params: ListUsersParams = {}): Promise<Paginated<User>> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const suffix = query.toString() ? `?${query}` : '';
  return apiRequest<Paginated<User>>(`/users${suffix}`, { cache: 'no-store' });
}

export async function getUser(userId: string): Promise<User> {
  const { user } = await apiRequest<UserPayload>(`/users/${userId}`, { cache: 'no-store' });
  return user;
}

export interface CreateStaffInput {
  name: string;
  email: string;
  password: string;
  role: 'cpo_admin' | 'operator';
  /** Required for super_admin; ignored for cpo_admin, who can only create in their own company. */
  companyId?: string;
  phone?: string;
}

/**
 * Create a staff account.
 *
 * Supersedes Module 2's `POST /companies/:companyId/users`, which has been removed.
 * Cannot create a driver — drivers self-register at /register.
 */
export async function createStaffUser(input: CreateStaffInput): Promise<User> {
  const { user } = await apiRequest<UserPayload>('/users', { method: 'POST', body: input });
  return user;
}

export async function updateUser(
  userId: string,
  input: { name?: string; phone?: string },
): Promise<User> {
  const { user } = await apiRequest<UserPayload>(`/users/${userId}`, {
    method: 'PATCH',
    body: input,
  });
  return user;
}

export async function setUserStatus(userId: string, status: UserStatus): Promise<User> {
  const { user } = await apiRequest<UserPayload>(`/users/${userId}/status`, {
    method: 'PATCH',
    body: { status },
  });
  return user;
}

/**
 * Update your own profile.
 *
 * There is no matching read: `/auth/me` (via `AuthContext`) already provides it. Sending
 * `role`, `companyId`, `status` or `email` here is rejected with 422 by the backend.
 */
export async function updateMyProfile(input: { name?: string; phone?: string }): Promise<User> {
  const { user } = await apiRequest<UserPayload>('/users/me', { method: 'PATCH', body: input });
  return user;
}
