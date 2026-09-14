'use client';

/**
 * The list panel beside the map.
 *
 * Deliberately knows nothing about Leaflet. It receives stations and a selected id, and
 * reports clicks upward — so the page owns ONE piece of selection state that both panes
 * read, rather than the list and the map each keeping a copy that can drift.
 *
 * The one piece of real behaviour here is `scrollIntoView`: when a marker is clicked on the
 * map, the corresponding row may be far down a scrolled list, and "the map selected
 * something you cannot see" is the failure this prevents.
 */

import { useEffect, useRef } from 'react';

import type { AnyMapStation } from '@/types/api';
import { StatusBadge } from '@/components/StatusBadge';
import { hasUsableCoordinates } from './coordinates';

export function StationList({
  stations,
  selectedId,
  onSelect,
  emptyMessage,
}: {
  stations: AnyMapStation[];
  selectedId: string | null;
  onSelect: (stationId: string) => void;
  emptyMessage: string;
}) {
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // `nearest` rather than `center`: it only scrolls when the row is actually off-screen,
    // so clicking a row that is already visible does not jolt the panel.
    selectedRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedId]);

  if (stations.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-center text-sm text-neutral-500">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
      {stations.map((station) => {
        const isSelected = station.id === selectedId;
        const placeable = hasUsableCoordinates(station);

        return (
          <li key={station.id}>
            <button
              ref={isSelected ? selectedRef : undefined}
              type="button"
              onClick={() => onSelect(station.id)}
              aria-current={isSelected}
              className={`block w-full px-4 py-3 text-left transition-colors ${
                isSelected
                  ? 'bg-blue-500/10 ring-1 ring-inset ring-blue-500/40'
                  : 'hover:bg-neutral-500/5'
              }`}
            >
              <p className="text-sm font-medium">{station.name}</p>
              <p className="mt-0.5 text-xs text-neutral-500">
                {station.address}, {station.city}
              </p>

              <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs">
                <StatusBadge status={station.status} size="sm" />
                <span className="text-neutral-500">
                  {station.totalConnectors === 0
                    ? 'no connectors'
                    : `${station.availableConnectors}/${station.totalConnectors} available`}
                </span>
              </p>

              {/*
                * A station with no usable coordinates is STILL LISTED, with a badge — it is
                * simply absent from the map. Hiding it entirely would be worse: an admin
                * could never find the record in order to fix the thing that is wrong with it.
                */}
              {!placeable && (
                <p className="mt-1.5 inline-block rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-500">
                  Location not set — not shown on map
                </p>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
