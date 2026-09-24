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
 */

import Link from 'next/link';

import { formatPaise } from '@/lib/money';
import type { ChargingSession, Complaint, PaymentTransaction } from '@/types/api';
import { EmptyState, Panel, relativeTime } from './primitives';

export interface ActivityItem {
  id: string;
  at: string;
  text: string;
  /** Null when the viewer's role has no page to open for this item. */
  href: string | null;
  tone: 'neutral' | 'good' | 'warn' | 'bad';
}

const SESSION_TEXT: Record<string, { text: string; tone: ActivityItem['tone'] }> = {
  initiating: { text: 'is starting', tone: 'neutral' },
  active: { text: 'started charging', tone: 'good' },
  stopping: { text: 'is stopping', tone: 'neutral' },
  completed: { text: 'completed', tone: 'good' },
  failed: { text: 'failed', tone: 'bad' },
};

/**
 * Fold three different resources into one comparable shape.
 *
 * Each carries its own natural timestamp — a session's `updatedAt` is when it last changed
 * state, a complaint's `createdAt` is when it was filed, a payment's `updatedAt` is when it
 * settled. Sorting on "when this last meant something" is what makes a mixed feed readable.
 */
export function buildActivity(
  sessions: ChargingSession[],
  complaints: Complaint[],
  payments: PaymentTransaction[],
  canOpenPayments: boolean,
  limit = 15,
): ActivityItem[] {
  const items: ActivityItem[] = [];

  for (const session of sessions) {
    const label = SESSION_TEXT[session.status] ?? { text: session.status, tone: 'neutral' as const };
    items.push({
      id: `session-${session.id}`,
      at: session.updatedAt,
      text: `Session on connector #${session.connectorNumber} ${label.text}`,
      href: `/sessions/${session.id}`,
      tone: label.tone,
    });
  }

  for (const complaint of complaints) {
    items.push({
      id: `complaint-${complaint.id}`,
      at: complaint.createdAt,
      text: `Complaint filed: ${complaint.subject}`,
      href: `/complaints/${complaint.id}`,
      tone: complaint.priority === 'high' ? 'bad' : 'warn',
    });
  }

  for (const payment of payments) {
    // Only settled money is interesting on an operations feed; a pending order is noise.
    if (payment.status !== 'paid') continue;

    items.push({
      id: `payment-${payment.id}`,
      at: payment.paidAt ?? payment.updatedAt,
      text:
        payment.purpose === 'session_debit'
          ? `Payment collected: ${formatPaise(payment.amountPaise)}`
          : `Wallet topped up: ${formatPaise(payment.amountPaise)}`,
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
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[item.tone]}`} />
      <span className="min-w-0 flex-1 truncate text-sm">{item.text}</span>
      <span className="shrink-0 text-[11px] text-neutral-500">{relativeTime(item.at)}</span>
    </>
  );
}

export function RecentActivity({ items }: { items: ActivityItem[] }) {
  return (
    <Panel title="Recent activity">
      {items.length === 0 ? (
        <EmptyState message="Nothing has happened yet." />
      ) : (
        <ul className="space-y-0.5">
          {items.map((item) => (
            <li key={item.id}>
              {item.href ? (
                <Link
                  href={item.href}
                  className="flex items-baseline gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-neutral-500/5"
                >
                  <ActivityRow item={item} />
                </Link>
              ) : (
                <div className="flex items-baseline gap-2.5 rounded-lg px-2 py-1.5">
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
