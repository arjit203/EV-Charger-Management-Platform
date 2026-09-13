/**
 * Vehicle constants.
 *
 * Connector types moved to `constants/connector.ts` in Module 5 and are re-exported here so
 * existing imports keep working. They are shared deliberately: a vehicle's plug and a
 * charger's connector must use the same enum, or Module 7 cannot answer "does this car fit
 * this connector".
 */

export { CONNECTOR_TYPES, type ConnectorType } from './connector';
