import { Router } from 'express';

import {
  createUser,
  getUserById,
  listUsers,
  updateMe,
  updateUser,
  updateUserStatus,
} from '../controllers/user.controller';
import {
  createMyVehicle,
  deactivateMyVehicle,
  getMyVehicle,
  listMyVehicles,
  updateMyVehicle,
} from '../controllers/vehicle.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { authorize } from '../middlewares/role.middleware';
import { requireActiveCompany } from '../middlewares/companyScope.middleware';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate.middleware';
import { ROLES } from '../constants/roles';
import {
  createUserSchema,
  listUsersQuerySchema,
  updateMeSchema,
  updateUserSchema,
  userIdParamSchema,
  userStatusSchema,
} from '../validators/user.validator';
import {
  createVehicleSchema,
  updateVehicleSchema,
  vehicleIdParamSchema,
} from '../validators/vehicle.validator';

const router = Router();

router.use(authenticate);

/* -------------------------------------------------------------------------- */
/* Self-service — declared BEFORE /:userId so the literal "me" is not captured */
/* as a user id.                                                              */
/* -------------------------------------------------------------------------- */

/** Any authenticated user may edit their own name/phone. No id in the URL to tamper with. */
router.patch('/me', validateBody(updateMeSchema), updateMe);

/**
 * Vehicles are driver-only: they belong to EV owners, and staff accounts are not EV owners
 * in this product. Every handler scopes its query to the authenticated owner.
 */
router.get('/me/vehicles', authorize(ROLES.DRIVER), listMyVehicles);

router.post(
  '/me/vehicles',
  authorize(ROLES.DRIVER),
  validateBody(createVehicleSchema),
  createMyVehicle,
);

router.get(
  '/me/vehicles/:vehicleId',
  authorize(ROLES.DRIVER),
  validateParams(vehicleIdParamSchema),
  getMyVehicle,
);

router.patch(
  '/me/vehicles/:vehicleId',
  authorize(ROLES.DRIVER),
  validateParams(vehicleIdParamSchema),
  validateBody(updateVehicleSchema),
  updateMyVehicle,
);

router.delete(
  '/me/vehicles/:vehicleId',
  authorize(ROLES.DRIVER),
  validateParams(vehicleIdParamSchema),
  deactivateMyVehicle,
);

/* -------------------------------------------------------------------------- */
/* Administrative                                                             */
/*                                                                            */
/* `operator` is deliberately absent from every route below. The justification */
/* for an operator seeing user data would be operational ("who is on my        */
/* charger?"), and no charger or session exists yet — building it now would be */
/* speculative. Revisit in Module 7.                                          */
/*                                                                            */
/* `requireActiveCompany` means a cpo_admin whose company is suspended cannot  */
/* manage users either. super_admin bypasses it.                              */
/* -------------------------------------------------------------------------- */

router.get(
  '/',
  authorize(ROLES.SUPER_ADMIN, ROLES.CPO_ADMIN),
  requireActiveCompany,
  validateQuery(listUsersQuerySchema),
  listUsers,
);

router.post(
  '/',
  authorize(ROLES.SUPER_ADMIN, ROLES.CPO_ADMIN),
  requireActiveCompany,
  validateBody(createUserSchema),
  createUser,
);

router.get(
  '/:userId',
  authorize(ROLES.SUPER_ADMIN, ROLES.CPO_ADMIN),
  requireActiveCompany,
  validateParams(userIdParamSchema),
  getUserById,
);

router.patch(
  '/:userId',
  authorize(ROLES.SUPER_ADMIN, ROLES.CPO_ADMIN),
  requireActiveCompany,
  validateParams(userIdParamSchema),
  validateBody(updateUserSchema),
  updateUser,
);

/** Status has its own endpoint so suspension is never a side effect of an edit form. */
router.patch(
  '/:userId/status',
  authorize(ROLES.SUPER_ADMIN, ROLES.CPO_ADMIN),
  requireActiveCompany,
  validateParams(userIdParamSchema),
  validateBody(userStatusSchema),
  updateUserStatus,
);

export default router;
