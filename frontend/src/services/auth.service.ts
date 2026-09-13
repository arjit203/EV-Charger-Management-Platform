import { apiRequest } from './apiClient';
import type { AuthResult, MePayload } from '@/types/api';

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
  phone?: string;
}

/**
 * Log in. `auth: false` because sending a stale token with a login request is
 * pointless and would be rejected by the middleware before login is even attempted.
 */
export function loginRequest(email: string, password: string): Promise<AuthResult> {
  return apiRequest<AuthResult>('/auth/login', {
    method: 'POST',
    body: { email, password },
    auth: false,
  });
}

/**
 * Public self-registration. Always produces a `driver` — the backend hardcodes the
 * role and rejects any request that even mentions one, so there is deliberately no
 * role parameter here.
 */
export function registerRequest(input: RegisterInput): Promise<AuthResult> {
  return apiRequest<AuthResult>('/auth/register', {
    method: 'POST',
    body: input,
    auth: false,
  });
}

/** Resolve the token in storage into the current user. */
export function fetchMe(): Promise<MePayload> {
  return apiRequest<MePayload>('/auth/me', { cache: 'no-store' });
}
