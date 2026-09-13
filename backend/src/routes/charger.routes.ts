import { Router } from 'express';

import {
  createCharger,
  getChargerById,
  listChargers,
  regenerateChargerToken,
  updateCharger,
  updateChargerStatus,
} from '../controllers/charger.controller';
import { getConnectionState } from '../controllers/chargerCommand.controller';
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

/* --------------------- OCPP diagnostics (Modules 6 + 7) -------------------- */
/*
 * RETIRED IN MODULE 7: `POST /:chargerId/commands/remote-start` and `.../remote-stop`.
 *
 * Those were the Module 6 test surface, and leaving them alive alongside Module 7 would have
 * been a real defect, not untidiness. An admin hitting the raw remote-start would have made a
 * charger deliver power with NO ChargingSession describing it — energy flowing that the
 * platform could not bill, show the driver, or explain afterwards.
 *
 * The low-level `sendRemoteStart` / `sendRemoteStop` in `ocpp/commands.ts` still exist, but
 * their only caller is now `chargingSession.service.ts`. Starting is driver-initiated at
 * `POST /charging/sessions`; the operator's force-stop is `POST /charging/sessions/:id/stop`,
 * which is session-aware and therefore cannot leave the record and the hardware disagreeing.
 *
 * What stays below is READ-ONLY diagnostics. It changes nothing, so it cannot create a
 * phantom session.
 */

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
