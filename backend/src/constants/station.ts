/**
 * Station constants.
 *
 * Three statuses, with a deliberate split over who may set which:
 *
 *   active     In service.                        super_admin, cpo_admin
 *   inactive   Temporarily out of service — under construction, seasonal closure,
 *              site access blocked. This is the CPO's OWN operational switch, so a
 *              cpo_admin can take a broken site offline without waiting on the platform.
 *                                                 super_admin, cpo_admin
 *   suspended  A PLATFORM SANCTION — compliance, billing or policy.
 *                                                 super_admin ONLY
 *
 * The split matters: if a cpo_admin could clear `suspended`, a platform-level sanction
 * would be meaningless because they could simply un-suspend their own station. They get
 * `inactive` for their own needs; `suspended` belongs to the platform.
 */

export const STATION_STATUSES = ['active', 'inactive', 'suspended'] as const;
export type StationStatus = (typeof STATION_STATUSES)[number];

/** Statuses a company-scoped admin may set on their own stations. */
export const CPO_SETTABLE_STATION_STATUSES: StationStatus[] = ['active', 'inactive'];
