import { Router } from 'express';

import {
  createRechargeOrder,
  getMyWallet,
  getPaymentById,
  listMyTransactions,
  listPayments,
  razorpayWebhook,
  refundRecharge,
  verifyRecharge,
} from '../controllers/payment.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { authorize } from '../middlewares/role.middleware';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate.middleware';
import { ROLES } from '../constants/roles';
import {
  createRechargeOrderSchema,
  listPaymentsQuerySchema,
  listQuerySchema,
  paymentIdParamSchema,
  verifyRechargeSchema,
} from '../validators/payment.validator';

const router = Router();

/*
 * Mounted at /payments, with the wallet routes under /wallet in routes/index.ts.
 *
 * THE WEBHOOK IS DECLARED FIRST AND IS DELIBERATELY UNAUTHENTICATED. It is the only route in
 * the entire project outside `/auth` without `authenticate`, because the caller is Razorpay
 * rather than a user. Its credential is the HMAC signature over the raw body — a forged request
 * cannot produce one without the webhook secret.
 *
 * It must be registered BEFORE `router.use(authenticate)` below, or the JWT middleware would
 * reject Razorpay before the handler ever ran.
 */
router.post('/webhook/razorpay', razorpayWebhook);

router.use(authenticate);

/**
 * Reading payments.
 *
 * Scoped differently by the service: a driver sees their own, admins see collections at their
 * own company's stations. Same dual-scope shape as Module 7's sessions.
 *
 * NOT OPERATORS. Analytics already withholds revenue from them and the Payments page is admin-only,
 * but this route let an operator list every collection with its amount — summing the list
 * rebuilt the exact revenue figure the analytics endpoint refuses. No operator screen reads it.
 */
router.get(
  '/',
  authorize(ROLES.SUPER_ADMIN, ROLES.CPO_ADMIN, ROLES.DRIVER),
  validateQuery(listPaymentsQuerySchema),
  listPayments,
);

router.get(
  '/:paymentId',
  authorize(ROLES.SUPER_ADMIN, ROLES.CPO_ADMIN, ROLES.DRIVER),
  validateParams(paymentIdParamSchema),
  getPaymentById,
);

/**
 * Reversing a recharge. super_admin only, and deliberately the only write here.
 *
 * There is no endpoint anywhere that sets a balance — not for admins either. Money moves only
 * through a verified payment, a session debit, or this reversal.
 */
router.post(
  '/:paymentId/refund',
  authorize(ROLES.SUPER_ADMIN),
  validateParams(paymentIdParamSchema),
  refundRecharge,
);

export default router;

/* -------------------------------------------------------------------------- */

/**
 * Wallet routes, mounted separately at /wallet.
 *
 * DRIVER ONLY, every one of them. Staff have no wallet — they do not charge vehicles — and a
 * driver's balance and ledger are personal data, scoped by `userId` with no super_admin bypass
 * (Module 3's rule). An admin who needs to see a payment uses `/payments` above, which is an
 * auditable path rather than a widened self-service query.
 */
export const walletRouter = Router();

walletRouter.use(authenticate);
walletRouter.use(authorize(ROLES.DRIVER));

walletRouter.get('/', getMyWallet);

walletRouter.get('/transactions', validateQuery(listQuerySchema), listMyTransactions);

walletRouter.post('/recharge/order', validateBody(createRechargeOrderSchema), createRechargeOrder);

walletRouter.post('/recharge/verify', validateBody(verifyRechargeSchema), verifyRecharge);
