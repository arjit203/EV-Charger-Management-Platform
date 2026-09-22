/**
 * Charger constants.
 *
 * A charger (EVSE — Electric Vehicle Supply Equipment) is the physical machine installed at
 * a station. It is not the plug: that is a Connector.
 */

/**
 * AC chargers pass mains power to the car's own onboard charger — slow, cheap hardware.
 * DC chargers convert the power themselves and feed the battery directly — fast, expensive.
 * That single distinction drives most of the cost and speed difference in the industry.
 */
export const CHARGER_TYPES = ['AC', 'DC'] as const;
export type ChargerType = (typeof CHARGER_TYPES)[number];

/**
 * Charger status — ADMINISTRATIVE, and only ever written by a human.
 *
 * The note below said Module 6 would drive this from OCPP events. It does NOT, and that
 * reversal is deliberate: see `CHARGER_HARDWARE_STATUSES`. What a person decided about a
 * machine and what the machine reports about itself are different facts, and the moment they
 * share one field, one of them has to be destroyed on every write.
 *
 * IMPORTANT: charger status and connector status are fully INDEPENDENT — setting a charger
 * to `maintenance` deliberately does NOT cascade to its connectors. Real OCPP status arrives
 * per connector from the hardware, so inventing cascade rules would mean writing business
 * logic that fights the real data.
 *
 *   available    In service
 *   unavailable  Administratively out of service
 *   faulted      A human recorded a fault (hardware-reported faults go to hardwareStatus)
 *   maintenance  Planned servicing
 */
export const CHARGER_STATUSES = ['available', 'unavailable', 'faulted', 'maintenance'] as const;
export type ChargerStatus = (typeof CHARGER_STATUSES)[number];

/**
 * Charger HARDWARE status — the machine's report about ITSELF, written only by the gateway.
 *
 * THE GAP THIS CLOSES. OCPP 1.6 addresses the charge point as a whole with `connectorId: 0`:
 * a `StatusNotification { connectorId: 0, status: "Faulted" }` means "the machine is broken",
 * not "plug 0 is broken" — there is no plug 0. The gateway used to look that up as a
 * connector, find nothing (connectorNumber starts at 1), log "unknown connector 0" and drop
 * it. A charger could therefore announce its own failure and still be offered to drivers,
 * with every connector still reading `available`.
 *
 * WHY A FOURTH FIELD AND NOT `status`. Making the gateway write `status` looks simpler and is
 * not: it needs precedence rules ("may a fault clear an admin's maintenance? may an admin's
 * available clear a live fault?"), and whichever way those rules fall, one of the two facts is
 * lost. Two fields cost one extra condition in `assessStartability` and keep both facts
 * intact — an operator can see "I marked this for maintenance AND it is reporting a fault",
 * which is a real and common situation.
 *
 *   operative    The machine reports itself healthy (or has never said otherwise)
 *   faulted      The charge point itself reported a fault — connectorId 0, status Faulted
 *   unavailable  The charge point took ITSELF out of service — connectorId 0, Unavailable
 */
export const CHARGER_HARDWARE_STATUSES = ['operative', 'faulted', 'unavailable'] as const;
export type ChargerHardwareStatus = (typeof CHARGER_HARDWARE_STATUSES)[number];

/**
 * OCPP 1.6 charge-point-level status -> our hardware status.
 *
 * Only three values are meaningful for the MACHINE. `Charging`, `Preparing` and `Finishing`
 * describe a plug with a car attached and cannot apply to connectorId 0; a charger that sends
 * one is ignored rather than mapped, because inventing a meaning for it would put a fiction
 * in the database.
 */
export const CHARGE_POINT_STATUS_MAP: Record<string, ChargerHardwareStatus> = {
  Available: 'operative',
  Faulted: 'faulted',
  Unavailable: 'unavailable',
};
