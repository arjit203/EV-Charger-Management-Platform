import { Router } from 'express';

import {
  getOverview,
  getRevenueSeries,
  getSessionSeries,
  getTopStations,
} from '../controllers/analytics.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { authorize } from '../middlewares/role.middleware';
import { requireActiveCompany } from '../middlewares/companyScope.middleware';
import { validateQuery } from '../middlewares/validate.middleware';
import { ROLES } from '../constants/roles';
import {
  analyticsRangeQuerySchema,
  topStationsQuerySchema,
} from '../validators/analytics.validator';

const router = Router();

/*
 * Mounted at /analytics. Staff only — four endpoints, no writes, no `:id`.
 *
 * WHY `driver` IS ABSENT ENTIRELY.
 * A driver's "analytics" would be their own charging history, and `GET /charging/sessions`
 * has returned exactly that, owner-scoped, since Module 7. A second endpoint answering a
 * question already answered is surface without a feature, and it would need its own scoping
 * rules — the one thing this project has kept to a single mechanism per resource.
 *
 * WHY `operator` IS NARROWER THAN `cpo_admin`.
 * An operator runs hardware: they need sessions, energy, fleet status and complaints. A
 * company's INCOME is not operational data, so `/analytics/revenue` is the one route they
 * cannot reach. The restriction is not cosmetic — the overview omits the `revenue` key for
 * them and never runs the query, and the station leaderboard drops the revenue columns AND
 * re-sorts by energy, because sorting by a hidden column leaks the ranking it hides.
 *
 * `requireActiveCompany` on every route, as everywhere since Module 2: a suspended company's
 * staff keep a valid token for up to seven days, and reporting is not an exception.
 */
router.use(authenticate);

const STAFF_ROLES = [ROLES.SUPER_ADMIN, ROLES.CPO_ADMIN, ROLES.OPERATOR] as const;
const REVENUE_ROLES = [ROLES.SUPER_ADMIN, ROLES.CPO_ADMIN] as const;

router.get(
  '/overview',
  authorize(...STAFF_ROLES),
  requireActiveCompany,
  validateQuery(analyticsRangeQuerySchema),
  getOverview,
);

router.get(
  '/sessions',
  authorize(...STAFF_ROLES),
  requireActiveCompany,
  validateQuery(analyticsRangeQuerySchema),
  getSessionSeries,
);

/** The one route an operator cannot reach. See the note above. */
router.get(
  '/revenue',
  authorize(...REVENUE_ROLES),
  requireActiveCompany,
  validateQuery(analyticsRangeQuerySchema),
  getRevenueSeries,
);

router.get(
  '/stations',
  authorize(...STAFF_ROLES),
  requireActiveCompany,
  validateQuery(topStationsQuerySchema),
  getTopStations,
);

export default router;
