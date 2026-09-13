import { ApiClientError } from '@/services/apiClient';

export interface FieldError {
  field: string;
  message: string;
}

/**
 * Pull per-field messages out of a 422 response.
 *
 * The backend's validation middleware sends `details` as `[{ field, message }]`, so a
 * form can point at the offending input instead of showing one generic sentence. Any
 * other error shape returns an empty list and the caller falls back to `error.message`.
 */
export function extractFieldErrors(error: unknown): FieldError[] {
  if (!(error instanceof ApiClientError) || !Array.isArray(error.details)) return [];

  return error.details.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const candidate = entry as { field?: unknown; message?: unknown };
    if (typeof candidate.field !== 'string' || typeof candidate.message !== 'string') return [];
    return [{ field: candidate.field, message: candidate.message }];
  });
}

/** A single sentence suitable for showing above a form. */
export function toMessage(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}
