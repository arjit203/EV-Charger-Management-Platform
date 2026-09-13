/**
 * Frontend runtime configuration.
 *
 * The only place the app reads `process.env`. Next.js inlines NEXT_PUBLIC_*
 * variables at build time, so a typo elsewhere would silently become `undefined`
 * and produce a request to "undefined/health". Centralising it here means a
 * missing value fails loudly and in one spot.
 */

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;

if (!apiBaseUrl) {
  throw new Error(
    'NEXT_PUBLIC_API_BASE_URL is not set. Copy frontend/.env.example to frontend/.env.local.',
  );
}

const apiRoot = apiBaseUrl.replace(/\/+$/, '');

export const config = {
  /** Backend API root, including the version prefix. No trailing slash. */
  apiBaseUrl: apiRoot,

  /**
   * Socket.IO origin (Module 8).
   *
   * Derived from the API URL rather than configured separately, because both are served by the
   * SAME http.Server — the API lives under `/api/v1` and Socket.IO under `/socket.io`, so
   * stripping the path prefix gives the origin. A second env var could drift out of step with
   * the first and produce a socket pointing somewhere the REST calls do not.
   */
  socketUrl: apiRoot.replace(/\/api\/v\d+$/, ''),
} as const;
