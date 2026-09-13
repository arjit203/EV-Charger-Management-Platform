/**
 * UTC date-window arithmetic for Module 13.
 *
 * THE ONE DATE RULE, implemented once: a range is expressed as two calendar dates and
 * covers BOTH of them WHOLE, in UTC.
 *
 *   from=2026-09-01&to=2026-09-07
 *     -> 2026-09-01T00:00:00.000Z .. 2026-09-07T23:59:59.999Z
 *
 * The inclusive end is the part worth being deliberate about. `$lte: new Date('2026-09-07')`
 * means `2026-09-07T00:00:00.000Z`, which silently drops the whole of the last day a user
 * explicitly asked for - a single-day query returning nothing but the first millisecond.
 * Every endpoint in this module builds its window here so that cannot happen in one place
 * and not another.
 *
 * Everything is UTC. See `constants/analytics.ts` for why the server refuses to guess a
 * timezone.
 */

import { DEFAULT_RANGE_DAYS } from '../constants/analytics';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** An inclusive, fully-resolved window. Both ends are real instants, never null. */
export interface DateRange {
  from: Date;
  to: Date;
}

/** `2026-09-14` -> `2026-09-14T00:00:00.000Z`. */
export function startOfUtcDay(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

/** `2026-09-14` -> `2026-09-14T23:59:59.999Z`. The inclusive end. */
export function endOfUtcDay(isoDate: string): Date {
  return new Date(`${isoDate}T23:59:59.999Z`);
}

/** A `Date` -> the `YYYY-MM-DD` key used to group and to label a chart axis. */
export function toUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Resolve the caller's optional `from`/`to` into a concrete window.
 *
 * Defaults to the last {@link DEFAULT_RANGE_DAYS} days INCLUDING today, which is why the
 * subtraction uses `DEFAULT_RANGE_DAYS - 1`: today plus the 29 days before it is 30 days,
 * not 31. An off-by-one here would be invisible on a chart and wrong in a total.
 */
export function resolveRange(from?: string, to?: string): DateRange {
  const today = toUtcDateKey(new Date());

  const toKey = to ?? today;
  const fromKey =
    from ??
    toUtcDateKey(new Date(startOfUtcDay(toKey).getTime() - (DEFAULT_RANGE_DAYS - 1) * MS_PER_DAY));

  return { from: startOfUtcDay(fromKey), to: endOfUtcDay(toKey) };
}

/**
 * Every `YYYY-MM-DD` key in the window, in order.
 *
 * This exists so a daily series can be ZERO-FILLED. An aggregation returns only the days
 * that had rows, and a chart drawn straight from that result quietly closes the gaps -
 * three scattered sessions across a fortnight render as three adjacent bars and look like
 * a busy week. Filling the gaps makes an empty day visibly empty.
 */
export function eachUtcDay(range: DateRange): string[] {
  const keys: string[] = [];

  // Walk from midnight to midnight so DST and leap seconds cannot shift a step; UTC days
  // are exactly MS_PER_DAY apart, which is the reason this module is UTC-only.
  for (
    let cursor = startOfUtcDay(toUtcDateKey(range.from)).getTime();
    cursor <= range.to.getTime();
    cursor += MS_PER_DAY
  ) {
    keys.push(toUtcDateKey(new Date(cursor)));
  }

  return keys;
}

/**
 * Whole days covered by a window, BOTH ENDS INCLUSIVE.
 *
 * A single day returns 1, not 0: the window runs 00:00:00.000 to 23:59:59.999, which is one
 * millisecond short of a full day, and rounding closes that gap. So the result is already
 * the inclusive count and callers must NOT add one - a `+ 1` here reported a three-day span
 * as four days until a test caught it.
 */
export function daysInRange(range: DateRange): number {
  return Math.round((range.to.getTime() - range.from.getTime()) / MS_PER_DAY);
}
