/**
 * The single HTTP client for talking to the EV-CMS backend.
 *
 * Contract rule (locked in Module 0): **the response envelope is the source of
 * truth, not the HTTP status code.** If the body parses as our envelope, we trust
 * its `success` flag; only when the body is not our envelope do we fall back to
 * the status code.
 *
 * That rule exists because of `/health`: it deliberately answers 503 while the
 * database is down, but the request itself succeeded and the payload is
 * meaningful. A naive `if (!res.ok) throw` client would discard exactly the
 * diagnostic information we asked for.
 *
 * Every later module (auth, stations, chargers, sessions, wallet) calls through
 * here, so error handling is written once rather than per feature.
 */

import { config } from '@/lib/config';
import { getToken } from '@/lib/authStorage';
import type { ApiEnvelope } from '@/types/api';

/** Thrown for any failed request: network, non-JSON, or `success: false`. */
export class ApiClientError extends Error {
  /** HTTP status, or 0 when the request never reached the server. */
  readonly status: number;
  /** Machine-readable code from the backend, or a client-side code. */
  readonly errorCode: string;
  readonly details: unknown;

  constructor(message: string, status: number, errorCode: string, details: unknown = null) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.errorCode = errorCode;
    this.details = details;
  }
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  /** Plain object; serialised to JSON automatically. */
  body?: unknown;
  /** Set false for public endpoints that should never send credentials. */
  auth?: boolean;
}

/**
 * Perform a request and unwrap the envelope.
 *
 * @param path Path relative to the API base, e.g. `/health`.
 * @returns The `data` field of a successful response.
 * @throws {ApiClientError} on network failure, malformed response, or `success: false`.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, headers, auth = true, ...rest } = options;
  const url = `${config.apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;

  // Attach the access token when we have one. Read per-request rather than cached,
  // so a login or logout elsewhere in the app takes effect immediately.
  const token = auth ? getToken() : null;

  let response: Response;
  try {
    response = await fetch(url, {
      ...rest,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    // The server is unreachable: not started, wrong port, or blocked by CORS.
    throw new ApiClientError(
      `Could not reach the backend at ${url}. Is it running?`,
      0,
      'NETWORK_ERROR',
      error instanceof Error ? error.message : String(error),
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ApiClientError(
      `Backend returned a non-JSON response (HTTP ${response.status}).`,
      response.status,
      'INVALID_RESPONSE',
    );
  }

  // Does the body look like our envelope?
  const envelope = parsed as ApiEnvelope<T>;
  const isEnvelope =
    typeof parsed === 'object' && parsed !== null && typeof envelope.success === 'boolean';

  if (!isEnvelope) {
    throw new ApiClientError(
      `Unexpected response shape from ${url} (HTTP ${response.status}).`,
      response.status,
      'INVALID_RESPONSE',
      parsed,
    );
  }

  if (!envelope.success) {
    throw new ApiClientError(
      envelope.message,
      response.status,
      envelope.errorCode,
      envelope.details,
    );
  }

  return envelope.data;
}
