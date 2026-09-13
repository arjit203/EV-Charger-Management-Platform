import { Router } from 'express';

import {
  createCharger,
  getChargerById,
  listChargers,
  updateCharger,
  updateChargerStatus,
} from '../controllers/charger.controller';
import {
  createConnector,
  getConnector,
  listConnectors,
  updateConnector,
  updateConnectorStatus,
} from '../controllers/connector.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { authorize } from '../middlewares/role.middleware';
import { requireActiveCompany } from '../middlewares/companyScope.middleware';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate.middleware';
import { ROLES } from '../constants/roles';
import {
  chargerIdParamSchema,
  chargerStatusSchema,
  createChargerSchema,
  listChargersQuerySchema,
  updateChargerSchema,
} from '../validators/charger.validator';
import {
  connectorParamsSchema,
  connectorStatusSchema,
  createConnectorSchema,
  listConnectorsQuerySchema,
  updateConnectorSchema,
} from '../validators/connector.validator';

const router = Router();

/*
 * Connectors are nested under their charger rather than living at /connectors. That is not
 * cosmetic: the nested shape means the parent charger is resolved through the caller's
 * company scope on EVERY connector operation, so the Company -> Station -> Charger chain is
 * verified before a connector is ever touched.
 *
 * `driver` is absent from every route. There is no DELETE anywhere: chargers will own
 * sessions and revenue from Module 7, and connectors are referenced by every session, so
 * taking hardware out of service is a status change, not a deletion.
 */
router.use(authenticate);

const READ_ROLES = [ROLES.SUPER_ADMIN, ROLES.CPO_ADMIN, ROLES.OPERATOR] as const;
const WRITE_ROLES = [ROLES.SUPER_ADMIN, ROLES.CPO_ADMIN] as const;

/* ------------------------------- connectors ------------------------------- */
/* Declared before the charger routes below only for readability — the paths do not
   overlap, since every connector path has extra segments. */

router.get(
  '/:chargerId/connectors',
  authorize(...READ_ROLES),
  requireActiveCompany,
  validateParams(chargerIdParamSchema),
  validateQuery(listConnectorsQuerySchema),
  listConnectors,
);

router.post(
  '/:chargerId/connectors',
  authorize(...WRITE_ROLES),
  requireActiveCompany,
  validateParams(chargerIdParamSchema),
  validateBody(createConnectorSchema),
  createConnector,
);

router.get(
  '/:chargerId/connectors/:connectorId',
  authorize(...READ_ROLES),
  requireActiveCompany,
  validateParams(connectorParamsSchema),
  getConnector,
);

router.patch(
  '/:chargerId/connectors/:connectorId',
  authorize(...WRITE_ROLES),
  requireActiveCompany,
  validateParams(connectorParamsSchema),
  validateBody(updateConnectorSchema),
  updateConnector,
);

router.patch(
  '/:chargerId/connectors/:connectorId/status',
  authorize(...WRITE_ROLES),
  requireActiveCompany,
  validateParams(connectorParamsSchema),
  validateBody(connectorStatusSchema),
  updateConnectorStatus,
);

/* -------------------------------- chargers -------------------------------- */

/**
 * `operator` is READ-ONLY throughout, consistent with Modules 3 and 4. There is no charger
 * *operation* to perform yet — remote commands arrive in Module 6 and monitoring in Module 8,
 * and that is where a real write need would first appear.
 */
router.get(
  '/',
  authorize(...READ_ROLES),
  requireActiveCompany,
  validateQuery(listChargersQuerySchema),
  listChargers,
);

router.post(
  '/',
  authorize(...WRITE_ROLES),
  requireActiveCompany,
  validateBody(createChargerSchema),
  createCharger,
);

router.get(
  '/:chargerId',
  authorize(...READ_ROLES),
  requireActiveCompany,
  validateParams(chargerIdParamSchema),
  getChargerById,
);

router.patch(
  '/:chargerId',
  authorize(...WRITE_ROLES),
  requireActiveCompany,
  validateParams(chargerIdParamSchema),
  validateBody(updateChargerSchema),
  updateCharger,
);

router.patch(
  '/:chargerId/status',
  authorize(...WRITE_ROLES),
  requireActiveCompany,
  validateParams(chargerIdParamSchema),
  validateBody(chargerStatusSchema),
  updateChargerStatus,
);

export default router;
