/**
 * Company constants.
 *
 * `type` is descriptive metadata for the CPMS domain — it records what kind of business
 * this company is, and nothing branches on it. Per Module 2's locked scope there is no
 * per-type business logic, licensing, or billing behaviour.
 *
 *   CPO       Charge Point Operator — owns and runs physical chargers.
 *   eMSP      e-Mobility Service Provider — gives drivers access to networks it does not own.
 *   PLATFORM  Sells/operates the CPMS software itself.
 */

export const COMPANY_TYPES = ['CPO', 'eMSP', 'PLATFORM'] as const;
export type CompanyType = (typeof COMPANY_TYPES)[number];

/**
 * `suspended` means the business is on hold: its staff may still log in (identity is a
 * separate question), but every company-scoped request is refused. See
 * `requireActiveCompany` in companyScope.middleware.ts.
 *
 * This is deliberately independent of `User.status` — one switch says "this business is
 * on hold", the other says "this person is locked out".
 */
export const COMPANY_STATUSES = ['active', 'suspended'] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];
