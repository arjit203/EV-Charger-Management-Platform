/**
 * Connector constants.
 *
 * A connector is the physical plug a car connects to. One charger can have several, each
 * with its own type, power rating and status — which is why a connector is a separate
 * record and not a field on the charger.
 *
 * CONNECTOR_TYPES is shared with the driver's Vehicle (Module 3) on purpose: Module 7 must
 * be able to answer "does this car fit this plug", and that only works if both sides use the
 * same enum. `constants/vehicle.ts` re-exports from here.
 *
 *   CCS2      Combined Charging System Type 2 — DC fast charging, most cars in India/EU
 *   CHAdeMO   Older Japanese DC standard (Nissan Leaf and similar)
 *   Type2     AC charging (Mennekes) — home, destination and two-wheelers
 *   GBT       GB/T — the Chinese standard, on some models sold in India
 */

export const CONNECTOR_TYPES = ['CCS2', 'CHAdeMO', 'Type2', 'GBT'] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

/**
 * Connector status.
 *
 * Static, admin-entered data in this module. From Module 6 the OCPP gateway drives these
 * from real `StatusNotification` messages sent by the hardware, per connector.
 *
 * Deliberately lowercase, not OCPP's PascalCase (`Available`, `Preparing`, `Charging`…).
 * Protocol values should not leak into the domain model — translating them is exactly the
 * gateway's job. Module 6 will additively extend this list with the states real hardware
 * reports, such as `preparing`, `charging` and `finishing`.
 *
 *   available    Free and ready to use
 *   occupied     A vehicle is plugged in
 *   faulted      Hardware reported a fault
 *   unavailable  Administratively out of service
 */
export const CONNECTOR_STATUSES = ['available', 'occupied', 'faulted', 'unavailable'] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];
