import Link from 'next/link';

import { StatusBadge, type Tone } from '@/components/StatusBadge';
import type { ChargingSession, SessionStatus } from '@/types/api';

/**
 * The session status vocabulary, translated once for the whole app.
 *
 * `initiating` and `stopping` are amber rather than green because they are WAITING states —
 * the charger has been asked and has not answered yet. Showing them as success would tell the
 * driver energy is flowing when it may never start.
 */
export function sessionTone(status: SessionStatus): Tone {
  if (status === 'active') return 'good';
  if (status === 'completed') return 'neutral';
  if (status === 'failed') return 'bad';
  return 'warn';
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
};

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
  return new Date(value).toLocaleString();
}

/** One row in a session list. Used by both the driver history and the staff monitor. */
export function SessionRow({ session }: { session: ChargingSession }) {
  return (
    <Link
      href={`/sessions/${session.id}`}
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-200 p-4 transition-colors hover:bg-neutral-500/5 dark:border-neutral-800"
    >
      <div className="min-w-0">
        <p className="truncate font-medium">
          {formatEnergy(session)}
          <span className="ml-2 text-xs font-normal text-neutral-500">
            connector {session.connectorNumber}
          </span>
        </p>
        <p className="mt-0.5 truncate text-xs text-neutral-500">
          {formatWhen(session.startedAt ?? session.requestedAt)}
          {' · '}
          {formatDuration(session)}
          {session.stopReason ? ` · ${STOP_REASON_LABELS[session.stopReason] ?? session.stopReason}` : ''}
        </p>
      </div>
      <StatusBadge tone={sessionTone(session.status)} label={SESSION_STATUS_LABELS[session.status]} />
    </Link>
  );
}
