'use client';

/**
 * The driver's wallet — balance, recharge, and the ledger.
 *
 * RAZORPAY CHECKOUT runs in the browser, but nothing it says is believed. The flow is:
 *
 *   ask the backend for an order  ->  open Checkout  ->  Checkout reports success
 *   ->  send what it reported to the backend  ->  the BACKEND verifies the signature and credits
 *
 * A forged "it worked" achieves nothing, because the signature is an HMAC over a secret the
 * browser has never seen. That is why this file only ever *asks* for a credit.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import { RequireAuth } from '@/components/RequireAuth';
import { StatusBadge } from '@/components/StatusBadge';
import { useAsyncData } from '@/hooks/useAsyncData';
import { formatPaise } from '@/lib/money';
import { toMessage } from '@/lib/formatApiError';
import {
  createRechargeOrder,
  getWallet,
  listWalletTransactions,
  verifyRecharge,
} from '@/services/wallet.service';
import type { WalletTransaction } from '@/types/api';
import { formatDateTime } from '@/lib/datetime';

/** Razorpay injects this global when its script loads. */
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

function loadCheckout(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);

  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = CHECKOUT_SRC;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

const PRESETS = [100, 250, 500, 1000];

function LedgerRow({ entry }: { entry: WalletTransaction }) {
  const isCredit = entry.direction === 'credit';

  return (
    <div className="list-row">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{entry.description}</p>
        <p className="mt-0.5 text-xs text-neutral-500">
          {formatDateTime(entry.createdAt)}
          {entry.chargingSessionId && (
            <>
              {' · '}
              <Link
                href={`/sessions/${entry.chargingSessionId}`}
                className="underline underline-offset-2"
              >
                view session
              </Link>
            </>
          )}
        </p>
      </div>
      <div className="text-right tabular-nums">
        <p className={`font-medium ${isCredit ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>
          {isCredit ? '+' : '−'}
          {formatPaise(entry.amountPaise)}
        </p>
        <p className="text-xs text-neutral-500">{formatPaise(entry.balanceAfterPaise)}</p>
      </div>
    </div>
  );
}

function WalletContent() {
  const load = useCallback(
    async () => ({
      wallet: await getWallet(),
      ledger: await listWalletTransactions(1, 25),
    }),
    [],
  );

  const { state, reload } = useAsyncData(load);

  const [amount, setAmount] = useState('500');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [checkoutReady, setCheckoutReady] = useState(false);

  useEffect(() => {
    void loadCheckout().then(setCheckoutReady);
  }, []);

  async function recharge() {
    setIsBusy(true);
    setError(null);
    setNotice(null);

    try {
      const order = await createRechargeOrder(Number(amount));

      /*
       * With no Razorpay credentials configured the backend runs a stub provider, and there is
       * no real Checkout to open. Say so plainly rather than opening a window that cannot work.
       */
      if (order.mode === 'stub' || !window.Razorpay) {
        setError(
          order.mode === 'stub'
            ? 'Payments are running in stub mode — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in the backend to use real test checkout.'
            : 'Could not load Razorpay Checkout. Check your connection.',
        );
        setIsBusy(false);
        return;
      }

      const checkout = new window.Razorpay({
        key: order.keyId,
        amount: order.amountPaise,
        currency: 'INR',
        name: 'EV-CMS',
        description: 'Wallet recharge',
        order_id: order.providerOrderId,
        handler: (response: Record<string, string>) => {
          // Checkout says it worked. That is a claim, not proof — the backend decides.
          void verifyRecharge({
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
          })
            .then((result) => {
              setNotice(
                result.alreadyProcessed
                  ? 'That payment had already been credited.'
                  : `Added ${formatPaise(result.payment.amountPaise)} to your wallet.`,
              );
              void reload();
            })
            .catch((caught: unknown) => setError(toMessage(caught)))
            .finally(() => setIsBusy(false));
        },
        modal: { ondismiss: () => setIsBusy(false) },
      });

      checkout.open();
    } catch (caught) {
      setError(toMessage(caught));
      setIsBusy(false);
    }
  }

  return (
    <main className="page page-detail page-flow">
      <h1 className="text-2xl font-semibold tracking-tight">Wallet</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Charging is paid for from your balance the moment a session ends.
      </p>

      {state.status === 'loading' && <p className="mt-8 text-sm text-neutral-500">Loading…</p>}

      {state.status === 'error' && (
        <p className="mt-8 rounded-lg bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-400">
          {toMessage(state.error)}
        </p>
      )}

      {state.status === 'ok' && (
        <>
          <div className="mt-8 rounded-2xl border border-neutral-200 p-6 dark:border-neutral-800">
            <p className="text-xs uppercase tracking-wide text-neutral-500">Balance</p>
            <p className="mt-1 text-4xl font-semibold tabular-nums">
              {formatPaise(state.data.wallet.wallet.balancePaise)}
            </p>
            {state.data.wallet.wallet.status !== 'active' && (
              <div className="mt-3">
                <StatusBadge tone="bad" label="blocked" />
              </div>
            )}

            {state.data.wallet.outstandingPaise > 0 && (
              <p className="mt-4 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
                You owe <strong>{formatPaise(state.data.wallet.outstandingPaise)}</strong> for
                charging already delivered. Top up and it settles automatically — no need to pay
                it separately.
              </p>
            )}
          </div>

          <section className="mt-8 rounded-2xl border border-neutral-200 p-6 dark:border-neutral-800">
            <h2 className="text-sm font-semibold">Add money</h2>

            <div className="mt-4 flex flex-wrap gap-2">
              {PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setAmount(String(preset))}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                    amount === String(preset)
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                      : 'border-neutral-300 hover:bg-neutral-500/10 dark:border-neutral-700'
                  }`}
                >
                  ₹{preset}
                </button>
              ))}
            </div>

            <div className="mt-4 flex gap-2">
              <input
                type="number"
                min="10"
                max="10000"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className="w-32 rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm tabular-nums dark:border-neutral-700"
              />
              <button
                type="button"
                onClick={() => void recharge()}
                disabled={isBusy || !checkoutReady}
                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-60"
              >
                {isBusy ? 'Opening…' : 'Add money'}
              </button>
            </div>

            <p className="mt-2 text-xs text-neutral-500">Between ₹10 and ₹10,000.</p>

            {notice && (
              <p className="mt-3 rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-400">
                {notice}
              </p>
            )}
            {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
          </section>

          <section className="mt-10">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
              History ({state.data.ledger.total})
            </h2>
            <div className="mt-3 space-y-2">
              {state.data.ledger.items.length === 0 && (
                <p className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
                  Nothing yet. Add money to get started.
                </p>
              )}
              {state.data.ledger.items.map((entry) => (
                <LedgerRow key={entry.id} entry={entry} />
              ))}
            </div>
          </section>
        </>
      )}
    </main>
  );
}

export default function WalletPage() {
  return (
    <RequireAuth roles={['driver']}>
      <WalletContent />
    </RequireAuth>
  );
}
