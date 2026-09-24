/**
 * When did a session that died WITHOUT a StopTransaction actually stop charging?
 *
 * THE BUG THIS FIXES. When a charger vanished mid-charge, the session was closed with
 * `endedAt = new Date()` — the moment the PLATFORM NOTICED, not the moment charging stopped. If
 * the backend was down overnight, or the heartbeat sweep only ran hours later, a 0.5 kWh charge
 * showed "16h 47m" on the driver's receipt. A CDR must describe the charge, not our detection lag.
 *
 * The last real evidence of charging is the charger's own latest meter reading. With no readings
 * at all, the charge started and produced nothing we can see, so it ends where it began. Never
 * later than now, and never before it started.
 */

import { MeterReading } from '../models/meterReading.model';
import type { ChargingSessionDocument } from '../models/chargingSession.model';

export async function lastEvidenceOfCharging(session: ChargingSessionDocument): Promise<Date> {
  const now = new Date();

  const latest = await MeterReading.findOne({ sessionId: session._id })
    .sort({ meterTimestamp: -1 })
    .select('meterTimestamp')
    .lean();

  const candidate = latest?.meterTimestamp ?? session.startedAt ?? now;
  const start = session.startedAt ?? candidate;

  const end = Math.min(now.getTime(), Math.max(start.getTime(), new Date(candidate).getTime()));
  return new Date(end);
}
