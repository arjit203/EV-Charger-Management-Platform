/*
 * The REAL simulator, driven over stdin instead of a TTY — so a script can press its keys.
 * Same class, same OCPP code paths as `simulator/src/index.ts`; only the key source differs.
 *
 *   node simulator/node_modules/tsx/dist/cli.mjs tests/e2e/sim-keys.ts --charger=.. --token=..
 *   stdin lines: f = connector fault, m = charge-point fault, c = clear faults, q = quit
 */
import { SimulatedCharger } from '../../simulator/src/charger';

const charger = new SimulatedCharger();
charger.start();

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  for (const key of chunk.split(/\s+/).filter(Boolean)) {
    if (key === 'f') void charger.faultConnector();
    else if (key === 'm') void charger.faultChargePoint();
    else if (key === 'c') void charger.clearFaults();
    else if (key === 'q') void charger.stop().then(() => process.exit(0));
  }
});
