'use client';

/**
 * What a detail page shows when its record cannot be loaded.
 *
 * Every detail page used to improvise this — a red strip with the raw API sentence on some, a
 * bold line and a hint on others — so following a stale link looked like a crash. One panel now,
 * centred, that says in plain words what happened and offers the way back.
 *
 * 403 and 404 read the SAME on purpose: "not yours" and "does not exist" are one answer to a
 * company-scoped user, matching the backend, which never confirms another company's record.
 */

import type { ApiClientError } from '@/services/apiClient';
import { ButtonLink } from './Button';

export function LoadError({
  error,
  noun,
  backHref,
  backLabel,
}: {
  error: ApiClientError;
  /** "complaint", "charger"… — used in the heading. */
  noun: string;
  backHref: string;
  backLabel: string;
}) {
  const isUnavailable = error.status === 403 || error.status === 404;

  return (
    <div className="mx-auto mt-10 w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 text-center">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--surface-muted)] text-lg text-[var(--muted)]">
        {isUnavailable ? '?' : '!'}
      </div>
      <h1 className="text-base font-semibold">
        {isUnavailable ? `This ${noun} isn't available` : `Couldn't load this ${noun}`}
      </h1>
      <p className="mt-1.5 text-sm text-[var(--muted)]">
        {isUnavailable
          ? `It may have been removed, or it belongs to a different company than yours.`
          : error.message || 'Please try again in a moment.'}
      </p>
      <div className="mt-5">
        <ButtonLink href={backHref} variant="secondary">
          {backLabel}
        </ButtonLink>
      </div>
    </div>
  );
}
