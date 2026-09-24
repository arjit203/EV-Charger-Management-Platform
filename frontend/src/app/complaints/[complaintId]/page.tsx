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
  assignComplaint,
  confirmComplaint,
  getComplaint,
  reopenComplaint,
  setComplaintStatus,
  updateComplaint,
} from '@/services/complaint.service';
import { listUsers } from '@/services/user.service';
import type {
  Complaint,
  ComplaintActor,
  ComplaintCategory,
  User,
  ComplaintHistoryEntry,
  ComplaintPriority,
  ComplaintStatus,
  DisputedSession,
} from '@/types/api';
import { formatDate, formatDateTime } from '@/lib/datetime';

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
 * Mirrors the server's operator rules (constants/complaint.ts):
 *   - closing, and overturning a resolution, are admin-only for every category;
 *   - resolving is open to operators for hardware / site / session problems — that is the work
 *     they do — but payment and account tickets end in a decision about a driver's money or
 *     account, so those are concluded by an admin.
 */
const OPERATOR_RESOLVABLE: ComplaintCategory[] = ['charger_issue', 'session_issue', 'station_issue', 'other'];

function isAdminOnly(from: ComplaintStatus, to: ComplaintStatus, category: ComplaintCategory): boolean {
  if (to === 'closed') return true;
  if (from === 'resolved' && to === 'open') return true;
  if (to === 'resolved') return !OPERATOR_RESOLVABLE.includes(category);
  return false;
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

/** Who owns the ticket, and the controls to take, release or hand it over. */
function Assignment({
  complaint,
  isAdmin,
  onChanged,
}: {
  complaint: Complaint;
  isAdmin: boolean;
  onChanged: (complaint: Complaint) => void;
}) {
  const { user } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  // Admins can hand the ticket to a colleague; only staff of the ticket's company can see it.
  const loadStaff = useCallback(async (): Promise<User[]> => {
    if (!isAdmin || !complaint.companyId) return [];
    const page = await listUsers({ companyId: complaint.companyId, status: 'active', limit: 100 });
    return page.items.filter((u) => u.role === 'cpo_admin' || u.role === 'operator');
  }, [isAdmin, complaint.companyId]);
  const { state: staffState } = useAsyncData(loadStaff);
  const staff = staffState.status === 'ok' ? staffState.data : [];

  async function assign(assigneeId: string | null) {
    setIsBusy(true);
    setError(null);
    try {
      onChanged(await assignComplaint(complaint.id, assigneeId));
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setIsBusy(false);
    }
  }

  const mine = user && complaint.assignedTo === user.id;

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
      <span className="text-neutral-500">Owner:</span>
      <span className="font-medium">
        {complaint.assignedTo ? (mine ? 'You' : (complaint.assigneeName ?? 'A colleague')) : 'Unassigned'}
      </span>
      {!mine && user && (
        <button
          type="button"
          onClick={() => void assign(user.id)}
          disabled={isBusy}
          className="rounded-lg border border-neutral-300 px-3 py-1 text-xs font-medium transition-colors hover:bg-neutral-500/10 disabled:opacity-60 dark:border-neutral-700"
        >
          Assign to me
        </button>
      )}
      {complaint.assignedTo && (mine || isAdmin) && (
        <button
          type="button"
          onClick={() => void assign(null)}
          disabled={isBusy}
          className="rounded-lg border border-neutral-300 px-3 py-1 text-xs font-medium transition-colors hover:bg-neutral-500/10 disabled:opacity-60 dark:border-neutral-700"
        >
          Release to queue
        </button>
      )}
      {isAdmin && staff.length > 0 && (
        <select
          value=""
          onChange={(event) => event.target.value && void assign(event.target.value)}
          disabled={isBusy}
          aria-label="Assign to a colleague"
          className="rounded-lg border border-neutral-300 bg-transparent px-2 py-1 text-xs dark:border-neutral-700"
        >
          <option value="">Assign to…</option>
          {staff
            .filter((u) => u.id !== complaint.assignedTo)
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.role === 'operator' ? 'operator' : 'admin'})
              </option>
            ))}
        </select>
      )}
      {error && <p className="w-full text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

/** The internal work log — every entry kept, attributed and timed. Staff only. */
function WorkNotes({ complaint }: { complaint: Complaint }) {
  const notes = complaint.notes ?? [];
  return (
    <div className="mt-5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        Work notes <span className="font-normal normal-case">(internal — the driver never sees these)</span>
      </h3>
      {notes.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500">No notes yet.</p>
      ) : (
        <ol className="mt-2 space-y-2">
          {notes.map((n, index) => (
            <li key={index} className="rounded-lg bg-neutral-500/5 p-3 text-sm">
              <p className="whitespace-pre-wrap">{n.text}</p>
              <p className="mt-1 text-xs text-neutral-500">
                {n.byName ?? ACTOR_LABELS[n.byRole]} · {ACTOR_LABELS[n.byRole]} ·{' '}
                {formatDateTime(n.at)}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * WHO reported it, WHERE, on WHICH machine — the ticket header every help desk has.
 *
 * Without it a complaint was a subject line and some ids; a week after it was resolved nobody
 * could tell which station it had been about. The driver sees the location part (it is their
 * own report); staff also see the reporter's contact details so they can call back.
 */
function TicketDetails({ complaint, isStaff }: { complaint: Complaint; isStaff: boolean }) {
  const rows: { label: string; value: React.ReactNode }[] = [];

  if (isStaff && complaint.reporter) {
    rows.push({
      label: 'Reported by',
      value: (
        <>
          {complaint.reporter.name}
          <span className="block text-xs font-normal text-neutral-500">
            {complaint.reporter.email}
            {complaint.reporter.phone ? ` · ${complaint.reporter.phone}` : ''}
          </span>
        </>
      ),
    });
  }
  rows.push({ label: 'Operator', value: complaint.companyName ?? 'Platform (no station involved)' });
  rows.push({
    label: 'Station',
    value: complaint.station ? (
      <>
        {isStaff ? (
          <Link href={`/stations/${complaint.station.id}`} className="underline underline-offset-2">
            {complaint.station.name}
          </Link>
        ) : (
          complaint.station.name
        )}
        <span className="block text-xs font-normal text-neutral-500">
          {complaint.station.address}, {complaint.station.city}
        </span>
      </>
    ) : (
      '—'
    ),
  });
  rows.push({
    label: 'Charger',
    value: complaint.charger ? (
      <>
        {isStaff ? (
          <Link href={`/chargers/${complaint.charger.id}`} className="underline underline-offset-2">
            {complaint.charger.name}
          </Link>
        ) : (
          complaint.charger.name
        )}
        <span className="block text-xs font-normal text-neutral-500">
          {complaint.connectorNumber ? `Connector #${complaint.connectorNumber}` : 'Whole charger'}
          {complaint.charger.ocppId ? ` · ${complaint.charger.ocppId}` : ''}
        </span>
      </>
    ) : (
      '—'
    ),
  });
  if (complaint.chargingSessionId) {
    rows.push({
      label: 'Charging session',
      value: (
        <Link href={`/sessions/${complaint.chargingSessionId}`} className="underline underline-offset-2">
          Open the session
        </Link>
      ),
    });
  }

  return (
    <section className="rounded-2xl border border-neutral-200 p-6 dark:border-neutral-800">
      <h2 className="text-sm font-semibold">Ticket details</h2>
      <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
        {rows.map((row) => (
          <div key={row.label}>
            <dt className="text-xs text-neutral-500">{row.label}</dt>
            <dd className="mt-0.5 font-medium">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
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
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const available = NEXT_STATUSES[complaint.status].filter(
    (status) => isAdmin || !isAdminOnly(complaint.status, status, complaint.category),
  );
  const blockedForOperator = !isAdmin
    ? NEXT_STATUSES[complaint.status].filter((s) => isAdminOnly(complaint.status, s, complaint.category))
    : [];

  async function run(action: () => Promise<Complaint>) {
    setIsBusy(true);
    setError(null);
    try {
      onChanged(await action());
      return true;
    } catch (caught) {
      setError(toMessage(caught));
      return false;
    } finally {
      setIsBusy(false);
    }
  }

  async function addNote() {
    if (await run(() => updateComplaint(complaint.id, { note: note.trim() }))) setNote('');
  }

  async function move(status: ComplaintStatus) {
    setIsBusy(true);
    setError(null);
    try {
      /*
       * The reply to the driver goes ONLY with the moves that send it: resolving, or closing
       * without resolving (where it is the reason). Sending it with "Start working" or "Put back
       * in the queue" stamped a half-written draft onto the history, which the driver reads.
       */
      const sendsReply =
        (status === 'resolved' || status === 'closed') && complaint.status !== 'resolved';
      const note = sendsReply ? resolution.trim() || undefined : undefined;
      onChanged(await setComplaintStatus(complaint.id, status, note));
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

      <Assignment complaint={complaint} isAdmin={isAdmin} onChanged={onChanged} />

      {/*
        THE OPERATOR'S PLAYBOOK, on the ticket itself. The old screen offered "Put back in queue"
        and "Save note" and nothing else, which left the question "so how do I fix it?" unanswered.
      */}
      {complaint.charger && complaint.status !== 'resolved' && (
        <div className="mt-4 rounded-lg bg-neutral-500/5 p-3 text-xs text-neutral-600 dark:text-neutral-400">
          <p className="font-medium text-neutral-800 dark:text-neutral-200">How to work this ticket</p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4">
            <li>Take it (so nobody else drives to the same site).</li>
            <li>
              Open{' '}
              <Link href={`/chargers/${complaint.charger.id}`} className="underline underline-offset-2">
                {complaint.charger.name}
              </Link>{' '}
              — check it is online, its fault code and the connector status
              {complaint.chargingSessionId && (
                <>
                  , and the{' '}
                  <Link href={`/sessions/${complaint.chargingSessionId}`} className="underline underline-offset-2">
                    session&apos;s meter readings
                  </Link>
                </>
              )}
              .
            </li>
            <li>Fix it remotely or on site, and log each step below as a work note.</li>
            <li>
              {OPERATOR_RESOLVABLE.includes(complaint.category)
                ? 'Write the reply to the driver and mark it resolved — they get to confirm or reopen.'
                : 'This is a payment/account decision: add your findings and leave it for an admin to resolve.'}
            </li>
          </ol>
        </div>
      )}

      <WorkNotes complaint={complaint} />

      <label className="mt-4 block text-sm">
        <span className="text-neutral-600 dark:text-neutral-400">Add a work note (internal)</span>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={2}
          placeholder="What you checked or did — e.g. Charger was offline; power-cycled the unit at site."
          className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
        />
      </label>
      <button
        type="button"
        onClick={() => void addNote()}
        disabled={isBusy || note.trim().length < 2}
        className="mt-2 rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium transition-colors hover:bg-neutral-500/10 disabled:opacity-60 dark:border-neutral-700"
      >
        Add note
      </button>

      {/* Once resolved, the reply has been sent; re-editing it here would suggest otherwise. */}
      {complaint.status !== 'resolved' && (
      <label className="mt-6 block text-sm">
        <span className="text-neutral-600 dark:text-neutral-400">
          Reply to the driver <span className="text-neutral-400">(sent when you resolve or close)</span>
        </span>
        <textarea
          value={resolution}
          onChange={(event) => setResolution(event.target.value)}
          rows={3}
          placeholder="What was wrong and what was done, in words the driver understands. Required to resolve, or to close without resolving."
          className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
        />
      </label>
      )}

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="mt-4 flex flex-wrap gap-2">

        {available.map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => void move(status)}
            disabled={isBusy}
            className={
              status === 'closed' || status === 'open'
                ? 'rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium transition-colors hover:bg-neutral-500/10 disabled:opacity-60 dark:border-neutral-700'
                : 'rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-60'
            }
          >
            {actionLabel(complaint.status, status)}
          </button>
        ))}
      </div>

      {complaint.status === 'resolved' && (
        <p className="mt-3 text-xs text-neutral-500">
          Waiting for the driver to confirm. It closes automatically on{' '}
          {formatDate(addDays(complaint.resolvedAt ?? complaint.updatedAt, AUTO_CLOSE_DAYS))}{' '}
          if they don&apos;t reply.
        </p>
      )}

      {blockedForOperator.length > 0 && (
        <p className="mt-3 text-xs text-neutral-500">
          {blockedForOperator.includes('resolved')
            ? 'Payment and account complaints are resolved by an administrator. '
            : ''}
          Closing a ticket, or reopening a resolved one, is also an administrator decision.
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
        {formatDate(addDays(complaint.resolvedAt ?? complaint.updatedAt, AUTO_CLOSE_DAYS))}.
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
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-60"
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
                {formatDateTime(entry.at)}
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
              <p className="font-mono text-xs text-neutral-500">{state.data.complaint.ticketRef}</p>
              <h1 className="text-2xl font-semibold">{state.data.complaint.subject}</h1>
              <p className="mt-1 text-sm text-neutral-500">
                {CATEGORY_LABELS[state.data.complaint.category]}
                {' · reported '}
                {formatDateTime(state.data.complaint.createdAt)}
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

          <TicketDetails complaint={state.data.complaint} isStaff={isStaff} />

          <section className="rounded-2xl border border-neutral-200 p-6 dark:border-neutral-800">
            <h2 className="text-sm font-semibold">What was reported</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm">{state.data.complaint.description}</p>
          </section>

          {state.data.session && <DisputedCharge session={state.data.session} />}

          {/* Only a CONCLUDED resolution is shown here; a draft lives in the reply box below. */}
          {state.data.complaint.resolution &&
            (state.data.complaint.status === 'resolved' || state.data.complaint.status === 'closed') && (
            <section className="rounded-2xl border border-emerald-600/30 bg-emerald-500/5 p-6">
              <h2 className="text-sm font-semibold">
                {state.data.complaint.status === 'closed' && !state.data.complaint.resolvedAt
                  ? 'Reason for closing'
                  : 'Resolution'}
              </h2>
              <p className="mt-2 whitespace-pre-wrap text-sm">{state.data.complaint.resolution}</p>
              {state.data.complaint.resolvedAt && (
                <p className="mt-2 text-xs text-neutral-500">
                  Resolved {formatDateTime(state.data.complaint.resolvedAt)}
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
