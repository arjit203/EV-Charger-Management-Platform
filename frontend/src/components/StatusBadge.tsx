type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'info';

const TONE_CLASSES: Record<Tone, string> = {
  good: 'bg-emerald-500/10 text-emerald-700 ring-emerald-600/30 dark:text-emerald-400',
  warn: 'bg-amber-500/10 text-amber-700 ring-amber-600/30 dark:text-amber-400',
  bad: 'bg-red-500/10 text-red-700 ring-red-600/30 dark:text-red-400',
  neutral: 'bg-neutral-500/10 text-neutral-700 ring-neutral-600/30 dark:text-neutral-300',
  /* In-flight. Blue, NOT the accent — see the note on `statusTone` below. */
  info: 'bg-blue-500/10 text-blue-700 ring-blue-600/30 dark:text-blue-400',
};

const DOT_CLASSES: Record<Tone, string> = {
  good: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
  neutral: 'bg-neutral-500',
  info: 'bg-blue-500',
};

/**
 * THE ONE STATUS VOCABULARY FOR THE WHOLE APPLICATION.
 *
 * Every status string this project produces — across chargers, connectors, sessions,
 * payments, complaints, stations, companies and users — maps to exactly one tone here.
 *
 * WHY THIS MAP EXISTS. `StatusBadge` was used on 23 files, and 21 OTHERS rendered status as
 * hand-coloured text instead: `text-emerald-600` here, a local `STATUS_TONE` record there.
 * The same `charging` was blue on one screen and green on another. One map means a status
 * cannot look like two different things depending on which page you opened.
 *
 * FOUR MEANINGS, AND NOTHING ELSE:
 *
 *   good     healthy, available, settled, done
 *   info     in flight — something is happening right now and is not a problem
 *   warn     needs attention but is not broken
 *   bad      faulted, failed, refused
 *   neutral  inert — offline, inactive, closed, not applicable
 *
 * The ACCENT (indigo) is deliberately absent. It is chrome — navigation, buttons, focus —
 * and letting it leak in here would make the interface's most common colour also mean
 * something, which is how a status palette stops being readable at a glance.
 */
const STATUS_TONES: Record<string, Tone> = {
  /* healthy / settled */
  available: 'good',
  active: 'good',
  online: 'good',
  completed: 'good',
  paid: 'good',
  resolved: 'good',
  success: 'good',

  /* in flight */
  charging: 'info',
  preparing: 'info',
  finishing: 'info',
  initiating: 'info',
  stopping: 'info',
  in_progress: 'info',
  occupied: 'info',

  /* needs attention */
  pending: 'warn',
  unpaid: 'warn',
  open: 'warn',
  maintenance: 'warn',
  reconnecting: 'warn',

  /* broken */
  faulted: 'bad',
  failed: 'bad',
  suspended: 'bad',
  blocked: 'bad',

  /* inert */
  offline: 'neutral',
  inactive: 'neutral',
  unavailable: 'neutral',
  closed: 'neutral',
  refunded: 'neutral',
};

/** The tone for a domain status string. Unknown values stay neutral rather than guessing. */
export function statusTone(status: string): Tone {
  return STATUS_TONES[status.toLowerCase().replace(/\s+/g, '_')] ?? 'neutral';
}

/** `in_progress` → `in progress`. Underscores are a database detail, not a label. */
function humanise(status: string): string {
  return status.replace(/_/g, ' ');
}

/**
 * Small coloured pill showing a state at a glance.
 *
 * Two ways to call it, and the second is preferred:
 *
 *   <StatusBadge tone="good" label="Account: active" />   explicit — for composed labels
 *   <StatusBadge status={charger.status} />               derived  — for a domain status
 *
 * The derived form is what keeps the vocabulary consistent: the caller passes the raw status
 * and does not get to decide what colour it is.
 */
export function StatusBadge({
  tone,
  label,
  status,
  size = 'md',
}: {
  tone?: Tone;
  label?: string;
  status?: string;
  size?: 'sm' | 'md';
}) {
  const resolvedTone = tone ?? (status ? statusTone(status) : 'neutral');
  const resolvedLabel = label ?? (status ? humanise(status) : '');

  const sizing = size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1 text-xs';

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-medium capitalize ring-1 ring-inset ${sizing} ${TONE_CLASSES[resolvedTone]}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASSES[resolvedTone]}`} />
      {resolvedLabel}
    </span>
  );
}

export type { Tone };
