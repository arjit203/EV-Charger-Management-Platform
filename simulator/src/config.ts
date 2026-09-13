/**
 * Simulator configuration.
 *
 * Nothing about a specific charger is hardcoded: identity and credentials come from CLI
 * arguments or environment variables, so the same process can stand in for any registered
 * charger. That is what makes it possible to run several at once:
 *
 *   npm run dev -- --charger=LIV-DEL-CP-01-A --token=<token>
 *   npm run dev -- --charger=LIV-DEL-CP-01-B --token=<token>
 */

import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

/** Read `--key=value` from argv, then an env var, then a default. */
function arg(key: string, envKey: string, fallback?: string): string | undefined {
  const match = process.argv.find((a) => a.startsWith(`--${key}=`));
  if (match) return match.slice(key.length + 3);
  return process.env[envKey]?.trim() || fallback;
}

const ocppId = arg('charger', 'CHARGER_OCPP_ID');
const authToken = arg('token', 'CHARGER_AUTH_TOKEN');

if (!ocppId || !authToken) {
  console.error(
    [
      '',
      'Missing charger identity or token.',
      '',
      'Usage:',
      '  npm run dev -- --charger=<ocppId> --token=<authToken>',
      '',
      'Or set CHARGER_OCPP_ID and CHARGER_AUTH_TOKEN in simulator/.env',
      '',
      'The token is shown ONCE when the charger is created in the admin UI.',
      'If you no longer have it, regenerate: POST /api/v1/chargers/:id/token',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

export const config = {
  ocppId,
  authToken,

  /** Backend OCPP endpoint. The charger identity goes in the path, as real OCPP 1.6J does. */
  gatewayUrl: arg('url', 'OCPP_GATEWAY_URL', 'ws://localhost:5000/ocpp') as string,

  /** Connector this charger will use for a simulated session. */
  connectorNumber: Number(arg('connector', 'CHARGER_CONNECTOR', '1')),

  /** How often meter values are emitted while charging. */
  meterIntervalSeconds: Number(arg('meterInterval', 'METER_INTERVAL_SECONDS', '5')),

  /** Fallback power rating if the backend does not supply one at boot. */
  fallbackPowerKw: Number(arg('powerKw', 'CHARGER_POWER_KW', '60')),

  /** Delay before attempting to reconnect after a dropped connection. */
  reconnectDelaySeconds: Number(arg('reconnectDelay', 'RECONNECT_DELAY_SECONDS', '5')),
} as const;
