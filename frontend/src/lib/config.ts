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

export const config = {
  /** Backend API root, including the version prefix. No trailing slash. */
  apiBaseUrl: apiBaseUrl.replace(/\/+$/, ''),
} as const;
