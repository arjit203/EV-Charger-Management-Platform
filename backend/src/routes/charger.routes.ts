import { Router } from 'express';

import {
  createCharger,
  getChargerById,
  listChargers,
  regenerateChargerToken,
  updateCharger,
  updateChargerStatus,
} from '../controllers/charger.controller';
import {
  getConnectionState,
  remoteStart,
  remoteStop,
} from '../controllers/chargerCommand.controller';
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
  remoteStartSchema,
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

/* ------------------------- OCPP commands (Module 6) ------------------------ */
/*
 * These are the Module 6 TEST SURFACE for driving the gateway. Module 7 replaces them with
 * the real driver-facing start/stop, which also creates a ChargingSession, applies a tariff
 * and debits a wallet — none of which happens here.
 *
 * `operator` is included, and this is the first WRITE they have been given in the whole
 * project. Modules 3, 4 and 5 all deferred operator write access "until a concrete
 * operational trigger exists" — operating a charger is exactly that trigger, and it is
 * literally the role's job. Company scoping still applies: the service resolves the charger
 * through `assertChargerInScope`, so an operator cannot command another company's hardware.
 */

router.post(
  '/:chargerId/commands/remote-start',
  authorize(...READ_ROLES),
  requireActiveCompany,
  validateParams(chargerIdParamSchema),
  validateBody(remoteStartSchema),
  remoteStart,
);

router.post(
  '/:chargerId/commands/remote-stop',
  authorize(...READ_ROLES),
  requireActiveCompany,
  validateParams(chargerIdParamSchema),
  remoteStop,
);

/** Live gateway state — what the registry believes right now, not the database mirror. */
router.get(
  '/:chargerId/connection',
  authorize(...READ_ROLES),
  requireActiveCompany,
  validateParams(chargerIdParamSchema),
  getConnectionState,
);

/**
 * Issue a new OCPP connection token. The plaintext is returned ONCE and never again, since
 * only a bcrypt hash is stored — the same contract as an API key.
 */
router.post(
  '/:chargerId/token',
  authorize(...WRITE_ROLES),
  requireActiveCompany,
  validateParams(chargerIdParamSchema),
  regenerateChargerToken,
);

/* -------------------------------- chargers -------------------------------- */

/**
 * `operator` is read-only for CONFIGURATION — they may view chargers and connectors but not
 * create, edit or re-label them. That remains the Module 5 position.
 *
 * What changed in Module 6 is OPERATION: operators can now send remote start/stop above.
 * Configuring hardware is administration; commanding it is the operator's actual job.
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
