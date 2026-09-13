/**
 * Vehicle constants.
 *
 * Connector types are the physical plug standards an EV supports. This matters beyond
 * record-keeping: from Module 5 a charger's connectors carry the same values, and a driver
 * can only charge where their vehicle's plug matches.
 *
 *   CCS2      Combined Charging System Type 2 — the DC fast-charge standard for most cars in India/EU
 *   CHAdeMO   Older Japanese DC standard (Nissan Leaf and similar)
 *   Type2     AC charging (Mennekes). Common for home/destination charging and two-wheelers
 *   GBT       GB/T — the Chinese standard, present on some models sold in India
 */

export const CONNECTOR_TYPES = ['CCS2', 'CHAdeMO', 'Type2', 'GBT'] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];
