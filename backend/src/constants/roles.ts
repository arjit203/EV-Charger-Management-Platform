/**
 * The project's RBAC roles. LOCKED — do not add, rename or collapse these.
 *
 *  super_admin  Platform level. Manages companies/CPOs and platform-wide resources.
 *               The only role not scoped to a single company.
 *  cpo_admin    Scoped to their own companyId. Manages that company's stations,
 *               chargers, operators and operational data. Must never reach another
 *               company's data.
 *  operator     Scoped to their assigned company/stations. Monitors and operates
 *               chargers and stations. No platform or company administration.
 *  driver       EV owner. Manages only their own profile, vehicle and wallet; views
 *               available stations; starts/stops only their OWN sessions; views only
 *               their own charging and payment history.
 *
 * Enforcement rule for every later module: ownership and company scoping are enforced
 * SERVER-SIDE, inside middleware and service-layer queries. Hiding a button in the
 * frontend is not authorisation.
 */

export const ROLES = {
  SUPER_ADMIN: 'super_admin',
  CPO_ADMIN: 'cpo_admin',
  OPERATOR: 'operator',
  DRIVER: 'driver',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const ALL_ROLES: Role[] = Object.values(ROLES);

/**
 * Roles whose every query must be filtered by `companyId`.
 * Module 2 onward: if the requester's role is in this list, scope the query — never
 * return unfiltered results.
 */
export const COMPANY_SCOPED_ROLES: Role[] = [ROLES.CPO_ADMIN, ROLES.OPERATOR];

/** Roles that administer a company (but not necessarily the platform). */
export const COMPANY_ADMIN_ROLES: Role[] = [ROLES.SUPER_ADMIN, ROLES.CPO_ADMIN];

/** Roles allowed to perform operational actions on chargers/stations. */
export const OPERATIONAL_ROLES: Role[] = [ROLES.SUPER_ADMIN, ROLES.CPO_ADMIN, ROLES.OPERATOR];

/**
 * The only roles a super_admin may assign when creating staff for a company
 * (Module 2's `POST /companies/:companyId/users`).
 *
 * `super_admin` is excluded so the endpoint can never mint another platform administrator,
 * and `driver` is excluded because drivers are not company staff — they self-register.
 */
export const ASSIGNABLE_COMPANY_ROLES = [ROLES.CPO_ADMIN, ROLES.OPERATOR] as const;
export type AssignableCompanyRole = (typeof ASSIGNABLE_COMPANY_ROLES)[number];
