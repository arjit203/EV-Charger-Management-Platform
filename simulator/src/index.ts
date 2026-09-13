/**
 * Simulated charge point — entry point.
 *
 * This is the third process in the local development setup:
 *
 *   Terminal 1   backend/    npm run dev     Express + OCPP gateway
 *   Terminal 2   frontend/   npm run dev     Next.js
 *   Terminal 3   simulator/  npm run dev     THIS — stands in for physical hardware
 *
 * It exists because the project has no physical chargers, and buying one to build a CPMS is
 * not realistic. From the backend's perspective this process is indistinguishable from a real
 * charger, which means every later module — sessions, billing, analytics — can be built and
 * demonstrated against data this generates.
 */

import { config } from './config';
import { SimulatedCharger } from './charger';

const charger = new SimulatedCharger();

console.log('');
console.log('  EV-CMS simulated charge point');
console.log(`  identity   : ${config.ocppId}`);
console.log(`  gateway    : ${config.gatewayUrl}`);
console.log(`  connector  : ${config.connectorNumber}`);
console.log(`  meter tick : every ${config.meterIntervalSeconds}s`);
console.log('');

charger.start();

/** Stop cleanly so an in-flight transaction is closed rather than abandoned. */
async function shutdown(signal: string): Promise<void> {
  console.log(`\nReceived ${signal}. Shutting down...`);
  await charger.stop();
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection in simulator:', reason);
});
