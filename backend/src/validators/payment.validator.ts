/**
 * Request validation for wallet and payments.
 *
 * WHAT IS NOT ACCEPTED ANYWHERE IN THIS FILE, and never will be:
 *
 *   balance / balancePaise   a balance is moved, never set
 *   userId / walletId        derived from the verified token
 *   the session amount       derived from the ChargingSession
 *
 * `.strict()` means an attempt to send any of them is a visible 422 rather than a silent strip.
 * A request asks for an operation; it does not dictate the resulting financial state.
 */

import { z } from 'zod';
import { PAYMENT_STATUSES, PAYMENT_PURPOSES } from '../constants/wallet';

import { MAX_RECHARGE_PAISE, MIN_RECHARGE_PAISE } from '../constants/wallet';
import { rupeesToPaise } from '../utils/money';

const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid 24-character resource id');

export const paymentIdParamSchema = z.object({ paymentId: objectId });

/**
 * A recharge amount in RUPEES, converted to integer paise at this single boundary.
 *
 * Rounded, never truncated: `12.34 * 100` is `1233.9999999999998` in IEEE-754, and truncating
 * would quietly short the driver a paisa.
 */
export const createRechargeOrderSchema = z
  .object({
    amount: z.coerce
      .number()
      .positive('Amount must be greater than zero')
      .transform(rupeesToPaise)
      .refine((paise) => paise >= MIN_RECHARGE_PAISE, { message: 'Minimum recharge is ₹10' })
      .refine((paise) => paise <= MAX_RECHARGE_PAISE, { message: 'Maximum recharge is ₹10,000' }),
  })
  .strict();

/**
 * The three values Razorpay Checkout hands back.
 *
 * None of them is trusted on arrival. The signature is an HMAC over the other two using a
 * secret only the server holds, so a forged request cannot produce a valid one — which is the
 * entire reason this endpoint exists rather than the browser simply telling us it worked.
 */
export const verifyRechargeSchema = z
  .object({
    razorpay_order_id: z.string().min(4).max(120),
    razorpay_payment_id: z.string().min(4).max(120),
    razorpay_signature: z.string().min(16).max(256),
  })
  .strict();

export const listQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export type CreateRechargeOrderInput = z.infer<typeof createRechargeOrderSchema>;
export type VerifyRechargeInput = z.infer<typeof verifyRechargeSchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;

/**
 * The billing ledger's filters. What a finance user reaches for first: what state is the money
 * in, is it a sale or a deposit, and — for the platform admin — whose is it.
 */
export const listPaymentsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    status: z.enum(PAYMENT_STATUSES).optional(),
    purpose: z.enum(PAYMENT_PURPOSES).optional(),
    /** Honoured for super_admin only; everyone else is already scoped to their company. */
    companyId: objectId.optional(),
  })
  .strict();

export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;
