'use client';

/**
 * A recent-activity feed — assembled, not stored.
 *
 * ============================================================================
 * NO NEW BACKEND. NO ACTIVITY MODEL. NO EVENT LOG.
 *
 * Nothing in Modules 0-14 built a unified activity stream, and this module does
 * not build one either. The feed is the last few rows from three endpoints that
 * already exist, merge-sorted by timestamp in the browser:
 *
 *   GET /charging/sessions   recent sessions
 *   GET /complaints          recent tickets
 *   GET /payments            recent money movements
 *
 * It is a DERIVED VIEW. If a row cannot be read from an endpoint that already
 * exists, it does not appear here.
 * ============================================================================
 *
 * IT IS NOT MODULE 12'S NOTIFICATIONS, and the two must not be conflated:
 *
 *   Notifications          one PERSON's record. Persisted, deduped, read/unread, pushed
 *                          to their own user room.
 *   This activity feed     an OPERATIONAL view for staff. Assembled fresh on each load,
 *                          no storage, no read state, no delivery guarantee.
 *
 * Every row is already company-scoped, because every endpoint it reads from is.
 *
 * WHAT A ROW MUST ANSWER. The first version said "Session on connector #1 completed" — true, and
 * useless: which station? whose car? how much? A feed an operator cannot act on is noise. Every
 * row now answers WHAT happened (headline, with the number that matters), WHERE and to WHOM
 * (detail line), and links to the record that explains it. The labels come from the server
 * (station, charger, driver, reporter), resolved on the same list endpoints.
 */

import Link from 'next/link';

import { CATEGORY_LABELS, COMPLAINT_STATUS_LABELS } from '@/components/ComplaintSummary';
import { describeStop } from '@/components/SessionSummary';
import { formatPaise } from '@/lib/money';
import type { ChargingSession, Complaint, PaymentTransaction } from '@/types/api';
import { EmptyState, Panel, relativeTime } from './primitives';

export interface ActivityItem {
  id: string;
  at: string;
  /** What happened, with the number that matters. */
  text: string;
  /** Where, on what, and who — the context that makes the row actionable. */
  detail: string;
  /** Shown as a chip so a mixed feed can be scanned by type. */
  kind: 'Charge' | 'Complaint' | 'Payment';
  /** Null when the viewer's role has no page to open for this item. */
  href: string | null;
  tone: 'neutral' | 'good' | 'warn' | 'bad';
}

function kwh(session: ChargingSession): string {
  return `${session.energyConsumedKwh.toFixed(2)} kWh`;
}

function isForceStopped(session: ChargingSession): boolean {
  return Boolean(session.stoppedByRole && session.stoppedByRole !== 'driver');
}

function sessionHeadline(session: ChargingSession): { text: string; tone: ActivityItem['tone'] } {
  const amount = session.amountPaise !== null ? ` · ${formatPaise(session.amountPaise)}` : '';
  const forced = isForceStopped(session);

  switch (session.status) {
    case 'initiating':
      return { text: 'Charge requested — waiting for the charger to confirm', tone: 'neutral' };
    case 'active':
      return { text: `Charging now — ${kwh(session)} so far`, tone: 'good' };
    case 'stopping':
      return { text: forced ? 'Force-stop sent to the charger' : 'Stop sent to the charger', tone: 'neutral' };
    case 'completed':
      return {
        text: `${forced ? 'Charge force-stopped' : 'Charge completed'} — ${kwh(session)}${amount}`,
        tone: forced ? 'warn' : 'good',
      };
    case 'failed':
      return {
        text: `Charge failed — ${session.failureReason ?? describeStop(session) ?? 'ended unexpectedly'}`,
        tone: 'bad',
      };
    default:
      return { text: `Charge ${String(session.status)}`, tone: 'neutral' };
  }
}

function sessionDetail(session: ChargingSession): string {
  const place = [session.stationName, session.stationCity].filter(Boolean).join(', ');
  const plug = `${session.chargerName ?? 'Charger'} #${session.connectorNumber}${
    session.connectorType ? ` ${session.connectorType}` : ''
  }`;
  return [
    place || null,
    plug,
    session.driverName ?? null,
    session.paymentStatus === 'unpaid' && session.amountPaise ? 'payment outstanding' : null,
    isForceStopped(session) ? describeStop(session) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function complaintDetail(complaint: Complaint): string {
  const place = complaint.station
    ? `${complaint.station.name}, ${complaint.station.city}`
    : 'No station (account / general)';
  const machine = complaint.charger
    ? `${complaint.charger.name}${complaint.connectorNumber ? ` #${complaint.connectorNumber}` : ''}`
    : null;
  const owner = complaint.assigneeName
    ? `with ${complaint.assigneeName}`
    : complaint.status === 'open'
      ? 'unassigned'
      : null;

  return [
    place,
    machine,
    complaint.reporter ? `reported by ${complaint.reporter.name}` : null,
    COMPLAINT_STATUS_LABELS[complaint.status],
    owner,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Fold three resources into one comparable shape, newest first.
 *
 * Each carries its own natural timestamp — a session's `updatedAt` is when it last changed state,
 * a complaint's `updatedAt` when it was last worked, a payment's `paidAt` when money moved.
 */
export function buildActivity(
  sessions: ChargingSession[],
  complaints: Complaint[],
  payments: PaymentTransaction[],
  canOpenPayments: boolean,
  limit = 12,
): ActivityItem[] {
  const items: ActivityItem[] = [];
  const sessionById = new Map(sessions.map((s) => [s.id, s]));

  for (const session of sessions) {
    const head = sessionHeadline(session);
    items.push({
      id: `session-${session.id}`,
      at: session.updatedAt,
      kind: 'Charge',
      text: head.text,
      detail: sessionDetail(session),
      href: `/sessions/${session.id}`,
      tone: head.tone,
    });
  }

  for (const complaint of complaints) {
    const concluded = complaint.status === 'resolved' || complaint.status === 'closed';
    items.push({
      id: `complaint-${complaint.id}`,
      at: complaint.updatedAt,
      kind: 'Complaint',
      text: `${complaint.ticketRef} · ${CATEGORY_LABELS[complaint.category]} — "${complaint.subject}"`,
      detail: complaintDetail(complaint),
      href: `/complaints/${complaint.id}`,
      tone: concluded ? 'neutral' : complaint.priority === 'high' ? 'bad' : 'warn',
    });
  }

  for (const payment of payments) {
    // Only settled money is interesting on an operations feed; a pending order is noise.
    if (payment.status !== 'paid') continue;

    const session = payment.chargingSessionId ? sessionById.get(payment.chargingSessionId) : undefined;
    items.push({
      id: `payment-${payment.id}`,
      at: payment.paidAt ?? payment.updatedAt,
      kind: 'Payment',
      text:
        payment.purpose === 'session_debit'
          ? `Payment collected — ${formatPaise(payment.amountPaise)} from the driver's wallet`
          : `Wallet top-up — ${formatPaise(payment.amountPaise)}`,
      detail: session
        ? `For the charge at ${sessionDetail(session)}`
        : payment.purpose === 'session_debit'
          ? 'Debited for a completed charge'
          : 'A driver added money to their wallet',
      href: payment.chargingSessionId
        ? `/sessions/${payment.chargingSessionId}`
        : canOpenPayments
          ? '/payments'
          : null,
      tone: 'good',
    });
  }

  return items
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, limit);
}

const TONE_DOT: Record<ActivityItem['tone'], string> = {
  neutral: 'bg-neutral-400',
  good: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
};

function ActivityRow({ item }: { item: ActivityItem }) {
  return (
    <>
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TONE_DOT[item.tone]}`} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="shrink-0 rounded bg-neutral-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">
            {item.kind}
          </span>
          <span className="truncate text-sm font-medium">{item.text}</span>
        </span>
        {item.detail && (
          <span className="mt-0.5 block truncate text-xs text-neutral-500">{item.detail}</span>
        )}
      </span>
      <span className="shrink-0 text-[11px] text-neutral-500">{relativeTime(item.at)}</span>
    </>
  );
}

export function RecentActivity({ items }: { items: ActivityItem[] }) {
  return (
    <Panel title="Recent activity" action={{ href: '/sessions', label: 'All sessions →' }}>
      <p className="mb-2 text-xs text-neutral-500">
        The latest charges, complaints and payments on your network. Red and amber rows need
        attention — open any row for the full record.
      </p>
      {items.length === 0 ? (
        <EmptyState message="Nothing has happened yet." />
      ) : (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {items.map((item) => (
            <li key={item.id}>
              {item.href ? (
                <Link
                  href={item.href}
                  className="flex items-start gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-neutral-500/5"
                >
                  <ActivityRow item={item} />
                </Link>
              ) : (
                <div className="flex items-start gap-2.5 rounded-lg px-2 py-2">
                  <ActivityRow item={item} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
