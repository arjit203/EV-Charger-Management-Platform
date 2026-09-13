import { Router } from 'express';

import {
  createCompany,
  getCompanyById,
  getMyCompany,
  listCompanies,
  updateCompany,
  updateCompanyStatus,
} from '../controllers/company.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { authorize } from '../middlewares/role.middleware';
import { requireActiveCompany } from '../middlewares/companyScope.middleware';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate.middleware';
import { ROLES } from '../constants/roles';
import {
  companyIdParamSchema,
  companyStatusSchema,
  createCompanySchema,
  listCompaniesQuerySchema,
  updateCompanySchema,
} from '../validators/company.validator';

const router = Router();

// Everything in this module requires a logged-in user.
router.use(authenticate);

/**
 * ORDER MATTERS: `/me` must be declared before `/:companyId`.
 *
 * Express matches routes top to bottom, so if `/:companyId` came first it would capture
 * the literal string "me" as a company id and answer with a 400 for a malformed ObjectId.
 */
router.get(
  '/me',
  authorize(ROLES.CPO_ADMIN, ROLES.OPERATOR),
  requireActiveCompany,
  getMyCompany,
);

/** Platform-wide: only super_admin may create or list every company. */
router.post('/', authorize(ROLES.SUPER_ADMIN), validateBody(createCompanySchema), createCompany);

router.get(
  '/',
  authorize(ROLES.SUPER_ADMIN),
  validateQuery(listCompaniesQuerySchema),
  listCompanies,
);

/**
 * Readable by super_admin (any company) and by company-scoped roles (their own only).
 * The service performs the scoped query; this is also the negative-test path where
 * cpo_admin_A hitting company B must receive 403.
 */
router.get(
  '/:companyId',
  authorize(ROLES.SUPER_ADMIN, ROLES.CPO_ADMIN, ROLES.OPERATOR),
  validateParams(companyIdParamSchema),
  requireActiveCompany,
  getCompanyById,
);

router.patch(
  '/:companyId',
  authorize(ROLES.SUPER_ADMIN),
  validateParams(companyIdParamSchema),
  validateBody(updateCompanySchema),
  updateCompany,
);

/** Status is its own endpoint so suspension is never a side effect of an edit form. */
router.patch(
  '/:companyId/status',
  authorize(ROLES.SUPER_ADMIN),
  validateParams(companyIdParamSchema),
  validateBody(companyStatusSchema),
  updateCompanyStatus,
);

/*
 * REMOVED IN MODULE 3: `POST /companies/:companyId/users`.
 *
 * That route was an explicit Module 2 stopgap — the only way to create company staff before
 * a user-management module existed. It is superseded by `POST /api/v1/users`, which is now
 * the single path for creating a cpo_admin/operator.
 *
 * Two endpoints doing the same job is how a rule added later (an audit entry, a rate limit,
 * an extra check) gets applied to one path and silently missed on the other, so it was
 * retired rather than left running in parallel.
 */

export default router;
