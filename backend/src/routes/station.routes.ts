import { Router } from 'express';

import {
  createStation,
  getStationById,
  listPublicStations,
  listStations,
  listStationsForMap,
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
  mapStationsQuerySchema,
  publicStationsQuerySchema,
  stationIdParamSchema,
  stationStatusSchema,
  updateStationSchema,
} from '../validators/station.validator';

const router = Router();

/*
 * Every route here requires authentication, and `driver` is absent from all of them —
 * administrative station management is not a driver capability.
 *
 * MODULE 14 RESOLVED THE DEFERRAL RECORDED HERE. Module 4 left out a driver-facing station
 * endpoint because "a station with no chargers, connectors or availability data is not
 * useful to a driver", and deferred it to Module 5 or 14, whichever needed it first.
 * Module 5 supplied the connectors and Module 6 gave them live status, so the missing
 * information now exists and `GET /stations/public` is built below.
 *
 * Everything else in this file is unchanged: `driver` is still absent from every
 * ADMINISTRATIVE station route, and that remains tested.
 *
 * `requireActiveCompany` means staff of a suspended company cannot manage stations either;
 * super_admin bypasses it, having no company of their own.
 */
router.use(authenticate);

/* -------------------------------------------------------------------------- */
/* Module 14 — map reads                                                      */
/*                                                                            */
/* THESE TWO MUST BE DECLARED BEFORE `/:stationId`.                           */
/*                                                                            */
/* Express matches in declaration order, so a later `/:stationId` would        */
/* capture "map" and "public" as ids. It would not 404 either — the param      */
/* validator requires 24 hex characters, so the caller would get a baffling    */
/* 400 "Invalid request parameters" for a route that plainly exists.           */
/* -------------------------------------------------------------------------- */

/**
 * GET /stations/map — staff markers, company-scoped.
 *
 * Same three roles and the same `requireActiveCompany` gate as the admin list: this is the
 * administrative map, and staff of a suspended company do not get one.
 */
router.get(
  '/map',
  authorize(ROLES.SUPER_ADMIN, ROLES.CPO_ADMIN, ROLES.OPERATOR),
  requireActiveCompany,
  validateQuery(mapStationsQuerySchema),
  listStationsForMap,
);

/**
 * GET /stations/public — driver discovery. Active stations of active companies.
 *
 * NO `authorize(...)`: every role may look for somewhere to charge, so a role list here
 * would be noise — the same reasoning as Module 12's notification routes.
 *
 * NO `requireActiveCompany`, and that is NOT an oversight. That middleware calls
 * `resolveCompanyScope`, which THROWS 403 for any company-scoped account without a company.
 * A driver has no `companyId` by design, so adding it out of habit would 403 the exact role
 * this endpoint exists for.
 *
 * "Public" describes the CONTENT, not the access. It still requires a valid token: this app
 * has no logged-out screen that shows data, and the project has no rate limiting yet, so an
 * unauthenticated endpoint would be new attack surface with no consumer. Opening it later is
 * a one-line change.
 */
router.get(
  '/public',
  validateQuery(publicStationsQuerySchema),
  listPublicStations,
);

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
