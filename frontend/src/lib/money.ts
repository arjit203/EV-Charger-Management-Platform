/**
 * Money formatting — the ONLY place rupees exist in the frontend.
 *
 * Everything crossing the wire is integer paise. These helpers convert at the very edge, for
 * rendering and for form inputs, and nothing else divides by 100.
 *
 * Keeping that discipline is what stops a float sneaking back in: if rupee values only ever
 * exist inside a JSX expression or a form field, there is nowhere for arithmetic drift to
 * accumulate.
 */

const PAISE_PER_RUPEE = 100;

/** "₹30.00". Always two decimals, so a price never renders as a bare "₹30". */
export function formatPaise(paise: number): string {
  return `₹${(paise / PAISE_PER_RUPEE).toFixed(2)}`;
}

/** "₹12.00 / kWh" */
export function formatRate(pricePerKwhPaise: number): string {
  return `${formatPaise(pricePerKwhPaise)} / kWh`;
}

/** For pre-filling a form field, where a human expects rupees. */
export function paiseToRupees(paise: number): number {
  return paise / PAISE_PER_RUPEE;
}

/**
 * A LIVE cost estimate while charging.
 *
 * Deliberately client-side: Module 8 already streams `energyConsumedKwh` on every meter update,
 * and the rate was snapshotted onto the session when it started. The estimate is those two
 * numbers multiplied — so it needs no new endpoint, no new Socket.IO event, and no extra
 * backend work at all.
 *
 * It is an ESTIMATE and nothing more. The authoritative amount is computed on the server when
 * the session reaches a terminal state, from the final meter reading. This exists so a driver
 * can watch the cost climb, not so anyone can be billed from it.
 */
export function estimateAmountPaise(
  energyConsumedKwh: number,
  pricePerKwhPaise: number | null,
): number | null {
  if (pricePerKwhPaise === null) return null;
  return Math.round(energyConsumedKwh * pricePerKwhPaise);
}
