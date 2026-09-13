'use client';

/**
 * Complaint detail — the driver's view of what happened, and the staff console for doing it.
 *
 * The staff controls only offer transitions that are legal from the CURRENT status, and only
 * those this role may make. That mirrors the two independent server-side gates (409 for an
 * illegal transition, 403 for the wrong role) rather than offering buttons that will be refused.
 */

import { useCallback, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

import { RequireAuth } from '@/components/RequireAuth';
import { StatusBadge } from '@/components/StatusBadge';
import {
  CATEGORY_LABELS,
  COMPLAINT_STATUS_LABELS,
  complaintTone,
} from '@/components/ComplaintSummary';
import { useAuth } from '@/context/AuthContext';
import { useAsyncData } from '@/hooks/useAsyncData';
import { formatPaise, formatRate } from '@/lib/money';
import { toMessage } from '@/lib/formatApiError';
import { getComplaint, setComplaintStatus, updateComplaint } from '@/services/complaint.service';
import type { Complaint, ComplaintStatus, DisputedSession } from '@/types/api';

/** Mirrors ALLOWED_TRANSITIONS on the server. Closed is terminal. */
const NEXT_STATUSES: Record<ComplaintStatus, ComplaintStatus[]> = {
  open: ['in_progress'],
  in_progress: ['open', 'resolved'],
  resolved: ['closed'],
  closed: [],
};

/** Concluding a ticket is an administrative act — an operator can work one, not close it. */
const ADMIN_ONLY: ComplaintStatus[] = ['resolved', 'closed'];

function StaffControls({
  complaint,
  onChanged,
}: {
  complaint: Complaint;
  onChanged: (complaint: Complaint) => void;
}) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'super_admin' || user?.role === 'cpo_admin';

  const [resolution, setResolution] = useState(complaint.resolution ?? '');
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const available = NEXT_STATUSES[complaint.status].filter(
    (status) => isAdmin || !ADMIN_ONLY.includes(status),
  );

  async function move(status: ComplaintStatus) {
    setIsBusy(true);
    setError(null);
    try {
      onChanged(await setComplaintStatus(complaint.id, status, resolution.trim() || undefined));
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setIsBusy(false);
    }
  }

  async function saveNote() {
    setIsBusy(true);
    setError(null);
    try {
      onChanged(await updateComplaint(complaint.id, { resolution: resolution.trim() }));
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setIsBusy(false);
    }
  }

  if (complaint.status === 'closed') {
    return (
      <p className="rounded-lg bg-neutral-500/10 p-4 text-sm text-neutral-600 dark:text-neutral-400">
        This complaint is closed. Closed complaints cannot be reopened — if the problem recurs, the
        driver files a new one referencing this.
      </p>
    );
  }

  return (
    <section className="rounded-2xl border border-neutral-200 p-6 dark:border-neutral-800">
      <h2 className="text-sm font-semibold">Handle this complaint</h2>

      <label className="mt-4 block text-sm">
        <span className="text-neutral-600 dark:text-neutral-400">
          {complaint.status === 'in_progress' ? 'Resolution / notes' : 'Notes'}
        </span>
        <textarea
          value={resolution}
          onChange={(event) => setResolution(event.target.value)}
          rows={4}
          placeholder="What did you find, and what did you do?"
          className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700"
        />
      </label>

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void saveNote()}
          disabled={isBusy || resolution.trim().length === 0}
          className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium transition-colors hover:bg-neutral-500/10 disabled:opacity-60 dark:border-neutral-700"
        >
          Save note
        </button>

        {available.map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => void move(status)}
            disabled={isBusy}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-60"
          >
            Mark {COMPLAINT_STATUS_LABELS[status]}
          </button>
        ))}
      </div>

      {!isAdmin && NEXT_STATUSES[complaint.status].some((s) => ADMIN_ONLY.includes(s)) && (
        <p className="mt-3 text-xs text-neutral-500">
          Only an administrator can resolve or close a complaint. You can work it and add notes.
        </p>
      )}
    </section>
  );
}

/** The live state of a disputed charge. Read-only — this page cannot move money. */
function DisputedCharge({ session }: { session: DisputedSession }) {
  return (
    <section className="rounded-2xl border border-neutral-200 p-6 dark:border-neutral-800">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-sm font-semibold">The charge being disputed</h2>
        <StatusBadge
          tone={session.paymentStatus === 'paid' ? 'good' : 'warn'}
          label={session.paymentStatus}
        />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-neutral-500">Energy</dt>
          <dd className="mt-0.5 font-medium tabular-nums">{session.energyConsumedKwh} kWh</dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-500">Amount</dt>
          <dd className="mt-0.5 font-medium tabular-nums">
            {session.amountPaise === null ? '—' : formatPaise(session.amountPaise)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-500">Rate applied</dt>
          <dd className="mt-0.5 font-medium tabular-nums">
            {session.appliedPricePerKwhPaise === null
              ? '—'
              : formatRate(session.appliedPricePerKwhPaise)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-500">Session</dt>
          <dd className="mt-0.5">
            <Link
              href={`/sessions/${session.sessionId}`}
              className="underline underline-offset-2"
            >
              view
            </Link>
          </dd>
        </div>
      </dl>

      {session.paymentStatus === 'unpaid' && (
        <p className="mt-4 rounded-lg bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          This charge is still outstanding. Resolving the complaint records what was decided — it
          does not adjust the balance.
        </p>
      )}
    </section>
  );
}

function ComplaintDetailContent() {
  const params = useParams<{ complaintId: string }>();
  const { user } = useAuth();
  const isStaff = user?.role !== 'driver';

  const load = useCallback(() => getComplaint(params.complaintId), [params.complaintId]);
  const { state, setData } = useAsyncData(load);

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      {state.status === 'loading' && <p className="text-sm text-neutral-500">Loading…</p>}

      {state.status === 'error' && (
        <p className="rounded-lg bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-400">
          {toMessage(state.error)}
        </p>
      )}

      {state.status === 'ok' && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold">{state.data.complaint.subject}</h1>
              <p className="mt-1 text-sm text-neutral-500">
                {CATEGORY_LABELS[state.data.complaint.category]}
                {' · reported '}
                {new Date(state.data.complaint.createdAt).toLocaleString()}
                {state.data.complaint.priority === 'high' && ' · high priority'}
              </p>
            </div>
            <StatusBadge
              tone={complaintTone(state.data.complaint.status)}
              label={COMPLAINT_STATUS_LABELS[state.data.complaint.status]}
            />
          </div>

          <section className="rounded-2xl border border-neutral-200 p-6 dark:border-neutral-800">
            <h2 className="text-sm font-semibold">What was reported</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm">{state.data.complaint.description}</p>
          </section>

          {state.data.session && <DisputedCharge session={state.data.session} />}

          {state.data.complaint.resolution && (
            <section className="rounded-2xl border border-emerald-600/30 bg-emerald-500/5 p-6">
              <h2 className="text-sm font-semibold">
                {state.data.complaint.resolvedAt ? 'Resolution' : 'Notes so far'}
              </h2>
              <p className="mt-2 whitespace-pre-wrap text-sm">{state.data.complaint.resolution}</p>
              {state.data.complaint.resolvedAt && (
                <p className="mt-2 text-xs text-neutral-500">
                  Resolved {new Date(state.data.complaint.resolvedAt).toLocaleString()}
                </p>
              )}
            </section>
          )}

          {isStaff && (
            <StaffControls
              complaint={state.data.complaint}
              onChanged={(complaint) => setData({ ...state.data, complaint })}
            />
          )}
        </div>
      )}

      <Link
        href="/complaints"
        className="mt-10 inline-block text-sm text-neutral-500 underline underline-offset-4"
      >
        All complaints
      </Link>
    </main>
  );
}

export default function ComplaintDetailPage() {
  return (
    <RequireAuth>
      <ComplaintDetailContent />
    </RequireAuth>
  );
}
