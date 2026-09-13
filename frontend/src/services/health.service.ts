import { apiRequest } from './apiClient';
import type { HealthPayload } from '@/types/api';

/**
 * Fetch backend health.
 *
 * `cache: 'no-store'` matters here — without it Next.js/the browser could serve a
 * stale "connected" result and hide the fact that the database just went away.
 */
export function fetchHealth(): Promise<HealthPayload> {
  return apiRequest<HealthPayload>('/health', { cache: 'no-store' });
}
