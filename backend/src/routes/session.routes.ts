import { Router } from 'express';

import {
  getActiveSession,
  getConnectorForCharging,
  getSessionById,
  listSessionReadings,
  listSessions,
  startSession,
  stopSession,
} from '../controllers/chargingSession.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { authorize } from '../middlewares/role.middleware';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate.middleware';
import { ROLES } from '../constants/roles';
import {
  connectorIdParamSchema,
  listSessionsQuerySchema,
  readingsQuerySchema,
  sessionIdParamSchema,
  startSessionSchema,
} from '../validators/session.validator';

const router = Router();

/*
 * Mounted at /charging.
 *
 * TWO THINGS ARE DIFFERENT HERE FROM EVERY PREVIOUS MODULE.
 *
 * 1. `driver` finally has write access. Modules 2-6 gave drivers nothing but their own profile
 *    and vehicles, because there was nothing operational for them to do yet. Starting a charge
 *    is the whole reason the platform exists, so this is where that changes.
 *
 * 2. `requireActiveCompany` is ABSENT from the driver routes, and that is deliberate rather
 *    than an oversight. A driver belongs to no company; public charging is public. Applying
 *    the middleware would reject every driver before the handler ran. Company scoping still
 *    happens for staff — it is applied inside the service, where the role decides whether the
 *    caller is scoped by company or by ownership.
 *
 * There is no DELETE, consistent with the rest of the project — and here it is not even a
 * judgement call: a charging session is a financial record that Modules 9, 10 and 13 will read.
 */
router.use(authenticate);

const STAFF_ROLES = [ROLES.SUPER_ADMIN, ROLES.CPO_ADMIN, ROLES.OPERATOR] as const;
const ALL_ROLES = [...STAFF_ROLES, ROLES.DRIVER] as const;

/* ------------------------------- discovery -------------------------------- */

/**
 * What the QR code on a physical plug resolves to.
 *
 * One connector by id — NOT a search, and not a map. Module 14 owns discovery; this answers
 * the single question a driver standing at a charger has: "can I start here, and with what?"
 */
router.get(
  '/connectors/:connectorId',
  authorize(...ALL_ROLES),
  validateParams(connectorIdParamSchema),
  getConnectorForCharging,
);

/* -------------------------------- sessions -------------------------------- */

/**
 * Start a charge. DRIVER ONLY, and deliberately so.
 *
 * Staff are not permitted to start a session on a driver's behalf. A session carries a
 * `userId` that Module 10 will bill, so an admin-initiated charge would mean one person
 * spending another person's money. If staff need to test hardware, they use a driver account —
 * which produces an honest record of who actually charged.
 */
router.post('/sessions', authorize(ROLES.DRIVER), validateBody(startSessionSchema), startSession);

/** The driver's own open session. Drivers only — staff use the list with `?active=true`. */
router.get('/sessions/active', authorize(ROLES.DRIVER), getActiveSession);

router.get(
  '/sessions',
  authorize(...ALL_ROLES),
  validateQuery(listSessionsQuerySchema),
  listSessions,
);

/*
 * Declared AFTER /sessions/active so the literal path is matched first. Express matches in
 * declaration order, and `:sessionId` would otherwise swallow "active" and fail validation.
 */
router.get(
  '/sessions/:sessionId',
  authorize(...ALL_ROLES),
  validateParams(sessionIdParamSchema),
  getSessionById,
);

router.get(
  '/sessions/:sessionId/readings',
  authorize(...ALL_ROLES),
  validateParams(sessionIdParamSchema),
  validateQuery(readingsQuerySchema),
  listSessionReadings,
);

/**
 * Stop a charge — one endpoint, two audiences.
 *
 * A driver stops their own session; an operator or CPO admin force-stops one at their own
 * station. This is what replaced Module 6's raw `POST /chargers/:id/commands/remote-stop`: the
 * same physical effect, but session-aware, so the record cannot drift from reality.
 */
router.post(
  '/sessions/:sessionId/stop',
  authorize(...ALL_ROLES),
  validateParams(sessionIdParamSchema),
  stopSession,
);

export default router;
