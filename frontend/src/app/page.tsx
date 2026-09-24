'use client';

/**
 * Module 0 — System Status page.
 *
 * This page's only job is to prove the vertical slice is real: the browser makes a
 * genuine network call to the Express backend, and renders whatever the backend
 * actually reports about itself and its MongoDB connection. Nothing on this screen
 * is hardcoded.
 *
 * It stays in the project after Module 0 as a developer diagnostic — the first
 * place to look when something in a later module "isn't connecting".
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import { StatusBadge, type Tone } from '@/components/StatusBadge';
import { ApiClientError } from '@/services/apiClient';
import { fetchHealth } from '@/services/health.service';
import { config } from '@/lib/config';
import type { DatabaseState, HealthPayload } from '@/types/api';
import { buttonClasses } from '@/components/ui/Button';

/** Map a database state to a badge colour and a plain-English explanation. */
const DATABASE_HINTS: Record<DatabaseState, { tone: Tone; hint: string }> = {
  connected: { tone: 'good', hint: 'Mongoose is connected and ready for queries.' },
  connecting: { tone: 'warn', hint: 'A connection attempt is in progress.' },
  disconnected: { tone: 'bad', hint: 'MongoDB is configured but unreachable. Is the server running?' },
  disconnecting: { tone: 'warn', hint: 'The connection is closing.' },
  not_configured: {
    tone: 'warn',
    hint: 'MONGODB_URI is empty in backend/.env. Add your connection string and restart the backend.',
  },
  unknown: { tone: 'neutral', hint: 'The connection state could not be determined.' },
};

type CheckResult =
  | { kind: 'ok'; health: HealthPayload }
  | { kind: 'error'; error: ApiClientError };

/**
 * Perform the health request and normalise both outcomes into one value.
 *
 * Deliberately free of React state so it can be called from an effect and from a
 * click handler without either path owning the error handling.
 */
async function runHealthCheck(): Promise<CheckResult> {
  try {
    return { kind: 'ok', health: await fetchHealth() };
  } catch (caught) {
    return {
      kind: 'error',
      error:
        caught instanceof ApiClientError
          ? caught
          : new ApiClientError('Unexpected client error', 0, 'CLIENT_ERROR', String(caught)),
    };
  }
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export default function SystemStatusPage() {
  const [result, setResult] = useState<CheckResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  const applyResult = useCallback((next: CheckResult) => {
    setResult(next);
    setCheckedAt(new Date().toLocaleTimeString());
    setIsLoading(false);
  }, []);

  // Check once on mount. The `cancelled` flag prevents a state update if the user
  // navigates away (or React's dev-mode double-mount re-runs this) before the
  // request settles.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const next = await runHealthCheck();
      if (!cancelled) applyResult(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [applyResult]);

  const recheck = async () => {
    setIsLoading(true);
    applyResult(await runHealthCheck());
  };

  const health = result?.kind === 'ok' ? result.health : null;
  const error = result?.kind === 'error' ? result.error : null;
  const database = health ? DATABASE_HINTS[health.database.state] : null;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-6 py-16">
      <header>
        <p className="text-xs font-medium uppercase tracking-widest text-neutral-500">
          EV-CMS
        </p>
        <h1 className="mt-1 text-2xl font-semibold">System Status</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          Live health check against{' '}
          <code className="rounded bg-neutral-500/10 px-1.5 py-0.5 font-mono text-xs">
            {config.apiBaseUrl}/health
          </code>
        </p>
      </header>

      <section className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
        {!result ? (
          <p className="text-sm text-neutral-500">Checking backend&hellip;</p>
        ) : error ? (
          <div className="space-y-3">
            <StatusBadge tone="bad" label="Backend unreachable" />
            <p className="text-sm font-medium">{error.message}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-neutral-600 dark:text-neutral-400">
              <dt>Error code</dt>
              <dd className="font-mono">{error.errorCode}</dd>
              <dt>HTTP status</dt>
              <dd className="font-mono">{error.status === 0 ? 'no response' : error.status}</dd>
            </dl>
            <p className="text-xs text-neutral-500">
              Start the API with <code className="font-mono">npm run dev</code> inside{' '}
              <code className="font-mono">backend/</code>, then check again.
            </p>
          </div>
        ) : health ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge
                tone={health.status === 'ok' ? 'good' : 'warn'}
                label={health.status === 'ok' ? 'API healthy' : 'API degraded'}
              />
              {database ? (
                <StatusBadge tone={database.tone} label={`Database: ${health.database.state}`} />
              ) : null}
            </div>

            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-neutral-500">Service</dt>
              <dd className="font-mono text-xs">{health.service}</dd>

              <dt className="text-neutral-500">Environment</dt>
              <dd className="font-mono text-xs">{health.environment}</dd>

              <dt className="text-neutral-500">Uptime</dt>
              <dd className="font-mono text-xs">{formatUptime(health.uptimeSeconds)}</dd>

              <dt className="text-neutral-500">Server time</dt>
              <dd className="font-mono text-xs">{new Date(health.timestamp).toLocaleString()}</dd>

              {health.database.name ? (
                <>
                  <dt className="text-neutral-500">Database</dt>
                  <dd className="font-mono text-xs">
                    {health.database.name}
                    {health.database.host ? ` @ ${health.database.host}` : ''}
                  </dd>
                </>
              ) : null}
            </dl>

            {database && health.status !== 'ok' ? (
              <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                {database.hint}
                {health.database.lastError ? (
                  <>
                    <br />
                    <span className="font-mono">{health.database.lastError}</span>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => void recheck()}
          disabled={isLoading}
          className={buttonClasses('primary', 'md')}
        >
          {isLoading ? 'Checking…' : 'Check again'}
        </button>
        {checkedAt ? (
          <span className="text-xs text-neutral-500">Last checked at {checkedAt}</span>
        ) : null}
      </div>

      <nav className="flex gap-4 text-sm">
        <Link href="/login" className="underline underline-offset-4">
          Sign in
        </Link>
        <Link href="/register" className="underline underline-offset-4">
          Create account
        </Link>
        <Link href="/dashboard" className="underline underline-offset-4">
          Dashboard
        </Link>
      </nav>
    </main>
  );
}
