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
console.log('  keys       : f = connector fault, m = machine fault, c = clear faults');
console.log('');

charger.start();

/*
 * FAULT INJECTION, typed at the terminal.
 *
 * The two faults are separate keys because they are separate scenarios, and the whole point is
 * that a CPMS must tell them apart:
 *
 *   f   the PLUG faults        -> StatusNotification on connectorId 1, charger stays healthy
 *   m   the MACHINE faults     -> StatusNotification on connectorId 0, plugs stay `Available`
 *   c   an engineer fixed it   -> healthy again at both levels
 *
 * Line mode, not raw mode: raw mode would swallow Ctrl+C, and a simulator you cannot stop is
 * worse than one that needs an Enter key.
 */
if (process.stdin.isTTY) {
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (chunk: string) => {
    const key = chunk.trim().toLowerCase();

    if (key === 'f') void charger.faultConnector();
    else if (key === 'm') void charger.faultChargePoint();
    else if (key === 'c') void charger.clearFaults();
    else if (key.length > 0) console.log('  unknown key — f, m or c');
  });
}

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
