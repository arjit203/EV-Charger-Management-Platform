'use client';

/**
 * Pagination for the CMS lists.
 *
 * THE BUG THIS FIXES. Stations, chargers, companies, users, tariffs, sessions and the support
 * queue each fetched ONE page (25–50 rows) and showed "Showing 50 of 55" with no way to reach the
 * rest. The API has always paginated; the screens never asked for page 2. On a real network the
 * 51st station, or any charging session older than the latest 25, was simply unreachable.
 */

import { useState } from 'react';

/**
 * The current page, reset to 1 whenever the filters change.
 *
 * Derived rather than reset in an effect: the page is remembered TOGETHER with the filter key it
 * belongs to, so a new key reads as page 1 on the very render that changes it — no stale fetch of
 * "page 3 of the old filter", and no setState-in-effect cascade.
 */
export function usePage(filterKey: string): [number, (page: number) => void] {
  const [state, setState] = useState({ key: filterKey, page: 1 });
  const page = state.key === filterKey ? state.page : 1;
  return [page, (next: number) => setState({ key: filterKey, page: next })];
}

export function Pager({
  page,
  totalPages,
  total,
  shown,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  /** Rows on this page. */
  shown: number;
  onPage: (page: number) => void;
}) {
  if (total === 0) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-neutral-500">
      <span>
        {totalPages > 1 ? `Page ${page} of ${totalPages} · ` : ''}
        {shown} of {total}
      </span>
      {totalPages > 1 && (
        <span className="flex gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-200 transition-colors hover:bg-neutral-500/10 disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => onPage(page + 1)}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-200 transition-colors hover:bg-neutral-500/10 disabled:opacity-40"
          >
            Next
          </button>
        </span>
      )}
    </div>
  );
}
