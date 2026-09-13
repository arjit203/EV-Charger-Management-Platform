/**
 * Shared API types.
 *
 * These mirror the backend contract defined in Module 0
 * (backend/src/utils/ApiResponse.ts and backend/src/middlewares/error.middleware.ts).
 * If one side changes, the other must change with it — that is a deliberate
 * structural change, not a casual edit.
 */

/** Every successful response from the backend. */
export interface ApiSuccessBody<T> {
  success: true;
  message: string;
  data: T;
}

/** Every error response from the backend. */
export interface ApiErrorBody {
  success: false;
  message: string;
  errorCode: string;
  details: unknown;
  /** Development only. */
  stack?: string;
}

export type ApiEnvelope<T> = ApiSuccessBody<T> | ApiErrorBody;

/* -------------------------------------------------------------------------- */
/* Module 0 — health                                                          */
/* -------------------------------------------------------------------------- */

export type DatabaseState =
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'disconnecting'
  | 'not_configured'
  | 'unknown';

export interface DatabaseStatus {
  state: DatabaseState;
  name: string | null;
  host: string | null;
  lastError: string | null;
}

export interface HealthPayload {
  status: 'ok' | 'degraded';
  service: string;
  environment: string;
  uptimeSeconds: number;
  timestamp: string;
  database: DatabaseStatus;
}
