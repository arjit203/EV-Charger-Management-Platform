'use client';

/**
 * Complaint detail — the driver's view of what happened, and the staff console for doing it.
 *
 * The staff controls only offer transitions that are legal from the CURRENT status, and only
 * those this role may make. That mirrors the independent server-side gates (409 for an illegal
 * transition, 403 for the wrong role) rather than offering buttons that will be refused.
 *
 * The DRIVER gets their own panel once staff mark it resolved: confirm the fix, or reopen it with
 * a reason. After it closes, a returning problem becomes a follow-up complaint linked to this one.
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
import {
  confirmComplaint,
  getComplaint,
  reopenComplaint,
  setComplaintStatus,
  updateComplaint,
} from '@/services/complaint.service';
import type {
  Complaint,
  ComplaintActor,
  ComplaintHistoryEntry,
  ComplaintPriority,
  ComplaintStatus,
  DisputedSession,
} from '@/types/api';

const PRIORITIES: ComplaintPriority[] = ['high', 'medium', 'low'];

/** Mirrors ALLOWED_TRANSITIONS on the server. Closed is terminal. */
const NEXT_STATUSES: Record<ComplaintStatus, ComplaintStatus[]> = {
  open: ['in_progress', 'closed'],
  in_progress: ['open', 'resolved', 'closed'],
  resolved: ['open', 'closed'],
  closed: [],
};

/** Mirrors AUTO_CLOSE_AFTER_MS on the server. */
const AUTO_CLOSE_DAYS = 7;

/**
 * Concluding a ticket, or overturning a conclusion, is an administrative act — an operator can
 * work one, not close it. Mirrors ADMIN_ONLY_TRANSITIONS on the server.
 */
function isAdminOnly(from: ComplaintStatus, to: ComplaintStatus): boolean {
  return to === 'resolved' || to === 'closed' || (from === 'resolved' && to === 'open');
}

/** Say what the button DOES, not the status it lands in — "Mark open" meant nothing to anyone. */
function actionLabel(from: ComplaintStatus, to: ComplaintStatus): string {
  if (to === 'in_progress') return 'Start working on it';
  if (to === 'open') return from === 'resolved' ? 'Reopen (resolution was wrong)' : 'Put back in the queue';
  if (to === 'resolved') return 'Mark resolved';
  return from === 'resolved' ? 'Close now' : 'Close without resolving';
}

const ACTOR_LABELS: Record<ComplaintActor, string> = {
  driver: 'Driver',
  operator: 'Operator',
  cpo_admin: 'Company admin',
  super_admin: 'Platform admin',
  system: 'Automatic',
};

function historyText(entry: ComplaintHistoryEntry): string {
  if (entry.byRole === 'driver' && entry.to === 'open') return 'Reopened — not fixed';
  if (entry.byRole === 'driver' && entry.to === 'closed') return 'Confirmed fixed';
  if (entry.to === 'in_progress') return 'Being worked on';
  if (entry.to === 'open') return entry.from === 'resolved' ? 'Reopened' : 'Back in the queue';
  if (entry.to === 'resolved') return 'Marked resolved';
  return 'Closed';
}

function addDays(iso: string, days: number): Date {
  return new Date(new Date(iso).getTime() + days * 86_400_000);
}

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
    (status) => isAdmin || !isAdminOnly(complaint.status, status),
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

  /**
   * Re-triage. Any staff member may do it — the system only made a first guess from the
   * category, and the person reading the ticket knows more.
   */
  async function changePriority(priority: ComplaintPriority) {
    setIsBusy(true);
    setError(null);
    try {
      onChanged(await updateComplaint(complaint.id, { priority }));
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
        This complaint is closed. Closed complaints cannot be reopened — if the problem comes back,
        the driver files a follow-up linked to this one.
      </p>
    );
  }

  return (
    <section className="rounded-2xl border border-neutral-200 p-6 dark:border-neutral-800">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Handle this complaint</h2>
        <label className="flex items-center gap-2 text-xs text-neutral-500">
          Priority
          <select
            value={complaint.priority}
            onChange={(event) => void changePriority(event.target.value as ComplaintPriority)}
            disabled={isBusy}
            className="rounded-lg border border-neutral-300 bg-transparent px-2 py-1 text-xs outline-none focus:border-[var(--accent)] dark:border-neutral-700"
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        Set automatically from the category and what happened to the charge. Change it if you
        know better — the driver never sees it.
      </p>

      <label className="mt-4 block text-sm">
        <span className="text-neutral-600 dark:text-neutral-400">
          {complaint.status === 'in_progress' ? 'Resolution / notes' : 'Notes'}
        </span>
        <textarea
          value={resolution}
          onChange={(event) => setResolution(event.target.value)}
          rows={4}
          placeholder="What did you find, and what did you do? Required to resolve, or to close without resolving."
          className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
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
            className={
              status === 'closed' || status === 'open'
                ? 'rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium transition-colors hover:bg-neutral-500/10 disabled:opacity-60 dark:border-neutral-700'
                : 'rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-60'
            }
          >
            {actionLabel(complaint.status, status)}
          </button>
        ))}
      </div>

      {complaint.status === 'resolved' && (
        <p className="mt-3 text-xs text-neutral-500">
          Waiting for the driver to confirm. It closes automatically on{' '}
          {addDays(complaint.resolvedAt ?? complaint.updatedAt, AUTO_CLOSE_DAYS).toLocaleDateString()}{' '}
          if they don&apos;t reply.
        </p>
      )}

      {!isAdmin &&
        NEXT_STATUSES[complaint.status].some((s) => isAdminOnly(complaint.status, s)) && (
          <p className="mt-3 text-xs text-neutral-500">
            Only an administrator can resolve, close or reopen a resolved complaint. You can work it
            and add notes.
          </p>
        )}
    </section>
  );
}

/**
 * The driver's side. Resolved is a claim they can dispute; closed is final.
 *
 * Industry standard (Zendesk, Freshdesk): the customer confirms or reopens a resolved ticket, and
 * silence closes it after a few days. A closed ticket is never reopened — a returning problem
 * becomes a new, linked one, so the closed record stays exactly as concluded.
 */
function DriverControls({
  complaint,
  onChanged,
}: {
  complaint: Complaint;
  onChanged: (complaint: Complaint) => void;
}) {
  const [isReopening, setIsReopening] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  async function run(action: () => Promise<Complaint>) {
    setIsBusy(true);
    setError(null);
    try {
      onChanged(await action());
      setIsReopening(false);
      setReason('');
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setIsBusy(false);
    }
  }

  if (complaint.status === 'open' || complaint.status === 'in_progress') {
    return (
      <p className="rounded-lg bg-neutral-500/10 p-4 text-sm text-neutral-600 dark:text-neutral-400">
        {complaint.status === 'open'
          ? 'Waiting for the support team to pick this up.'
          : 'The support team is working on this.'}{' '}
        You will get a notification when it is resolved.
      </p>
    );
  }

  if (complaint.status === 'closed') {
    return (
      <section className="rounded-2xl border border-neutral-200 p-6 text-sm dark:border-neutral-800">
        <p className="text-neutral-600 dark:text-neutral-400">This complaint is closed.</p>
        <Link
          href={`/complaints/new?followUpOf=${complaint.id}`}
          className="mt-2 inline-block font-medium underline underline-offset-4"
        >
          Still a problem? Report it again
        </Link>
      </section>
    );
  }

  // resolved
  return (
    <section className="rounded-2xl border border-emerald-600/30 p-6">
      <h2 className="text-sm font-semibold">Is the problem fixed?</h2>
      <p className="mt-1 text-xs text-neutral-500">
        If you don&apos;t reply, this closes automatically on{' '}
        {addDays(complaint.resolvedAt ?? complaint.updatedAt, AUTO_CLOSE_DAYS).toLocaleDateString()}.
      </p>

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {isReopening ? (
        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="font-medium">What is still wrong?</span>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              placeholder="For example: the charger still stops after two minutes."
              className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void run(() => reopenComplaint(complaint.id, reason.trim()))}
              disabled={isBusy || reason.trim().length < 10}
              className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-700 disabled:opacity-60"
            >
              Reopen complaint
            </button>
            <button
              type="button"
              onClick={() => setIsReopening(false)}
              disabled={isBusy}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium transition-colors hover:bg-neutral-500/10 disabled:opacity-60 dark:border-neutral-700"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void run(() => confirmComplaint(complaint.id))}
            disabled={isBusy}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-60"
          >
            Yes, it&apos;s fixed
          </button>
          <button
            type="button"
            onClick={() => setIsReopening(true)}
            disabled={isBusy}
            className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium transition-colors hover:bg-neutral-500/10 disabled:opacity-60 dark:border-neutral-700"
          >
            No, it&apos;s still a problem
          </button>
        </div>
      )}
    </section>
  );
}

/** Every status change, oldest first — so a reopened ticket keeps what was said the first time. */
function History({ entries }: { entries: ComplaintHistoryEntry[] }) {
  if (entries.length === 0) return null;

  return (
    <section className="rounded-2xl border border-neutral-200 p-6 dark:border-neutral-800">
      <h2 className="text-sm font-semibold">History</h2>
      <ol className="mt-3 space-y-3">
        {entries.map((entry, index) => (
          <li key={index} className="border-l-2 border-neutral-200 pl-3 text-sm dark:border-neutral-800">
            <p>
              <span className="font-medium">{historyText(entry)}</span>
              <span className="text-neutral-500">
                {' · '}
                {ACTOR_LABELS[entry.byRole]}
                {' · '}
                {new Date(entry.at).toLocaleString()}
              </span>
            </p>
            {entry.note && (
              <p className="mt-0.5 whitespace-pre-wrap text-neutral-600 dark:text-neutral-400">
                {entry.note}
              </p>
            )}
          </li>
        ))}
      </ol>
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
                {isStaff && ` · ${state.data.complaint.priority} priority`}
                {state.data.complaint.reopenCount > 0 &&
                  ` · reopened ${state.data.complaint.reopenCount}×`}
              </p>
              {state.data.complaint.followUpOf && (
                <Link
                  href={`/complaints/${state.data.complaint.followUpOf}`}
                  className="mt-1 inline-block text-xs text-neutral-500 underline underline-offset-2"
                >
                  Follow-up to an earlier, closed complaint
                </Link>
              )}
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

          {isStaff ? (
            <StaffControls
              complaint={state.data.complaint}
              onChanged={(complaint) => setData({ ...state.data, complaint })}
            />
          ) : (
            <DriverControls
              complaint={state.data.complaint}
              onChanged={(complaint) => setData({ ...state.data, complaint })}
            />
          )}

          <History entries={state.data.complaint.history} />
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
