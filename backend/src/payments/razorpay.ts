/**
 * Razorpay adapter — the only file that knows a payment provider exists.
 *
 * Everything above this talks about "create an order" and "is this signature valid", never about
 * Razorpay specifically. If a second provider were ever added, this is the file that would gain
 * a sibling.
 *
 * WHAT IS REAL AND WHAT IS STUBBED, and why it is split that way:
 *
 *   creating an order      a network call to Razorpay. Stubbed when credentials are absent
 *   verifying a payment    OUR OWN HMAC. Never stubbed - it is pure crypto we control
 *   verifying a webhook    OUR OWN HMAC. Never stubbed
 *
 * The security-critical half needs no network and no account, so it is fully exercised by the
 * check suite either way. Only the part that genuinely requires a third party is faked.
 *
 * THE STUB IS GATED ON CREDENTIALS BEING ABSENT, NOT ON A FLAG. A deployment with working keys
 * cannot be in stub mode, because the condition is "no keys" rather than "someone set a
 * boolean" — and a boolean is the kind of thing that gets shipped by accident.
 */

import crypto from 'crypto';
import Razorpay from 'razorpay';

import { env } from '../config/env';
import { logger } from '../utils/logger';
import { formatPaise } from '../utils/money';

const SCOPE = 'payments';

/** True when real Razorpay TEST credentials are configured. */
export function isLiveProvider(): boolean {
  return Boolean(env.razorpayKeyId && env.razorpayKeySecret);
}

/**
 * Which mode we are in, for the health endpoint and for tests to assert against.
 *
 * Deliberately surfaced rather than hidden: an operator should be able to see at a glance that
 * their deployment is not actually talking to Razorpay.
 */
export function providerMode(): 'razorpay' | 'stub' {
  return isLiveProvider() ? 'razorpay' : 'stub';
}

let client: Razorpay | null = null;

function getClient(): Razorpay {
  client ??= new Razorpay({ key_id: env.razorpayKeyId, key_secret: env.razorpayKeySecret });
  return client;
}

export interface ProviderOrder {
  orderId: string;
  amountPaise: number;
  /** The PUBLIC key. Safe to hand to a browser — it is how Checkout identifies the merchant. */
  keyId: string;
}

/**
 * Create a payment order.
 *
 * Razorpay takes `amount` in the SMALLEST CURRENCY UNIT — paise. Module 9 chose that
 * representation for correctness reasons, and this is where it pays off: the number goes over
 * the wire exactly as stored, with no conversion layer to get wrong.
 *
 * Throws on provider failure. The caller turns that into a 502 rather than letting it crash the
 * process — a payment provider being down must not take the platform with it.
 */
export async function createOrder(
  amountPaise: number,
  receipt: string,
): Promise<ProviderOrder> {
  if (!isLiveProvider()) {
    // Deterministic, and shaped like a real Razorpay id so nothing downstream needs a special
    // case. `stub_` makes it unmistakable in a database.
    const orderId = `order_stub${crypto.randomBytes(8).toString('hex')}`;
    logger.warn(
      SCOPE,
      `Razorpay keys aren't set, so this ${formatPaise(amountPaise)} top-up uses a fake test order ${orderId} — no real money moves`,
    );
    return { orderId, amountPaise, keyId: 'rzp_test_stub' };
  }

  const order = await getClient().orders.create({
    amount: amountPaise,
    currency: 'INR',
    receipt,
    // Razorpay captures automatically rather than leaving an authorised-but-uncaptured payment
    // that someone has to remember to settle.
    payment_capture: true,
  });

  logger.info(SCOPE, `Created Razorpay order ${order.id} for a ${formatPaise(amountPaise)} wallet top-up`);

  return { orderId: order.id, amountPaise, keyId: env.razorpayKeyId };
}

/* -------------------------------------------------------------------------- */
/* Signature verification — ours, always real                                 */
/* -------------------------------------------------------------------------- */

/**
 * Compare two signatures without leaking their contents through timing.
 *
 * `===` on a string returns as soon as it finds a differing byte, so how long it took reveals
 * how much of a guess was correct. `timingSafeEqual` always compares the whole buffer.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // Different lengths cannot be compared by timingSafeEqual, and are trivially unequal anyway.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * The secret used to sign and verify. In stub mode a fixed development secret stands in, so the
 * REAL verification path is exercised end to end rather than skipped.
 */
function signingSecret(): string {
  return env.razorpayKeySecret || 'stub_secret_not_for_production';
}

/**
 * Verify a completed payment.
 *
 * Razorpay's rule: `HMAC_SHA256(order_id + "|" + payment_id, key_secret)`.
 *
 * THIS IS THE WHOLE REASON THE BACKEND MUST VERIFY. The browser hands us three strings and
 * claims a payment succeeded. Anyone can send that request — the page is under the user's
 * control. Only someone holding the key secret can produce a signature over that exact
 * order/payment pair, and the secret never leaves this server.
 */
export function verifyPaymentSignature(
  orderId: string,
  paymentId: string,
  signature: string,
): boolean {
  const expected = crypto
    .createHmac('sha256', signingSecret())
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  return safeEqual(expected, signature);
}

/**
 * Verify a webhook.
 *
 * The HMAC is over the RAW REQUEST BODY — the exact bytes Razorpay sent. Re-serialising the
 * parsed JSON does not reproduce them (key order and whitespace differ), which is why
 * `app.ts` captures `req.rawBody` before `express.json` discards it.
 *
 * A separate secret from the payment one: webhooks are configured independently in the
 * dashboard, and a leaked webhook secret should not also let someone forge payment signatures.
 */
export function verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
  const secret = env.razorpayWebhookSecret || signingSecret();

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  return safeEqual(expected, signature);
}

/**
 * Sign a payload the way Razorpay would.
 *
 * TWO REAL CALLERS, which is why this is not named `signForTesting`:
 *
 *   1. `handleWebhook` — a webhook carries no client signature, so it mints the one our own
 *      verifier expects and takes the SAME crediting path as a browser-initiated verify. One
 *      code path, one set of guarantees, rather than a second routine that could drift.
 *   2. the check suite — so it can produce genuinely valid signatures and exercise the real
 *      verification path, instead of a test-only bypass inside `verifyPaymentSignature`. A
 *      bypass would mean the thing actually protecting money is the one thing never tested.
 *
 * This is not a way in: producing a signature requires the secret, and anyone holding the
 * secret could sign anyway.
 */
export function signPayload(payload: string): string {
  return crypto.createHmac('sha256', signingSecret()).update(payload).digest('hex');
}
