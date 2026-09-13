'use client';

/**
 * Charging sessions.
 *
 * ONE PAGE, TWO AUDIENCES — because it is one endpoint with two scopes. A driver sees their
 * own charges wherever they happened; staff see every charge at their own company's stations.
 * The frontend sends the identical request and filters nothing: the server picks owner scoping
 * or company scoping from the caller's role.
 *
 * That is worth stating plainly, because the alternative — fetching everything and hiding rows
 * in the browser — is the classic way this kind of screen leaks other people's data.
 */

import { useCallback, useState } from 'react';
import Link from 'next/link';

import { RequireAuth } from '@/components/RequireAuth';
import { SessionRow } from '@/components/SessionSummary';
import { useAuth } from '@/context/AuthContext';
import { useAsyncData } from '@/hooks/useAsyncData';
import { toMessage } from '@/lib/formatApiError';
import { listSessions } from '@/services/session.service';
import type { SessionStatus } from '@/types/api';

const STATUS_OPTIONS: SessionStatus[] = [
  'initiating',
  'active',
  'stopping',
  'completed',
  'failed',
];

function SessionListContent() {
  const { user } = useAuth();
  const isDriver = user?.role === 'driver';

  const [status, setStatus] = useState<SessionStatus | ''>('');
  const [activeOnly, setActiveOnly] = useState(false);

  const load = useCallback(
    () =>
      listSessions({
        limit: 25,
        ...(status ? { status } : {}),
        ...(activeOnly ? { active: true } : {}),
      }),
    [status, activeOnly],
  );

  const { state } = useAsyncData(load);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">
            {isDriver ? 'My charging' : 'Charging sessions'}
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            {isDriver
              ? 'Every charge you have started, wherever you started it.'
              : 'Every charge at your stations, including drivers you have no other relationship with.'}
          </p>
        </div>
        {isDriver && (
          <Link
            href="/charge"
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700"
          >
            Start charging
          </Link>
        )}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as SessionStatus | '')}
          className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700"
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(event) => {
              setActiveOnly(event.target.checked);
              if (event.target.checked) setStatus('');
            }}
          />
          In progress only
        </label>
      </div>

      <div className="mt-6 space-y-3">
        {state.status === 'loading' && <p className="text-sm text-neutral-500">Loading…</p>}

        {state.status === 'error' && (
          <p className="rounded-lg bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-400">
            {toMessage(state.error)}
          </p>
        )}

        {state.status === 'ok' && state.data.items.length === 0 && (
          <p className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
            No charging sessions yet.
          </p>
        )}

        {state.status === 'ok' &&
          state.data.items.map((session) => <SessionRow key={session.id} session={session} />)}

        {state.status === 'ok' && state.data.total > state.data.items.length && (
          <p className="pt-2 text-center text-xs text-neutral-500">
            Showing {state.data.items.length} of {state.data.total}
          </p>
        )}
      </div>
    </main>
  );
}

export default function SessionsPage() {
  return (
    <RequireAuth>
      <SessionListContent />
    </RequireAuth>
  );
}
