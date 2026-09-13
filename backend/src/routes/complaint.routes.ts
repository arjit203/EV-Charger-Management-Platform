import { Router } from 'express';

import {
  createComplaint,
  getComplaintById,
  listComplaints,
  setComplaintStatus,
  updateComplaint,
} from '../controllers/complaint.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { authorize } from '../middlewares/role.middleware';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate.middleware';
import { ROLES } from '../constants/roles';
import {
  complaintIdParamSchema,
  complaintStatusSchema,
  createComplaintSchema,
  listComplaintsQuerySchema,
  updateComplaintSchema,
} from '../validators/complaint.validator';

const router = Router();

/*
 * Mounted at /complaints.
 *
 * `requireActiveCompany` is ABSENT from every route, and deliberately so. A driver belongs to no
 * company, and applying it would reject every one of them before the handler ran — the same
 * reasoning as Module 7's session routes. Company scoping still happens, inside the service,
 * where the role decides whether the caller is scoped by company or by ownership.
 *
 * No DELETE. A complaint is a support record: it gets closed, never erased.
 */
router.use(authenticate);

const STAFF_ROLES = [ROLES.SUPER_ADMIN, ROLES.CPO_ADMIN, ROLES.OPERATOR] as const;
const ALL_ROLES = [...STAFF_ROLES, ROLES.DRIVER] as const;

/**
 * Filing a complaint. DRIVER ONLY.
 *
 * Staff do not file complaints on a driver's behalf: the ticket carries a `userId` that decides
 * who can read it afterwards, so a staff-created one would belong to the staff member and be
 * invisible to the person who actually had the problem.
 */
router.post('/', authorize(ROLES.DRIVER), validateBody(createComplaintSchema), createComplaint);

router.get(
  '/',
  authorize(...ALL_ROLES),
  validateQuery(listComplaintsQuerySchema),
  listComplaints,
);

router.get(
  '/:complaintId',
  authorize(...ALL_ROLES),
  validateParams(complaintIdParamSchema),
  getComplaintById,
);

/**
 * Annotating a complaint — resolution notes and priority. STAFF ONLY.
 *
 * `subject` and `description` are not editable by anyone, including the driver who wrote them.
 * A support ticket is an audit record; letting the reporter rewrite what they reported would
 * destroy the only reason to keep it after it closes.
 */
router.patch(
  '/:complaintId',
  authorize(...STAFF_ROLES),
  validateParams(complaintIdParamSchema),
  validateBody(updateComplaintSchema),
  updateComplaint,
);

/**
 * The lifecycle. STAFF ONLY — a driver can report a problem and watch it, not declare it fixed.
 *
 * The role split within staff is enforced in the service, not here: an operator may move a
 * ticket to `in_progress` and add notes, but only an administrator may `resolve` or `close` it.
 * That distinction cannot live in `authorize()`, because it depends on the target status.
 */
router.patch(
  '/:complaintId/status',
  authorize(...STAFF_ROLES),
  validateParams(complaintIdParamSchema),
  validateBody(complaintStatusSchema),
  setComplaintStatus,
);

export default router;
