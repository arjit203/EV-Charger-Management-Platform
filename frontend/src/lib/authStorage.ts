/**
 * Where the access token lives on the client.
 *
 * localStorage, paired with the `Authorization: Bearer` transport chosen in Module 1.
 * Every access is wrapped in try/catch because storage throws outright in some
 * contexts (private mode, browsers configured to block site data), and a status page
 * that crashes on a storage read is worse than one that treats it as logged out.
 *
 * Isolating it here means switching to httpOnly cookies later touches this file, the
 * API client, and nothing else.
 */

const TOKEN_KEY = 'evcms.accessToken';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null; // server render
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable — the session simply won't survive a reload */
  }
}

export function clearToken(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to do */
  }
}
