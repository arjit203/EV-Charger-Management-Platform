/**
 * One way to print a date and time, everywhere in the app.
 *
 * THE BUG THIS REPLACES. Every screen called `toLocaleString()` with no arguments, which uses
 * whatever locale the BROWSER happens to have. The same ticket read "9/23/2026, 2:43:55 AM" in one
 * browser, "23/9/2026, 2:43:55 am" in another and "24/09/2026, 23:24:37" in a third — so a date
 * copied from a support screen into a message could mean a different day to the person reading
 * it. The locale and the fields are pinned here instead.
 *
 *   formatDateTime  24 Sept 2026, 11:24 pm     lists, tickets, receipts
 *   formatDate      24 Sept 2026               "member since", due dates
 *   formatTime      11:24:05 pm                meter readings, "last checked"
 *
 * `en-IN` because this is an Indian CPO platform (₹, Razorpay) and it spells the month, which
 * removes the day/month ambiguity entirely. The browser's TIME ZONE is still used — a driver in
 * Mumbai should see Mumbai time.
 */

const LOCALE = 'en-IN';

const DATE_TIME: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
};

const DATE: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' };

const TIME: Intl.DateTimeFormatOptions = {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
};

type DateInput = string | number | Date | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(value: DateInput, fallback = '—'): string {
  const date = toDate(value);
  return date ? date.toLocaleString(LOCALE, DATE_TIME) : fallback;
}

export function formatDate(value: DateInput, fallback = '—'): string {
  const date = toDate(value);
  return date ? date.toLocaleDateString(LOCALE, DATE) : fallback;
}

export function formatTime(value: DateInput, fallback = '—'): string {
  const date = toDate(value);
  return date ? date.toLocaleTimeString(LOCALE, TIME) : fallback;
}
