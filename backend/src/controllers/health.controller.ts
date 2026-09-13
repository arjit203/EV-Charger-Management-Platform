/**
 * Health check — the only endpoint in Module 0.
 *
 * It exists to prove the whole vertical slice is real: the process is up, the
 * environment loaded, and the MongoDB connection state is reported honestly rather
 * than hardcoded. Later it doubles as the readiness probe for deployment (Module 17).
 */

import type { Request, Response } from 'express';
import { getDatabaseStatus } from '../config/db';
import { env } from '../config/env';
import { sendSuccess } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';

export const getHealth = asyncHandler(async (_req: Request, res: Response) => {
  const database = getDatabaseStatus();

  // "ok" only when the database is genuinely usable; anything else is "degraded",
  // which is also why the HTTP status drops to 503 — a monitoring tool (or the
  // frontend) should be able to tell something is wrong without parsing prose.
  const isHealthy = database.state === 'connected';

  const payload = {
    status: isHealthy ? ('ok' as const) : ('degraded' as const),
    service: 'ev-cms-backend',
    environment: env.nodeEnv,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    database,
  };

  sendSuccess(
    res,
    payload,
    isHealthy ? 'EV-CMS backend is healthy' : 'EV-CMS backend is running, but the database is not connected',
    isHealthy ? 200 : 503,
  );
});
