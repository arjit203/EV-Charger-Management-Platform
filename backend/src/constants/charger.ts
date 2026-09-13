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
 * Charger status.
 *
 * Static, admin-entered data in this module; Module 6 will drive it from OCPP events.
 *
 * IMPORTANT: charger status and connector status are fully INDEPENDENT — setting a charger
 * to `maintenance` deliberately does NOT cascade to its connectors. Real OCPP status arrives
 * per connector from the hardware, so inventing cascade rules now would mean writing business
 * logic that Module 6 has to rip out, and which could then fight the real data.
 *
 *   available    In service
 *   unavailable  Administratively out of service
 *   faulted      Hardware fault reported
 *   maintenance  Planned servicing
 */
export const CHARGER_STATUSES = ['available', 'unavailable', 'faulted', 'maintenance'] as const;
export type ChargerStatus = (typeof CHARGER_STATUSES)[number];
