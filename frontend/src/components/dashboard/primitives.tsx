'use client';

/**
 * The small shared pieces every dashboard section is built from.
 *
 * Nine bespoke cards means nine places to forget a padding change. One `StatCard` means one
 * place to fix it — which is the entire argument for this file.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';

import { IconInbox } from '@/components/layout/icons';
import { Button } from '@/components/ui/Button';

/* -------------------------------------------------------------------------- */
/* Cards                                                                      */
/* -------------------------------------------------------------------------- */

export function StatCard({
  label,
  value,
  sub,
  href,
  tone = 'default',
}: {
  label: string;
  value: string;
  sub?: string;
  /** When given, the whole card becomes the link to the page that can act on it. */
  href?: string;
  tone?: 'default' | 'warn' | 'bad';
}) {
  const toneClass =
    tone === 'warn'
      ? 'text-amber-600 dark:text-amber-500'
      : tone === 'bad'
        ? 'text-red-600 dark:text-red-500'
        : '';

  /*
   * THE HIERARCHY IS THE POINT, and it is three deliberate steps rather than three sizes
   * chosen ad hoc:
   *
   *   label   11px, uppercase, tracked, muted   — what this is
   *   value   30px, semibold, tabular           — THE NUMBER. The reason the card exists
   *   sub     12px, muted                       — context you read second
   *
   * `tabular-nums` matters more than it looks: proportional digits make a column of figures
   * ripple as values change live, which on this dashboard they do.
   *
   * `min-h` keeps a row of cards level even when one has no `sub` line.
   */
  const body = (
    <>
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-neutral-500">
        {label}
      </p>
      <p className={`mt-1.5 text-[30px] font-semibold leading-none tabular-nums ${toneClass}`}>
        {value}
      </p>
      {sub && <p className="mt-2 text-xs leading-relaxed text-neutral-500">{sub}</p>}
    </>
  );

  const base =
    'flex min-h-[7rem] flex-col justify-center rounded-xl border border-neutral-200 p-4 ' +
    'dark:border-neutral-800';

  return href ? (
    <Link
      href={href}
      className={`${base} transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]`}
    >
      {body}
    </Link>
  ) : (
    <div className={base}>{body}</div>
  );
}

export function Panel({
  title,
  action,
  children,
}: {
  title: string;
  /** Usually a "View all →" link into the page that owns this data. */
  action?: { href: string; label: string };
  children: ReactNode;
}) {
  return (
    /*
     * `min-w-0` is load-bearing, not decoration. A grid item defaults to `min-width: auto`,
     * which means it refuses to shrink below its content — so the 34rem-wide sessions table
     * inside would widen the whole grid column and push the PAGE sideways on a phone, instead
     * of scrolling inside its own `overflow-x-auto`. A browser check caught exactly that.
     */
    <section className="min-w-0 rounded-xl border border-neutral-200 dark:border-neutral-800">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {action && (
          <Link
            href={action.href}
            className="shrink-0 text-xs font-medium text-[var(--accent)] transition-colors hover:text-[var(--accent-hover)]"
          >
            {action.label}
          </Link>
        )}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* The three states every section must handle                                 */
/* -------------------------------------------------------------------------- */

/**
 * A loading placeholder shaped like the content it replaces.
 *
 * A spinner says "something is happening"; a skeleton says "a table is coming, and it will be
 * about this big" — so the layout does not jump when the data lands.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded bg-neutral-200 dark:bg-neutral-800 ${className}`}
    />
  );
}

export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-9 w-full" />
      ))}
    </div>
  );
}

/**
 * "Nothing here" said properly. A blank card is indistinguishable from a broken one.
 *
 * A muted glyph and centred copy — deliberately NOT an illustration, and deliberately never a
 * placeholder number. An empty dashboard should look empty, not look populated with zeros
 * someone might read as data.
 */
export function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
      <IconInbox className="h-5 w-5 text-neutral-400" />
      <p className="max-w-xs text-sm text-neutral-500">{message}</p>
    </div>
  );
}

/** A failure that names what failed and offers the way out, rather than an empty box. */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-lg border border-red-300 bg-red-500/5 p-4 text-sm text-red-700 dark:border-red-900 dark:text-red-400">
      <p>{message}</p>
      {onRetry && (
        <Button variant="danger" size="sm" onClick={onRetry} className="mt-3">
          Try again
        </Button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

/** "3m ago". Used by the activity feed and the sessions table. */
export function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
