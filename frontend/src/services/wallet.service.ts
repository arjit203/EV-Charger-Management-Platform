/**
 * Wallet and payment API calls.
 *
 * NOTHING HERE SENDS AN AMOUNT THE SERVER DOES NOT ALREADY KNOW. A recharge names the amount the
 * driver wants to add (which the server validates and re-derives in paise); everything else —
 * the session cost, the balance, the debit — is calculated server-side. There is deliberately no
 * function to set a balance, because there is no endpoint that accepts one.
 */

import { apiRequest } from './apiClient';
import type {
  Paginated,
  PaymentPayload,
  PaymentTransaction,
  RechargeOrder,
  RechargeOrderPayload,
  VerifyRechargePayload,
  WalletPayload,
  WalletTransaction,
} from '@/types/api';

/** The wallet, plus what the driver still owes for charges already delivered. */
export function getWallet(): Promise<WalletPayload> {
  return apiRequest<WalletPayload>('/wallet', { cache: 'no-store' });
}

export function listWalletTransactions(page = 1, limit = 20): Promise<Paginated<WalletTransaction>> {
  return apiRequest<Paginated<WalletTransaction>>(
    `/wallet/transactions?page=${page}&limit=${limit}`,
    { cache: 'no-store' },
  );
}

/**
 * Step 1 of a recharge: ask the backend to create a Razorpay order.
 *
 * `amount` is in RUPEES because that is what the driver typed. The backend converts to integer
 * paise and validates the bounds — the browser never decides what is acceptable.
 */
export async function createRechargeOrder(amountRupees: number): Promise<RechargeOrder> {
  const { order } = await apiRequest<RechargeOrderPayload>('/wallet/recharge/order', {
    method: 'POST',
    body: { amount: amountRupees },
  });
  return order;
}

/**
 * Step 2: hand what Checkout returned to the backend for verification.
 *
 * THIS DOES NOT CREDIT THE WALLET. It asks the server to check a signature it alone can verify,
 * and the server credits only if that passes. A forged call to this endpoint achieves nothing,
 * which is the entire reason the flow has two steps instead of one.
 */
export function verifyRecharge(input: {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}): Promise<VerifyRechargePayload> {
  return apiRequest<VerifyRechargePayload>('/wallet/recharge/verify', {
    method: 'POST',
    body: input,
  });
}

/** Scoped server-side: a driver sees their own, staff see their company's collections. */
export function listPayments(page = 1, limit = 20): Promise<Paginated<PaymentTransaction>> {
  return apiRequest<Paginated<PaymentTransaction>>(`/payments?page=${page}&limit=${limit}`, {
    cache: 'no-store',
  });
}

export async function getPayment(paymentId: string): Promise<PaymentTransaction> {
  const { payment } = await apiRequest<PaymentPayload>(`/payments/${paymentId}`, {
    cache: 'no-store',
  });
  return payment;
}
