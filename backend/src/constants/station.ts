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

/**
 * MODULE 14 — how many markers one map request may return.
 *
 * A map has no "next page": you cannot show half a map, so the honest bound is a cap plus a
 * `truncated` flag rather than pagination that would silently hide a site the caller is
 * standing next to. Never reached at this project's scale — it exists so that one request
 * cannot ask the database for every station on earth.
 *
 * Lives here rather than in the map service so the validator and the service can share it
 * without importing each other.
 */
export const MAX_MAP_STATIONS = 500;

/**
 * "Near me" search radius. 25 km covers a city; 200 km is a highway trip's worth of range
 * anxiety. Beyond that, "near" stops meaning anything and the plain list is the better tool.
 */
export const DEFAULT_NEAR_RADIUS_KM = 25;
export const MAX_NEAR_RADIUS_KM = 200;
