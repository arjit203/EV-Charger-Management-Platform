type Tone = 'good' | 'warn' | 'bad' | 'neutral';

const TONE_CLASSES: Record<Tone, string> = {
  good: 'bg-emerald-500/10 text-emerald-700 ring-emerald-600/30 dark:text-emerald-400',
  warn: 'bg-amber-500/10 text-amber-700 ring-amber-600/30 dark:text-amber-400',
  bad: 'bg-red-500/10 text-red-700 ring-red-600/30 dark:text-red-400',
  neutral: 'bg-neutral-500/10 text-neutral-700 ring-neutral-600/30 dark:text-neutral-300',
};

const DOT_CLASSES: Record<Tone, string> = {
  good: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
  neutral: 'bg-neutral-500',
};

/** Small coloured pill used to show a service or database state at a glance. */
export function StatusBadge({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset ${TONE_CLASSES[tone]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOT_CLASSES[tone]}`} />
      {label}
    </span>
  );
}

export type { Tone };
