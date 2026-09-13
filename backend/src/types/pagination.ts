/**
 * The standard list envelope, shared by every paginated endpoint.
 *
 * Extracted here in Module 3 so `user.service` and `company.service` use one definition
 * rather than each declaring its own. Pure type move — no behaviour change.
 */
export interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
