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
import { formatDateTime, formatTime } from '@/lib/datetime';

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
    setCheckedAt(formatTime(new Date()));
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

  const apiTone: Tone = error ? 'bad' : health ? (health.status === 'ok' ? 'good' : 'warn') : 'neutral';
  const apiLabel = error ? 'Unreachable' : health ? (health.status === 'ok' ? 'Healthy' : 'Degraded') : 'Checking…';

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-6 px-4 py-16 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--accent)] text-sm font-bold text-[var(--accent-contrast)]">
            EV
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">System Status</h1>
            <p className="mt-0.5 text-sm text-neutral-400">
              Live health check against{' '}
              <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-xs text-neutral-300">
                {config.apiBaseUrl}/health
              </code>
            </p>
          </div>
        </div>
      </header>

      {/* The two answers people open this page for, at a size they can read from across a room. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <StatusTile label="API" value={apiLabel} tone={apiTone} />
        <StatusTile
          label="Database"
          value={health ? health.database.state.replace(/_/g, ' ') : error ? 'Unknown' : 'Checking…'}
          tone={database?.tone ?? (error ? 'neutral' : 'neutral')}
        />
      </div>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        {!result ? (
          <p className="p-5 text-sm text-neutral-500">Checking backend&hellip;</p>
        ) : error ? (
          <div className="space-y-3 p-5">
            <StatusBadge tone="bad" label="Backend unreachable" />
            <p className="text-sm font-medium">{error.message}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-neutral-400">
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
          <>
            <dl className="divide-y divide-[var(--border)] text-sm">
              <Detail label="Service" value={health.service} />
              <Detail label="Environment" value={health.environment} />
              <Detail label="Uptime" value={formatUptime(health.uptimeSeconds)} />
              <Detail label="Server time" value={formatDateTime(health.timestamp)} />
              {health.database.name ? (
                <Detail
                  label="Database"
                  value={`${health.database.name}${health.database.host ? ` @ ${health.database.host}` : ''}`}
                />
              ) : null}
            </dl>

            {database && health.status !== 'ok' ? (
              <p className="m-5 mt-0 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                {database.hint}
                {health.database.lastError ? (
                  <>
                    <br />
                    <span className="font-mono">{health.database.lastError}</span>
                  </>
                ) : null}
              </p>
            ) : null}
          </>
        ) : null}
      </section>

      <div className="flex flex-wrap items-center justify-between gap-4">
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
          <Link href="/login" className="text-neutral-400 transition-colors hover:text-neutral-100">
            Sign in
          </Link>
          <Link href="/register" className="text-neutral-400 transition-colors hover:text-neutral-100">
            Create account
          </Link>
          <Link href="/dashboard" className="text-neutral-400 transition-colors hover:text-neutral-100">
            Dashboard
          </Link>
        </nav>
      </div>
    </main>
  );
}

const TILE_DOT: Record<Tone, string> = {
  good: 'bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.15)]',
  info: 'bg-blue-500 shadow-[0_0_0_4px_rgba(59,130,246,0.15)]',
  warn: 'bg-amber-500 shadow-[0_0_0_4px_rgba(245,158,11,0.15)]',
  bad: 'bg-red-500 shadow-[0_0_0_4px_rgba(239,68,68,0.15)]',
  neutral: 'bg-neutral-500 shadow-[0_0_0_4px_rgba(115,115,115,0.15)]',
};

function StatusTile({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <div>
        <p className="section-label">{label}</p>
        <p className="mt-1.5 text-xl font-semibold capitalize tracking-tight">{value}</p>
      </div>
      <span className={`h-3 w-3 rounded-full ${TILE_DOT[tone]}`} aria-hidden />
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-4 px-5 py-3">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="break-all font-mono text-xs leading-5 text-neutral-200">{value}</dd>
    </div>
  );
}
