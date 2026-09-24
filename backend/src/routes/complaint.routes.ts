import { Router } from 'express';

import {
  confirmComplaintResolved,
  createComplaint,
  getComplaintById,
  listComplaints,
  reopenComplaint,
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
  reopenComplaintSchema,
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
 * The staff lifecycle. The driver never declares their own ticket fixed from here — their two
 * moves (confirm, reopen) are the dedicated routes below, because they are a different claim.
 *
 * The role split within staff is enforced in the service, not here: an operator may move a
 * ticket between open and in_progress and add notes, but only an administrator may resolve,
 * close, or take back a resolution. That depends on the target status, so it cannot live in
 * `authorize()`.
 */
router.patch(
  '/:complaintId/status',
  authorize(...STAFF_ROLES),
  validateParams(complaintIdParamSchema),
  validateBody(complaintStatusSchema),
  setComplaintStatus,
);

/**
 * The driver's side of a resolution. DRIVER ONLY, owner-scoped in the service.
 *
 *   confirm  resolved -> closed   "yes, it is fixed"
 *   reopen   resolved -> open     "no, it is still broken" (reason required)
 *
 * Only from `resolved`. A closed complaint is final; a problem that returns after closure is a
 * new complaint with `followUpOf` pointing at the old one.
 */
router.post(
  '/:complaintId/confirm',
  authorize(ROLES.DRIVER),
  validateParams(complaintIdParamSchema),
  confirmComplaintResolved,
);

router.post(
  '/:complaintId/reopen',
  authorize(ROLES.DRIVER),
  validateParams(complaintIdParamSchema),
  validateBody(reopenComplaintSchema),
  reopenComplaint,
);

export default router;
