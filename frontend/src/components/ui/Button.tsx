'use client';

/**
 * The one button in the application.
 *
 * WHY THIS EXISTS. Before this pass, 32 files hand-wrote their own button classes, and a scan
 * turned up six near-identical variants differing only in padding or a missing `font-medium`:
 *
 *   rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium transition-colors …
 *   rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium …          (no transition)
 *   rounded-lg border border-neutral-300 bg-transparent px-2.5 py-1.5 text-sm …     (different padding)
 *
 * Nobody chose those differences; they accumulated. One component means one place to change
 * the padding, and no way for the next page to drift again.
 *
 * FOUR VARIANTS, EACH WITH A JOB — no decorative ones:
 *
 *   primary    the single most likely action on a screen. Accent-filled.
 *   secondary  everything else. Outlined, the workhorse.
 *   danger     destructive and irreversible. Red, so it cannot be clicked absent-mindedly.
 *   ghost      tertiary — toolbar and inline actions that should not compete for attention.
 */

import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md';

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

const SIZES: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-sm',
};

/*
 * `bg-[var(--accent)]` rather than a Tailwind palette class, so the accent is changeable in
 * exactly one place (globals.css) rather than by a find-and-replace across the codebase.
 */
const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--accent)] text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] ' +
    'border border-transparent',
  secondary:
    'border border-neutral-300 text-neutral-800 hover:bg-neutral-500/10 ' +
    'dark:border-neutral-700 dark:text-neutral-200',
  danger:
    'border border-red-300 text-red-700 hover:bg-red-500/10 ' +
    'dark:border-red-900 dark:text-red-400',
  ghost:
    'border border-transparent text-neutral-600 hover:bg-neutral-500/10 ' +
    'dark:text-neutral-300',
};

export function buttonClasses(
  variant: ButtonVariant = 'secondary',
  size: ButtonSize = 'sm',
  extra = '',
): string {
  return `${BASE} ${SIZES[size]} ${VARIANTS[variant]} ${extra}`.trim();
}

interface ButtonOwnProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'sm',
  className = '',
  children,
  ...rest
}: ButtonOwnProps & ComponentProps<'button'>) {
  return (
    <button {...rest} className={buttonClasses(variant, size, className)}>
      {children}
    </button>
  );
}

/**
 * A link that looks like a button.
 *
 * A separate component rather than an `as` prop: a navigation target and an action are
 * different things to a screen reader and to the browser, and blurring them behind one
 * component is how an anchor ends up with an `onClick` and no `href`.
 */
export function ButtonLink({
  variant = 'secondary',
  size = 'sm',
  className = '',
  children,
  ...rest
}: ButtonOwnProps & ComponentProps<typeof Link>) {
  return (
    <Link {...rest} className={buttonClasses(variant, size, className)}>
      {children}
    </Link>
  );
}
