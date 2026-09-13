/**
 * Tariff constants.
 *
 * A TARIFF is a price sheet: what this company charges a driver for electricity. In this MVP
 * it is one number — paise per kilowatt-hour — because that is how public EV charging is
 * overwhelmingly priced in India, and because a pricing engine with no consumer is the kind of
 * speculative complexity this project has declined since Module 4.
 */

export const TARIFF_STATUSES = [
  /** In force. AT MOST ONE per company — enforced by a partial unique index, not by an `if`. */
  'active',
  /** Kept for history and for sessions that quote it, but not used for new charges. */
  'inactive',
] as const;

export type TariffStatus = (typeof TARIFF_STATUSES)[number];

/**
 * Rate bounds, in paise per kWh.
 *
 * ₹0.01 to ₹1000 per kWh. Wide enough to be uncontroversial, narrow enough that a fat-fingered
 * ₹120000/kWh is rejected before it can be applied to a real charge. Indian public DC charging
 * sits around ₹12-24/kWh, so both ends are far outside anything legitimate.
 */
export const MIN_PRICE_PER_KWH_PAISE = 1;
export const MAX_PRICE_PER_KWH_PAISE = 100_000;
