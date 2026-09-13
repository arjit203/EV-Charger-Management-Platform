/**
 * Company HTTP handlers. Thin: read the request, call a service, send the envelope.
 *
 * Note what these do NOT do — none of them decides who may see what. Role checks happen in
 * `authorize`, company-status checks in `requireActiveCompany`, and ownership scoping
 * inside the service's queries. A controller that made access decisions would be a fourth
 * place to forget one.
 */

import type { Request, Response } from 'express';

import * as companyService from '../services/company.service';
import { ApiError } from '../utils/ApiError';
import { sendSuccess } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import type {
  CompanyStatusInput,
  CreateCompanyInput,
  ListCompaniesQuery,
  UpdateCompanyInput,
} from '../validators/company.validator';

/** Every handler below is behind `authenticate`, so this is a guard for TypeScript. */
function requireUser(req: Request) {
  if (!req.user) throw ApiError.unauthorized('Authentication required.');
  return req.user;
}

/** POST /companies — super_admin only. */
export const createCompany = asyncHandler(async (req: Request, res: Response) => {
  const user = requireUser(req);
  const company = await companyService.createCompany(req.body as CreateCompanyInput, user.id);
  sendSuccess(res, { company }, 'Company created successfully', 201);
});

/** GET /companies — super_admin only. The one deliberately unscoped read. */
export const listCompanies = asyncHandler(async (req: Request, res: Response) => {
  const result = await companyService.listCompanies(req.query as unknown as ListCompaniesQuery);
  sendSuccess(res, result, 'Companies retrieved');
});

/** GET /companies/me — cpo_admin / operator. Already loaded by requireActiveCompany. */
export const getMyCompany = asyncHandler(async (req: Request, res: Response) => {
  const company = companyService.getOwnCompany(req.company);
  sendSuccess(res, { company }, 'Company retrieved');
});

/** GET /companies/:companyId — super_admin any; company-scoped roles their own only. */
export const getCompanyById = asyncHandler(async (req: Request, res: Response) => {
  const user = requireUser(req);
  const company = await companyService.getCompanyById(user, String(req.params.companyId));
  sendSuccess(res, { company }, 'Company retrieved');
});

/** PATCH /companies/:companyId — super_admin only. Cannot change status. */
export const updateCompany = asyncHandler(async (req: Request, res: Response) => {
  const company = await companyService.updateCompany(
    String(req.params.companyId),
    req.body as UpdateCompanyInput,
  );
  sendSuccess(res, { company }, 'Company updated successfully');
});

/** PATCH /companies/:companyId/status — super_admin only. */
export const updateCompanyStatus = asyncHandler(async (req: Request, res: Response) => {
  const { status } = req.body as CompanyStatusInput;
  const company = await companyService.setCompanyStatus(String(req.params.companyId), status);
  sendSuccess(
    res,
    { company },
    status === 'active' ? 'Company activated' : 'Company suspended',
  );
});
