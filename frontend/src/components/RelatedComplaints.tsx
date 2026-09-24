'use client';

/**
 * The tickets about ONE asset, shown on that asset's page.
 *
 * Tickets already link to their charger and station; this is the way back. An operator opening a
 * charger to fix it should see "3 complaints, 1 still open" there, not have to remember to search
 * the queue — and a charger that keeps drawing complaints is the one that needs replacing.
 */

import { useCallback } from 'react';

import { ComplaintRow } from '@/components/ComplaintSummary';
import { useAsyncData } from '@/hooks/useAsyncData';
import { listComplaints } from '@/services/complaint.service';

export function RelatedComplaints({
  filter,
  label,
}: {
  filter: { chargerId: string } | { stationId: string };
  label: string;
}) {
  const key = 'chargerId' in filter ? filter.chargerId : filter.stationId;
  const load = useCallback(
    () => listComplaints({ ...filter, limit: 5 }),
    // `filter` is a fresh object each render; the id is what identifies it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  const { state } = useAsyncData(load);

  if (state.status !== 'ok') return null;
  const { items, total } = state.data;
  const open = items.filter((c) => c.status === 'open' || c.status === 'in_progress').length;

  return (
    <section className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
      <h2 className="text-sm font-semibold">
        Complaints about this {label}
        <span className="ml-2 font-normal text-neutral-500">
          {total === 0 ? 'none' : `${total} total${open > 0 ? ` · ${open} of the latest still open` : ''}`}
        </span>
      </h2>
      {items.length > 0 && (
        <div className="mt-3 space-y-2">
          {items.map((complaint) => (
            <ComplaintRow key={complaint.id} complaint={complaint} showPriority />
          ))}
        </div>
      )}
    </section>
  );
}
