'use client';

/**
 * Complaints — one page, two audiences.
 *
 * A driver sees their own tickets; staff see their company's queue. Same endpoint either way:
 * the server picks owner scope or company scope from the role, so this component filters nothing
 * for security. Same shape as the sessions and payments lists.
 */

import { useCallback, useState } from 'react';
import Link from 'next/link';

import { RequireAuth } from '@/components/RequireAuth';
import { ComplaintRow, CATEGORY_LABELS } from '@/components/ComplaintSummary';
import { useAuth } from '@/context/AuthContext';
import { useAsyncData } from '@/hooks/useAsyncData';
import { toMessage } from '@/lib/formatApiError';
import { listComplaints } from '@/services/complaint.service';
import type { ComplaintCategory, ComplaintPriority, ComplaintStatus } from '@/types/api';

const STATUSES: ComplaintStatus[] = ['open', 'in_progress', 'resolved', 'closed'];
const CATEGORIES = Object.keys(CATEGORY_LABELS) as ComplaintCategory[];
const PRIORITIES: ComplaintPriority[] = ['low', 'medium', 'high'];

function ComplaintsContent() {
  const { user } = useAuth();
  const isDriver = user?.role === 'driver';

  const [status, setStatus] = useState<ComplaintStatus | ''>('');
  const [category, setCategory] = useState<ComplaintCategory | ''>('');
  const [priority, setPriority] = useState<ComplaintPriority | ''>('');

  const load = useCallback(
    () =>
      listComplaints({
        limit: 50,
        ...(status ? { status } : {}),
        ...(category ? { category } : {}),
        ...(priority ? { priority } : {}),
      }),
    [status, category, priority],
  );

  const { state } = useAsyncData(load);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{isDriver ? 'My complaints' : 'Support queue'}</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {isDriver
              ? 'Problems you have reported, and what was done about them.'
              : 'Problems reported at your stations.'}
          </p>
        </div>
        {isDriver && (
          <Link
            href="/complaints/new"
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700"
          >
            Report a problem
          </Link>
        )}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as ComplaintStatus | '')}
          className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
        >
          <option value="">All statuses</option>
          {STATUSES.map((option) => (
            <option key={option} value={option}>
              {option.replace('_', ' ')}
            </option>
          ))}
        </select>

        <select
          value={category}
          onChange={(event) => setCategory(event.target.value as ComplaintCategory | '')}
          className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
        >
          <option value="">All categories</option>
          {CATEGORIES.map((option) => (
            <option key={option} value={option}>
              {CATEGORY_LABELS[option]}
            </option>
          ))}
        </select>

        {!isDriver && (
          <select
            value={priority}
            onChange={(event) => setPriority(event.target.value as ComplaintPriority | '')}
            className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
          >
            <option value="">Any priority</option>
            {PRIORITIES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        )}
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
            {isDriver ? 'You have not reported any problems.' : 'Nothing in the queue.'}
          </p>
        )}

        {state.status === 'ok' &&
          state.data.items.map((complaint) => (
            <ComplaintRow key={complaint.id} complaint={complaint} showPriority={!isDriver} />
          ))}
      </div>
    </main>
  );
}

export default function ComplaintsPage() {
  return (
    <RequireAuth>
      <ComplaintsContent />
    </RequireAuth>
  );
}
