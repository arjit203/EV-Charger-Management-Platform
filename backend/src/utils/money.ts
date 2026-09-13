/**
 * Money arithmetic — integer paise, never floats.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: every amount in this project is an INTEGER number of
 * paise. Not rupees, not a float, not a Decimal128. Rupees appear only where a human reads
 * them, which is the display layer of the frontend.
 *
 * Why integers rather than "just be careful with floats":
 *
 *   0.1 + 0.2 === 0.30000000000000004
 *
 * That is not a JavaScript quirk to be worked around; it is how binary floating point
 * represents decimal fractions, and it applies to every language with IEEE-754 doubles. A
 * billing total built from repeated float arithmetic drifts, and the drift is invisible until
 * a customer disputes a bill. With integers the wrong value is not merely unlikely, it is
 * unrepresentable — there is no bit pattern for 1049.9999 paise.
 *
 * It also happens to be what Razorpay's API expects in Module 10, so an amount computed here
 * is passed through unchanged rather than converted at the boundary. That is a convenience,
 * not the reason.
 *
 * THE UNIT LIVES IN THE NAME. Every field and parameter carrying money is called `...Paise`.
 * A bare `amount` can be misread; `amountPaise` cannot.
 */

/** The only currency this platform handles. See the note below on why it is not a DB field. */
export const CURRENCY = 'INR' as const;

/**
 * `currency` is deliberately NOT a column on Tariff or ChargingSession.
 *
 * A field with exactly one legal value is a field with no consumer — the same reasoning that
 * deferred GeoJSON in Module 4 and the connectivity fields in Module 5. Module 10 needs the
 * string 'INR' for Razorpay, and a constant supplies it. If the platform ever genuinely goes
 * multi-currency, adding the column is an additive migration in which every existing row is
 * already correct.
 */

export const PAISE_PER_RUPEE = 100;

/** Watt-hours per kilowatt-hour. Named because the 1000 below is otherwise a mystery number. */
const WH_PER_KWH = 1000;

/**
 * The cost of a charging session.
 *
 *   amountPaise = round(energyWh × pricePerKwhPaise / 1000)
 *
 * Energy is stored in watt-hours (Module 7's choice, matching what OCPP carries), and the rate
 * is per kilowatt-hour, so the division by 1000 reconciles the two.
 *
 * ROUNDED EXACTLY ONCE, at the end. Rounding intermediate values is how a calculation that
 * looks correct accumulates error. `Math.round` is half-up, which is what a customer expects
 * and what a human doing the sum on paper would produce.
 *
 * The multiplication happens before the division on purpose: `energyWh * rate` stays an
 * integer-valued number well inside the safe range (a 350 kW charger running flat out for a
 * day is ~8.4M Wh; at ₹1000/kWh that is ~8.4e11, against a safe limit of ~9e15), whereas
 * dividing first would reintroduce the fraction this whole file exists to avoid.
 *
 * @param energyWh          Energy delivered, in watt-hours. May carry decimals from the meter.
 * @param pricePerKwhPaise  The rate snapshotted onto the session when it started.
 */
export function calculateAmountPaise(energyWh: number, pricePerKwhPaise: number): number {
  if (!Number.isFinite(energyWh) || !Number.isFinite(pricePerKwhPaise)) return 0;

  // Negative energy is impossible for a cumulative meter; Module 7 already clamps it. Clamping
  // again here means this function cannot produce a negative charge no matter who calls it.
  if (energyWh <= 0 || pricePerKwhPaise <= 0) return 0;

  return Math.round((energyWh * pricePerKwhPaise) / WH_PER_KWH);
}

/**
 * Rupees as typed by a human -> paise.
 *
 * Used at ONE boundary: validating a tariff rate submitted from a form. `Math.round` closes the
 * float hole in the input itself — `12.34 * 100` is `1233.9999999999998`, which `Math.trunc`
 * would silently turn into ₹12.33.
 */
export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * PAISE_PER_RUPEE);
}

/** Paise -> rupees, for display only. Never feed the result back into a calculation. */
export function paiseToRupees(paise: number): number {
  return paise / PAISE_PER_RUPEE;
}

/** "₹30.00". Always two decimal places, so a price never renders as "₹30". */
export function formatPaise(paise: number): string {
  return `₹${(paise / PAISE_PER_RUPEE).toFixed(2)}`;
}
