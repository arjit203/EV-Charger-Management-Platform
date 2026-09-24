import Link from 'next/link';

import { StatusBadge, statusTone, type Tone } from '@/components/StatusBadge';
import { formatPaise } from '@/lib/money';
import type { ChargingSession, SessionStatus } from '@/types/api';
import { formatDateTime } from '@/lib/datetime';

/**
 * The session status vocabulary, translated once for the whole app.
 *
 * `initiating` and `stopping` are amber rather than green because they are WAITING states —
 * the charger has been asked and has not answered yet. Showing them as success would tell the
 * driver energy is flowing when it may never start.
 */
/**
 * Delegates to the shared status vocabulary rather than keeping its own opinion.
 *
 * The local version said `completed` was NEUTRAL (grey) and `initiating` was WARN (amber),
 * while the rest of the app now reads `completed` as good and in-flight states as info. A
 * finished charge is a success, not a shrug, and it must not be grey on one screen and green
 * on another.
 *
 * The friendly LABELS below are kept — "starting…" reads better than "initiating" — because
 * wording and colour are separate decisions, and only the colour needed unifying.
 */
export function sessionTone(status: SessionStatus): Tone {
  return statusTone(status);
}

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  initiating: 'starting…',
  active: 'charging',
  stopping: 'stopping…',
  completed: 'completed',
  failed: 'failed',
};

/** Why a session ended, in words a driver understands rather than protocol vocabulary. */
export const STOP_REASON_LABELS: Record<string, string> = {
  Remote: 'Stopped from the app',
  Local: 'Stopped at the charger',
  ChargerDisconnected: 'The charger lost connection',
  StartTimeout: 'The charger never confirmed the start',
  Rejected: 'The charger refused to start',
  HardwareFault: 'The charger reported a fault',
};

/**
 * Why it ended, in one sentence — and WHO ended it when that was not the driver.
 *
 * `stopReason: 'Remote'` alone reads "Stopped from the app" even when an operator force-stopped
 * someone's car, which told the driver the opposite of what happened.
 */
export function describeStop(session: ChargingSession): string | null {
  if (session.stoppedByRole && session.stoppedByRole !== 'driver') {
    return `Stopped by the station operator${session.stopNote ? ` — "${session.stopNote}"` : ''}`;
  }
  if (!session.stopReason) return null;
  return STOP_REASON_LABELS[session.stopReason] ?? session.stopReason;
}

/** "Operator · Station, City" — where a charge happened, for list rows and headers. */
export function describeWhere(session: ChargingSession): string {
  const station = [session.stationName, session.stationCity].filter(Boolean).join(', ');
  return [session.companyName, station].filter(Boolean).join(' · ');
}

export function formatEnergy(session: ChargingSession): string {
  return `${session.energyConsumedKwh.toFixed(3)} kWh`;
}

/** Elapsed time — live for a running session, final once it has ended. */
export function formatDuration(session: ChargingSession, now = Date.now()): string {
  if (!session.startedAt) return '—';

  const end = session.endedAt ? new Date(session.endedAt).getTime() : now;
  const seconds = Math.max(0, Math.round((end - new Date(session.startedAt).getTime()) / 1000));

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;

  return hours > 0
    ? `${hours}h ${String(minutes).padStart(2, '0')}m`
    : `${minutes}m ${String(rest).padStart(2, '0')}s`;
}

export function formatWhen(value: string | null): string {
  if (!value) return '—';
  return formatDateTime(value);
}

/** One row in a session list. Used by both the driver history and the staff monitor. */
export function SessionRow({ session }: { session: ChargingSession }) {
  return (
    <Link
      href={`/sessions/${session.id}`}
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-200 p-4 transition-colors hover:bg-neutral-500/5 dark:border-neutral-800"
    >
      <div className="min-w-0">
        {describeWhere(session) && (
          <p className="truncate text-sm font-medium">{describeWhere(session)}</p>
        )}
        <p className="truncate font-medium tabular-nums">
          {formatEnergy(session)}
          {session.amountPaise !== null && (
            <span className="ml-3 text-neutral-500">{formatPaise(session.amountPaise)}</span>
          )}
          <span className="ml-2 text-xs font-normal text-neutral-500">
            {session.chargerName ? `${session.chargerName} · ` : ''}
            connector {session.connectorNumber}
            {session.connectorType && ` · ${session.connectorType}`}
            {session.chargerType && ` · ${session.chargerType}`}
          </span>
        </p>
        <p className="mt-0.5 truncate text-xs text-neutral-500">
          {session.driverName && `${session.driverName} · `}
          {formatWhen(session.startedAt ?? session.requestedAt)}
          {' · '}
          {formatDuration(session)}
          {describeStop(session) ? ` · ${describeStop(session)}` : ''}
        </p>
      </div>
      <StatusBadge tone={sessionTone(session.status)} label={SESSION_STATUS_LABELS[session.status]} />
    </Link>
  );
}

/**
 * ONE CHARGE PER ACCOUNT, said out loud.
 *
 * This page used to `router.replace()` straight to the running session the moment it loaded, so a
 * driver who tapped "Start" on the free plug beside their car was teleported to a different screen
 * with no explanation. Real charging apps say why: you are already charging, here, and this is
 * how to get back to it. The server enforces the same rule (409 with the running session's id),
 * so this banner is information, not the lock.
 */
export function AlreadyCharging({ active }: { active: ChargingSession }) {
  const where = describeWhere(active);
  return (
    <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-5 text-sm text-amber-800 dark:text-amber-300">
      <p className="font-semibold">You already have a charge in progress</p>
      <p className="mt-1">
        {where ? `${where} — ` : ''}
        {active.chargerName ? `${active.chargerName}, ` : ''}connector {active.connectorNumber}.
        One account charges one car at a time, so this plug can&apos;t be started until that
        charge is stopped or finishes.
      </p>
      <Link
        href={`/sessions/${active.id}`}
        className="mt-3 inline-block rounded-lg bg-amber-600 px-4 py-2 font-medium text-white transition-colors hover:bg-amber-700"
      >
        Go to my current charge
      </Link>
    </div>
  );
}
