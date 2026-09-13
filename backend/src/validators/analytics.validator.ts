/**
 * Request validation for analytics.
 *
 * Every endpoint in this module takes the same optional window, so there is ONE range
 * schema that the others extend. Three endpoints each declaring their own `from`/`to` is
 * three places for the date rule to drift.
 *
 * STATUS CODES, and why they differ here:
 *
 *   400  the WINDOW is malformed - a date that is not a date, or `from` after `to`.
 *        `validateQuery` has returned 400 for every query string since Module 2, and the
 *        principle it documents fits: a broken query string is a broken request.
 *   422  the window is fine but the CALLER may not ask it that way - a company-scoped
 *        user naming a `companyId`. That is a role rule, which a schema cannot see
 *        because a schema does not know who is calling, so it lives in the service.
 *
 * `.strict()` as always. `?form=2026-01-01` is a typo that must fail loudly rather than
 * silently return the default window and look like it worked.
 */

import { z } from 'zod';

import { MAX_TOP_STATIONS } from '../constants/analytics';

const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid 24-character resource id');

/**
 * A calendar date, `YYYY-MM-DD`. Not a full ISO timestamp.
 *
 * The shape is restricted on purpose: accepting `2026-09-14T10:30:00Z` would invite the
 * belief that the time part is honoured, when the date rule rounds it to a whole UTC day
 * either way. A format that cannot express something the server ignores is a format that
 * cannot mislead.
 *
 * The `refine` is not redundant with the regex, and the check it performs is not the
 * obvious one. `2026-02-31` matches the pattern perfectly and is not a day that exists -
 * but V8 does NOT reject it. It SILENTLY ROLLS IT OVER:
 *
 *   new Date('2026-02-31T00:00:00.000Z').toISOString()  ->  '2026-03-03T00:00:00.000Z'
 *
 * So an `Invalid Date` check passes and the caller is quietly shown three days in March
 * while their screen says February. A test caught this. The fix is a ROUND TRIP: parse it,
 * format it back, and insist the server got out what the caller put in.
 */
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date in YYYY-MM-DD form')
  .refine(
    (value) => {
      // The NaN guard is not belt-and-braces. Zod runs every refinement even when the regex
      // above has already failed, so this receives raw input like `yesterday` - and
      // `Invalid Date.toISOString()` THROWS a RangeError rather than returning something
      // falsy, which turned a 400 into a 500 until a test caught it.
      const parsed = new Date(`${value}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime())) return false;

      return parsed.toISOString().slice(0, 10) === value;
    },
    { message: 'That date does not exist' },
  );

const rangeShape = {
  /** Inclusive start. Defaults to 29 days before `to`. */
  from: calendarDate.optional(),
  /** Inclusive END - the whole of this day counts. Defaults to today, UTC. */
  to: calendarDate.optional(),
  /**
   * super_admin only. They have no company of their own, so naming one is the only way
   * they can look at a single CPO. Anyone else sending it gets a 422 from the service -
   * see the note above, and Module 9's lesson that a dropped field looks like success.
   */
  companyId: objectId.optional(),
};

/**
 * `from` after `to` is checked here rather than in the service because it is only
 * reachable when BOTH are supplied - a defaulted end is always derived from the start and
 * cannot be inverted. Lexicographic comparison is exact for zero-padded YYYY-MM-DD, which
 * is the one real benefit of insisting on that format over a free-form date.
 */
const isOrdered = (value: { from?: string; to?: string }): boolean =>
  !value.from || !value.to || value.from <= value.to;

const ORDER_ERROR = { message: 'from must be on or before to', path: ['from'] };

export const analyticsRangeQuerySchema = z
  .object(rangeShape)
  .strict()
  .refine(isOrdered, ORDER_ERROR);

export const topStationsQuerySchema = z
  .object({
    ...rangeShape,
    limit: z.coerce.number().int().min(1).max(MAX_TOP_STATIONS).optional(),
  })
  .strict()
  .refine(isOrdered, ORDER_ERROR);

export type AnalyticsRangeQuery = z.infer<typeof analyticsRangeQuerySchema>;
export type TopStationsQuery = z.infer<typeof topStationsQuerySchema>;
