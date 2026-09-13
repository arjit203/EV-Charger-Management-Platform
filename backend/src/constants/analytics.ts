/**
 * Analytics constants and the project's ONE date rule.
 *
 * Module 13 is the first module that only READS. It owns no collection, defines no state
 * machine and writes nothing. Everything it reports is derived from rows Modules 4-11
 * already produce, which is why the two decisions below matter more than any code here:
 * when a number can be computed two ways, the wrong one is not obviously wrong.
 *
 * ---------------------------------------------------------------------------
 * D1 - REVENUE IS PAID `session_debit` PAYMENTS. NOT ALL PAID PAYMENTS.
 * ---------------------------------------------------------------------------
 *
 * `PaymentTransaction` carries two purposes, and only one of them is a sale:
 *
 *   wallet_recharge   a driver DEPOSITS money. The platform now owes them a balance.
 *   session_debit     a driver SPENDS it on electricity. This is the sale.
 *
 * Summing both double-counts every rupee and inflates revenue by every top-up: a driver
 * who adds Rs500 and then buys Rs60 of electricity would show Rs560 of "revenue" against
 * Rs60 actually earned. A recharge is a CUSTOMER DEPOSIT - a liability, not income. The
 * money was already in the platform's account; the sale is the moment it converts.
 *
 * There is a trap worth naming: `companyId` is NULL on a recharge, because no company is
 * involved in a driver topping up. So a cpo_admin's company filter excludes recharges
 * ANYWAY, and the bug would never appear in company-scoped testing. It appears only for
 * super_admin, who is unscoped. The explicit `purpose` filter is what makes the number
 * correct for the one caller who can see everything.
 *
 * ---------------------------------------------------------------------------
 * D2 - ENERGY IS `ChargingSession.energyConsumedWh`. NEVER A SUM OF METER READINGS.
 * ---------------------------------------------------------------------------
 *
 * `MeterReading.energyWh` is a CUMULATIVE LIFETIME COUNTER, exactly as OCPP reports it.
 * A session metering 0 -> 1666 -> 3333 -> 5000 Wh delivered 5 kWh; summing those readings
 * gives 9.999 kWh. The error scales with how often the charger reports, so a charger
 * configured to send MeterValues twice as often would appear to deliver twice the energy.
 *
 * `ChargingSession.energyConsumedWh` is `endMeter - startMeter`, computed once by Module 7
 * and clamped at zero. That is the authoritative figure and the only one this module sums.
 * `MeterReading` is used for exactly one thing in this project - the time-series of a
 * SINGLE session, which Module 7's `/readings` endpoint already serves. It never appears
 * in a cross-session aggregation.
 */

import type { PaymentPurpose, PaymentStatus } from './wallet';

/* -------------------------------------------------------------------------- */
/* The authoritative-source filters (D1, D2)                                  */
/* -------------------------------------------------------------------------- */

/**
 * The revenue filter, in one place so it cannot drift between the overview, the daily
 * series and the per-station breakdown. Three endpoints reporting three different
 * revenue numbers is precisely the failure this constant exists to prevent.
 */
export const REVENUE_MATCH: { status: PaymentStatus; purpose: PaymentPurpose } = {
  status: 'paid',
  purpose: 'session_debit',
};

/* -------------------------------------------------------------------------- */
/* The date rule (D4)                                                         */
/* -------------------------------------------------------------------------- */

/**
 * DATES ARE UTC AND BOTH ENDS ARE INCLUSIVE.
 *
 *   from  ->  that calendar date at 00:00:00.000 UTC
 *   to    ->  that calendar date at 23:59:59.999 UTC
 *
 * Stated once and applied by every endpoint, because "does `to` include that day?" is the
 * kind of question that gets answered differently in three places and produces three
 * subtly disagreeing charts.
 *
 * Every timestamp in this project has been UTC since Module 0 and there is no timezone
 * conversion anywhere in the backend. Rendering in a viewer's local time is a frontend
 * formatting concern, and deliberately stays one - a server that guesses a timezone is a
 * server that reports Monday's revenue on Sunday for half its users.
 */
export const DEFAULT_RANGE_DAYS = 30;

/** An upper bound on the window, so one request cannot ask the database to scan for ever. */
export const MAX_RANGE_DAYS = 366;

/* -------------------------------------------------------------------------- */
/* D5 - WHICH TIMESTAMP ANCHORS WHICH METRIC                                  */
/* -------------------------------------------------------------------------- */

/**
 * Each metric is anchored on the moment the thing it counts ACTUALLY HAPPENED:
 *
 *   sessions, energy   `startedAt`   when the charge happened
 *   revenue            `paidAt`      when the money moved
 *   complaints         `createdAt`   when it was reported
 *
 * These genuinely differ, and Module 10 made them differ ON PURPOSE. A driver whose wallet
 * is short gets their electricity anyway and settles later, so a charge delivered on Monday
 * and collected on Wednesday is Monday's ENERGY and Wednesday's REVENUE. Both are correct.
 * Forcing them onto one timestamp would make one of the two numbers a lie.
 *
 * Sessions are anchored on `startedAt` rather than `requestedAt` or `endedAt` because a
 * session that began at 23:50 and ended at 00:10 belongs to the day the car plugged in.
 * It also excludes sessions that never started - an `initiating` session that timed out
 * delivered nothing and should not appear in a count of charges.
 */
export const SESSION_DATE_FIELD = 'startedAt' as const;
export const REVENUE_DATE_FIELD = 'paidAt' as const;
export const COMPLAINT_DATE_FIELD = 'createdAt' as const;

/* -------------------------------------------------------------------------- */
/* D6 - STATUS SNAPSHOT, NOT UTILIZATION                                      */
/* -------------------------------------------------------------------------- */

/**
 * Charger UTILIZATION - busy time divided by total time - is deliberately NOT built.
 *
 * The honest reason: this project's chargers are simulated and every session is started by
 * hand. Utilization computed from sparse, manually triggered sessions would be a
 * meaningless number wearing the costume of a metric, and worse, it would look
 * authoritative sitting on a dashboard next to figures that are real.
 *
 * The distinction that decides it: CURRENT STATUS IS A FACT ABOUT THIS INSTANT;
 * UTILIZATION IS A CLAIM ABOUT A PERIOD. Only the first is honestly computable here, so
 * the fleet section reports a live status snapshot and says so in its label.
 *
 * What would change the answer: real chargers running unattended, so that "busy" is
 * measured rather than staged.
 */

/** How many stations the leaderboard returns by default. */
export const DEFAULT_TOP_STATIONS = 5;
export const MAX_TOP_STATIONS = 50;
