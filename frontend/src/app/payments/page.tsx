'use client';

/**
 * The staff payments ledger.
 *
 * ============================================================================
 * WHY THIS PAGE APPEARED IN MODULE 15.
 *
 * Module 10 built `GET /payments` — staff-facing, company-scoped, paginated —
 * and then only ever built a DRIVER-facing `/wallet` screen on top of it. The
 * endpoint has been sitting there, tested and unused by any page, ever since.
 *
 * Module 15 put a "Payments" entry in the sidebar and pointed the revenue card
 * at it, and the browser walkthrough caught both links returning 404. Rather
 * than delete the entry and leave Billing hollow, this page closes the gap: it
 * is pure integration of an endpoint that already exists, which is exactly what
 * this module is for.
 * ============================================================================
 *
 * READ ONLY, and deliberately so. Refunds are a Module 10 concern with their own rules; this
 * page shows what happened and nothing more. No amount is computed here — `amountPaise` is
 * formatted, never derived.
 */

import { useCallback, useState } from 'react';
import Link from 'next/link';

import { RequireAuth } from '@/components/RequireAuth';
import { StatusBadge } from '@/components/StatusBadge';
import { EmptyState, ErrorState, Panel, SkeletonRows } from '@/components/dashboard/primitives';
import { useAsyncData } from '@/hooks/useAsyncData';
import { toMessage } from '@/lib/formatApiError';
import { formatPaise } from '@/lib/money';
import { listPayments } from '@/services/wallet.service';
import { CompanyFilter, FILTER_SELECT_CLASS } from '@/components/filters';
import type { PaymentPurpose, PaymentStatus, PaymentTransaction } from '@/types/api';
import { formatDateTime } from '@/lib/datetime';

/**
 * The two purposes read very differently on a ledger, and Module 13 made the distinction
 * load-bearing: a recharge is a customer DEPOSIT, a session debit is the SALE. Labelling them
 * plainly here is what stops someone eyeballing this page and adding them together.
 */
const PURPOSE_LABEL: Record<string, string> = {
  wallet_recharge: 'Wallet top-up (deposit)',
  session_debit: 'Charging session (sale)',
};

/**
 * A top-up the driver started and never paid — they closed the Razorpay window.
 *
 * DISPLAY ONLY, deliberately. The record stays `pending`, because a late payment confirmation for
 * that order must still be able to credit the wallet; failing it server-side could lose a real
 * payment. But calling a day-old abandoned checkout "Pending" tells staff money is on its way when
 * it almost certainly is not.
 */
const ABANDONED_AFTER_MS = 60 * 60 * 1000;

function isAbandonedTopUp(payment: PaymentTransaction): boolean {
  return (
    payment.purpose === 'wallet_recharge' &&
    payment.status === 'pending' &&
    Date.now() - new Date(payment.createdAt).getTime() > ABANDONED_AFTER_MS
  );
}

function PaymentsTable({ items }: { items: PaymentTransaction[] }) {
  if (items.length === 0) return <EmptyState message="No payments match." />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[38rem] text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-[11px] font-medium uppercase tracking-[0.08em] text-neutral-500 dark:border-neutral-800">
            <th className="pb-2 font-medium">When</th>
            <th className="pb-2 font-medium">Purpose</th>
            <th className="pb-2 font-medium">Status</th>
            <th className="pb-2 font-medium">Reference</th>
            <th className="pb-2 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100 dark:divide-neutral-900">
          {items.map((payment) => (
            <tr key={payment.id} className="hover:bg-neutral-500/5">
              <td className="py-2.5 text-neutral-500">
                {formatDateTime(payment.paidAt ?? payment.createdAt)}
              </td>
              <td className="py-2.5">{PURPOSE_LABEL[payment.purpose] ?? payment.purpose}</td>
              <td className="py-2.5">
                {isAbandonedTopUp(payment) ? (
                  <StatusBadge tone="neutral" label="Not completed" size="sm" />
                ) : payment.purpose === 'session_debit' && payment.status === 'pending' ? (
                  // A charge the wallet could not cover yet — it settles on the driver's next top-up.
                  <StatusBadge tone="warn" label="Awaiting balance" size="sm" />
                ) : (
                  <StatusBadge status={payment.status} size="sm" />
                )}
              </td>
              <td className="py-2.5">
                {payment.chargingSessionId ? (
                  <Link
                    href={`/sessions/${payment.chargingSessionId}`}
                    className="underline underline-offset-2"
                  >
                    session
                  </Link>
                ) : (
                  <span className="text-neutral-400">—</span>
                )}
              </td>
              <td className="py-2.5 text-right font-medium tabular-nums">
                {formatPaise(payment.amountPaise)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PaymentsPage() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<PaymentStatus | ''>('');
  const [purpose, setPurpose] = useState<PaymentPurpose | ''>('');
  const [companyId, setCompanyId] = useState('');

  const load = useCallback(
    () =>
      listPayments(page, 20, {
        status: status || undefined,
        purpose: purpose || undefined,
        companyId: companyId || undefined,
      }),
    [page, status, purpose, companyId],
  );

  /** Any filter change starts again from page 1 — page 4 of a narrower list may not exist. */
  function filterBy<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value);
      setPage(1);
    };
  }
  const { state, reload } = useAsyncData(load);

  return (
    <main className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold">Payments</h1>
        <p className="text-sm text-neutral-500">
          Every movement recorded against your company, newest first. Deposits and sales are
          labelled separately — they are not the same thing.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <select
          value={status}
          onChange={(e) => filterBy(setStatus)(e.target.value as PaymentStatus | '')}
          aria-label="Filter by payment status"
          className={FILTER_SELECT_CLASS}
        >
          <option value="">All statuses</option>
          <option value="paid">Paid</option>
          <option value="pending">Pending (awaiting balance)</option>
          <option value="failed">Failed</option>
          <option value="refunded">Refunded</option>
        </select>
        <select
          value={purpose}
          onChange={(e) => filterBy(setPurpose)(e.target.value as PaymentPurpose | '')}
          aria-label="Filter by payment type"
          className={FILTER_SELECT_CLASS}
        >
          <option value="">Sales &amp; deposits</option>
          <option value="session_debit">Charging sessions (sales)</option>
          <option value="wallet_recharge">Wallet top-ups (deposits)</option>
        </select>
        <CompanyFilter value={companyId} onChange={filterBy(setCompanyId)} />
      </div>

      <Panel title="Ledger">
        {state.status === 'loading' && <SkeletonRows rows={6} />}
        {state.status === 'error' && (
          <ErrorState message={toMessage(state.error)} onRetry={() => void reload()} />
        )}
        {state.status === 'ok' && (
          <>
            <PaymentsTable items={state.data.items} />

            {state.data.totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between text-sm">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => current - 1)}
                  className="rounded-lg border border-neutral-300 px-3 py-1.5 disabled:opacity-40 dark:border-neutral-700"
                >
                  Previous
                </button>
                <span className="text-neutral-500">
                  Page {state.data.page} of {state.data.totalPages}
                </span>
                <button
                  type="button"
                  disabled={page >= state.data.totalPages}
                  onClick={() => setPage((current) => current + 1)}
                  className="rounded-lg border border-neutral-300 px-3 py-1.5 disabled:opacity-40 dark:border-neutral-700"
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </Panel>
    </main>
  );
}

/**
 * Restricted to the two admin roles — and this is a UX decision, NOT the security boundary.
 *
 * Module 10's `GET /payments` actually admits all four roles and scopes the result per role:
 * a driver sees only their own rows, staff see their company's. This page narrows that to
 * `super_admin` and `cpo_admin` because it belongs to the sidebar's Billing group, which an
 * operator does not get — the same line Module 13 drew when it made revenue a 403 for them.
 * A driver has `/wallet`, which is the same data shaped for one person.
 *
 * If someone types this URL anyway, the API still decides what they receive.
 */
export default function Payments() {
  return (
    <RequireAuth roles={['super_admin', 'cpo_admin']}>
      <PaymentsPage />
    </RequireAuth>
  );
}
