/**
 * Wallet and payment HTTP handlers. Thin, as always.
 *
 * The one that is genuinely different is the webhook: it has no `req.user`, because Razorpay is
 * not a user. Its authentication is the signature over the raw body, and nothing else.
 */

import type { Request, Response } from 'express';

import * as walletService from '../services/wallet.service';
import * as paymentService from '../services/payment.service';
import { ApiError } from '../utils/ApiError';
import { sendSuccess } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import { paiseToRupees } from '../utils/money';
import type {
  CreateRechargeOrderInput,
  ListPaymentsQuery,
  ListQuery,
  VerifyRechargeInput,
} from '../validators/payment.validator';

function requireUser(req: Request) {
  if (!req.user) throw ApiError.unauthorized('Authentication required.');
  return req.user;
}

/** GET /wallet — created on first access, so this never 404s. */
export const getMyWallet = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);

  const [wallet, outstandingPaise] = await Promise.all([
    walletService.getMyWallet(actor),
    paymentService.getOutstandingTotal(actor.id),
  ]);

  sendSuccess(
    res,
    {
      wallet,
      // What this driver still owes for charges already delivered. Surfaced here so the wallet
      // page can say "top up ₹40 to clear this" rather than leaving them to work it out.
      outstandingPaise,
      outstandingRupees: paiseToRupees(outstandingPaise),
    },
    'Wallet retrieved',
  );
});

/** GET /wallet/transactions — the ledger. */
export const listMyTransactions = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = req.query as unknown as ListQuery;

  const result = await walletService.listMyTransactions(requireUser(req), page, limit);

  sendSuccess(res, result, 'Wallet transactions retrieved');
});

/** POST /wallet/recharge/order — step 1 of a recharge. */
export const createRechargeOrder = asyncHandler(async (req: Request, res: Response) => {
  const { amount } = req.body as CreateRechargeOrderInput;

  const order = await paymentService.createRechargeOrder(requireUser(req), amount);

  sendSuccess(res, { order }, 'Payment order created', 201);
});

/**
 * POST /wallet/recharge/verify — step 2.
 *
 * The browser reports what Checkout gave it. Nothing here is believed until the signature
 * verifies against a secret the browser has never seen.
 */
export const verifyRecharge = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as VerifyRechargeInput;
  const actor = requireUser(req);

  const { payment, alreadyProcessed } = await paymentService.verifyAndCredit(
    {
      providerOrderId: body.razorpay_order_id,
      providerPaymentId: body.razorpay_payment_id,
      signature: body.razorpay_signature,
    },
    actor.id,
  );

  const wallet = await walletService.getMyWallet(actor);

  sendSuccess(
    res,
    { payment, wallet, alreadyProcessed },
    alreadyProcessed ? 'Payment was already processed' : 'Wallet credited',
  );
});

/** GET /payments */
export const listPayments = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, ...filters } = req.query as unknown as ListPaymentsQuery;

  const result = await paymentService.listPayments(requireUser(req), page, limit, filters);

  sendSuccess(res, result, 'Payments retrieved');
});

/** GET /payments/:paymentId */
export const getPaymentById = asyncHandler(async (req: Request, res: Response) => {
  const payment = await paymentService.getPaymentById(
    requireUser(req),
    String(req.params.paymentId),
  );

  sendSuccess(res, { payment }, 'Payment retrieved');
});

/** POST /payments/:paymentId/refund — super_admin only, recharge reversal only. */
export const refundRecharge = asyncHandler(async (req: Request, res: Response) => {
  const payment = await paymentService.refundRecharge(
    requireUser(req),
    String(req.params.paymentId),
  );

  sendSuccess(res, { payment }, 'Recharge reversed');
});

/**
 * POST /payments/webhook/razorpay
 *
 * NO JWT. The caller is Razorpay, not a user — authentication is the HMAC over the raw bytes,
 * which is why `app.ts` keeps `req.rawBody`.
 *
 * ALWAYS 200 FOR A DUPLICATE. Razorpay retries anything that is not a 2xx, so answering "this
 * one failed" for a repeat would generate more repeats. Only a bad signature or a malformed
 * body is a 4xx.
 */
export const razorpayWebhook = asyncHandler(async (req: Request, res: Response) => {
  const signature = req.headers['x-razorpay-signature'];

  if (typeof signature !== 'string') {
    throw ApiError.badRequest('Missing webhook signature.');
  }

  if (!req.rawBody) {
    // Would mean the express.json verify hook in app.ts stopped capturing. Fail loudly rather
    // than silently skipping verification.
    throw ApiError.internal('Raw request body unavailable for signature verification.');
  }

  const result = await paymentService.handleWebhook(req.rawBody, signature);

  sendSuccess(res, result, result.reason);
});
