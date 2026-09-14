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
import { EmptyState, ErrorState, Panel, SkeletonRows } from '@/components/dashboard/primitives';
import { useAsyncData } from '@/hooks/useAsyncData';
import { toMessage } from '@/lib/formatApiError';
import { formatPaise } from '@/lib/money';
import { listPayments } from '@/services/wallet.service';
import type { PaymentStatus, PaymentTransaction } from '@/types/api';

const STATUS_TONE: Record<PaymentStatus, string> = {
  paid: 'text-emerald-600 dark:text-emerald-400',
  pending: 'text-amber-600 dark:text-amber-500',
  failed: 'text-red-600 dark:text-red-500',
  refunded: 'text-neutral-500',
};

/**
 * The two purposes read very differently on a ledger, and Module 13 made the distinction
 * load-bearing: a recharge is a customer DEPOSIT, a session debit is the SALE. Labelling them
 * plainly here is what stops someone eyeballing this page and adding them together.
 */
const PURPOSE_LABEL: Record<string, string> = {
  wallet_recharge: 'Wallet top-up (deposit)',
  session_debit: 'Charging session (sale)',
};

function PaymentsTable({ items }: { items: PaymentTransaction[] }) {
  if (items.length === 0) return <EmptyState message="No payments recorded yet." />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[38rem] text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-[11px] uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
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
              <td className="py-2 text-neutral-500">
                {new Date(payment.paidAt ?? payment.createdAt).toLocaleString()}
              </td>
              <td className="py-2">{PURPOSE_LABEL[payment.purpose] ?? payment.purpose}</td>
              <td className={`py-2 ${STATUS_TONE[payment.status]}`}>{payment.status}</td>
              <td className="py-2">
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
              <td className="py-2 text-right font-medium tabular-nums">
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

  const load = useCallback(() => listPayments(page, 20), [page]);
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
