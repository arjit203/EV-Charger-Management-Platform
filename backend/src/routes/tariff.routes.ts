import { Router } from 'express';

import {
  createTariff,
  getTariffById,
  listTariffs,
  setTariffStatus,
  updateTariff,
} from '../controllers/tariff.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { authorize } from '../middlewares/role.middleware';
import { requireActiveCompany } from '../middlewares/companyScope.middleware';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate.middleware';
import { ROLES } from '../constants/roles';
import {
  createTariffSchema,
  listTariffsQuerySchema,
  tariffIdParamSchema,
  tariffStatusSchema,
  updateTariffSchema,
} from '../validators/tariff.validator';

const router = Router();

/*
 * Mounted at /tariffs.
 *
 * `driver` is absent from every route, and that is not an oversight — a driver never needs the
 * tariff LIST. The one thing they need is the rate at the plug in front of them, and
 * `GET /charging/connectors/:connectorId` already answers that. A second endpoint returning the
 * same number would be duplicate surface.
 *
 * `operator` is READ-ONLY, full stop. Same position as Modules 3 and 5: they run the hardware,
 * they do not set prices. Their single write in this project remains the Module 7 force-stop.
 *
 * No DELETE. A tariff is quoted by every session priced under it, so taking one out of service
 * is a status change.
 */
router.use(authenticate);

const READ_ROLES = [ROLES.SUPER_ADMIN, ROLES.CPO_ADMIN, ROLES.OPERATOR] as const;
const WRITE_ROLES = [ROLES.SUPER_ADMIN, ROLES.CPO_ADMIN] as const;

router.get(
  '/',
  authorize(...READ_ROLES),
  requireActiveCompany,
  validateQuery(listTariffsQuerySchema),
  listTariffs,
);

router.post(
  '/',
  authorize(...WRITE_ROLES),
  requireActiveCompany,
  validateBody(createTariffSchema),
  createTariff,
);

router.get(
  '/:tariffId',
  authorize(...READ_ROLES),
  requireActiveCompany,
  validateParams(tariffIdParamSchema),
  getTariffById,
);

router.patch(
  '/:tariffId',
  authorize(...WRITE_ROLES),
  requireActiveCompany,
  validateParams(tariffIdParamSchema),
  validateBody(updateTariffSchema),
  updateTariff,
);

/**
 * Status is separate from edit because activating is not an edit — it deactivates whichever
 * tariff is currently in force and changes what every subsequent charge costs.
 */
router.patch(
  '/:tariffId/status',
  authorize(...WRITE_ROLES),
  requireActiveCompany,
  validateParams(tariffIdParamSchema),
  validateBody(tariffStatusSchema),
  setTariffStatus,
);

export default router;
