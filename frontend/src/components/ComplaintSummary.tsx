import Link from 'next/link';

import { StatusBadge, type Tone } from '@/components/StatusBadge';
import type { Complaint, ComplaintCategory, ComplaintPriority, ComplaintStatus } from '@/types/api';

/**
 * Complaint vocabulary, translated once for the whole app.
 *
 * `open` is amber rather than red: it means "reported, not yet picked up", which is a normal
 * queue state, not a failure. Only a stale one would be a problem, and nothing here measures age.
 */
export function complaintTone(status: ComplaintStatus): Tone {
  if (status === 'resolved') return 'good';
  if (status === 'closed') return 'neutral';
  if (status === 'in_progress') return 'warn';
  return 'warn';
}

export const COMPLAINT_STATUS_LABELS: Record<ComplaintStatus, string> = {
  open: 'open',
  in_progress: 'in progress',
  resolved: 'resolved',
  closed: 'closed',
};

export const CATEGORY_LABELS: Record<ComplaintCategory, string> = {
  charger_issue: 'Charger problem',
  session_issue: 'Charging session problem',
  payment_issue: 'Payment problem',
  station_issue: 'Station problem',
  account_issue: 'Account problem',
  other: 'Something else',
};

export const PRIORITY_TONES: Record<ComplaintPriority, Tone> = {
  low: 'neutral',
  medium: 'neutral',
  high: 'bad',
};

/** One row in a complaint list — used by both the driver view and the staff queue. */
/** `showPriority` is for staff only — priority is internal triage, not something the driver sees. */
export function ComplaintRow({
  complaint,
  showPriority = false,
}: {
  complaint: Complaint;
  showPriority?: boolean;
}) {
  return (
    <Link
      href={`/complaints/${complaint.id}`}
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-200 p-4 transition-colors hover:bg-neutral-500/5 dark:border-neutral-800"
    >
      <div className="min-w-0">
        <p className="truncate font-medium">{complaint.subject}</p>
        <p className="mt-0.5 truncate text-xs text-neutral-500">
          {CATEGORY_LABELS[complaint.category]}
          {' · '}
          {new Date(complaint.createdAt).toLocaleDateString()}
          {showPriority && complaint.priority === 'high' && ' · high priority'}
        </p>
      </div>
      <StatusBadge
        tone={complaintTone(complaint.status)}
        label={COMPLAINT_STATUS_LABELS[complaint.status]}
      />
    </Link>
  );
}
