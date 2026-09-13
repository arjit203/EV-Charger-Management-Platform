import { Router } from 'express';

import {
  createStation,
  getStationById,
  listStations,
  updateStation,
  updateStationStatus,
} from '../controllers/station.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { authorize } from '../middlewares/role.middleware';
import { requireActiveCompany } from '../middlewares/companyScope.middleware';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate.middleware';
import { ROLES } from '../constants/roles';
import {
  createStationSchema,
  listStationsQuerySchema,
  stationIdParamSchema,
  stationStatusSchema,
  updateStationSchema,
} from '../validators/station.validator';

const router = Router();

/*
 * Every route here requires authentication, and `driver` is absent from all of them —
 * administrative station management is not a driver capability.
 *
 * There is deliberately NO public/driver-facing station endpoint in this module. A station
 * with no chargers, connectors or availability data is not useful to a driver, and building
 * that read now would guarantee rebuilding it once Module 5 exists to make it meaningful.
 * It belongs to Module 5 or 14, whichever needs it first.
 *
 * `requireActiveCompany` means staff of a suspended company cannot manage stations either;
 * super_admin bypasses it, having no company of their own.
 */
router.use(authenticate);

/**
 * Read access for all three admin roles. `operator` is READ-ONLY in this module: a station
 * is an administrative record (address, coordinates, hours), and operators operate chargers,
 * which arrive in Module 5. Giving them write access now would be speculative.
 */
router.get(
  '/',
  authorize(ROLES.SUPER_ADMIN, ROLES.CPO_ADMIN, ROLES.OPERATOR),
  requireActiveCompany,
  validateQuery(listStationsQuerySchema),
  listStations,
);

router.get(
  '/:stationId',
  authorize(ROLES.SUPER_ADMIN, ROLES.CPO_ADMIN, ROLES.OPERATOR),
  requireActiveCompany,
  validateParams(stationIdParamSchema),
  getStationById,
);

/* ---- Write access: super_admin and cpo_admin only ---- */

router.post(
  '/',
  authorize(ROLES.SUPER_ADMIN, ROLES.CPO_ADMIN),
  requireActiveCompany,
  validateBody(createStationSchema),
  createStation,
);

router.patch(
  '/:stationId',
  authorize(ROLES.SUPER_ADMIN, ROLES.CPO_ADMIN),
  requireActiveCompany,
  validateParams(stationIdParamSchema),
  validateBody(updateStationSchema),
  updateStation,
);

/**
 * Status has its own endpoint so a stale field on an edit form can never take a station
 * offline. Setting or clearing `suspended` is restricted to super_admin inside the service.
 */
router.patch(
  '/:stationId/status',
  authorize(ROLES.SUPER_ADMIN, ROLES.CPO_ADMIN),
  requireActiveCompany,
  validateParams(stationIdParamSchema),
  validateBody(stationStatusSchema),
  updateStationStatus,
);

export default router;
