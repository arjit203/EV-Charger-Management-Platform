'use client';

import { useState } from 'react';

/**
 * Bar charts in plain HTML. NO CHARTING LIBRARY.
 *
 * That is a deliberate dependency decision, not laziness. The frontend's entire dependency
 * list is `next`, `react`, `react-dom` and `socket.io-client`; a charting library would be
 * the largest thing in it, added to draw four charts whose hardest requirement is "a
 * rectangle proportional to a number".
 *
 * What would change the answer: axes that pan and zoom, tooltips that track the cursor, or
 * stacked/overlaid series. At that point a library is doing real work. Until then it is
 * weight, a bundle cost and an upgrade obligation bought for nothing.
 *
 * The one thing done carefully here is the EMPTY STATE. A chart whose bars are all zero
 * renders as a flat axis, which looks identical to a chart that failed to load — so it says
 * so in words instead.
 */

interface Bar {
  label: string;
  value: number;
  /** What to show in the tooltip, e.g. "4 sessions". */
  display: string;
}

/** A round axis maximum — 7 sessions gets an axis to 8, not to 7.000. */
function niceMax(value: number): number {
  if (value <= 5) return Math.max(1, Math.ceil(value));
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((m) => value <= m * magnitude) ?? 10;
  return step * magnitude;
}

/**
 * Vertical bars over time, drawn as HTML rather than a stretched SVG.
 *
 * THE BUG THIS REPLACES. The old version drew into a 720-unit SVG with
 * `preserveAspectRatio="none"` and no axis. With a 30-day window and activity on only two
 * adjacent days, it rendered as two tall, fused rectangles and nothing else — no scale, no dates
 * under them, no way to tell "2 sessions" from "200". It looked broken because it communicated
 * nothing.
 *
 * Now: a y-axis with round gridlines so height means a number; bars capped in width so a sparse
 * month reads as a sparse month instead of two slabs; a 2px gap so neighbours never merge; a date
 * label every week; a hover readout for the exact value; and a one-line summary on top, because
 * the total and the busiest day are what someone glancing at a dashboard actually wants.
 */
export function BarChart({
  bars,
  emptyMessage = 'No activity in this period.',
  colorClass = 'bg-emerald-500',
  unit = 'total',
}: {
  bars: Bar[];
  emptyMessage?: string;
  /** A Tailwind background class for the bars. */
  colorClass?: string;
  /** Word for the summary line, e.g. "sessions". */
  unit?: string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(...bars.map((bar) => bar.value), 0);

  if (bars.length === 0 || max === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700">
        <p className="text-sm text-neutral-500">{emptyMessage}</p>
      </div>
    );
  }

  const top = niceMax(max);
  const ticks = [top, top / 2, 0];
  const total = bars.reduce((sum, bar) => sum + bar.value, 0);
  const busiest = bars.reduce((best, bar) => (bar.value > best.value ? bar : best), bars[0]);
  const activeDays = bars.filter((bar) => bar.value > 0).length;
  // A label roughly every week, plus the last day, so dates never collide.
  const labelEvery = Math.max(1, Math.ceil(bars.length / 5));
  const readout = hovered === null ? null : bars[hovered];

  return (
    <div>
      <p className="mb-3 flex flex-wrap items-baseline justify-between gap-2 text-xs text-neutral-500">
        <span>
          <span className="text-base font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">
            {total.toLocaleString('en-IN')}
          </span>{' '}
          {unit} · active on {activeDays} of {bars.length} days · busiest {busiest.label} (
          {busiest.display})
        </span>
        <span className="tabular-nums" aria-live="polite">
          {readout ? `${readout.label}: ${readout.display}` : 'Hover a bar for the day'}
        </span>
      </p>

      <div className="flex gap-2">
        {/* y-axis labels */}
        <div className="flex h-40 flex-col justify-between text-right text-[11px] tabular-nums text-neutral-400">
          {ticks.map((tick) => (
            <span key={tick} className="-translate-y-1/2 first:translate-y-0 last:translate-y-0">
              {Number.isInteger(tick) ? tick : tick.toFixed(1)}
            </span>
          ))}
        </div>

        <div className="min-w-0 flex-1">
          <div className="relative h-40">
            {/* recessive gridlines */}
            {ticks.map((tick) => (
              <div
                key={tick}
                className="absolute inset-x-0 border-t border-neutral-200 dark:border-neutral-800"
                style={{ bottom: `${(tick / top) * 100}%` }}
              />
            ))}

            <div
              className="absolute inset-0 flex items-end gap-[2px]"
              role="img"
              aria-label={`${total} ${unit} over ${bars.length} days; busiest ${busiest.label} with ${busiest.display}`}
            >
              {bars.map((bar, index) => (
                <div
                  key={bar.label}
                  className="flex h-full flex-1 items-end justify-center"
                  onMouseEnter={() => setHovered(index)}
                  onMouseLeave={() => setHovered(null)}
                  title={`${bar.label}: ${bar.display}`}
                >
                  {bar.value > 0 && (
                    <div
                      className={`w-full max-w-[18px] rounded-t-[4px] ${colorClass} transition-opacity ${
                        hovered !== null && hovered !== index ? 'opacity-50' : ''
                      }`}
                      // At least 3px, so one session is visible beside forty.
                      style={{ height: `max(3px, ${(bar.value / top) * 100}%)` }}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="mt-1 flex gap-[2px] text-[11px] text-neutral-400">
            {bars.map((bar, index) => (
              <span key={bar.label} className="flex-1 overflow-visible whitespace-nowrap text-center">
                {index % labelEvery === 0 || index === bars.length - 1 ? bar.label : ''}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Horizontal bars, for a leaderboard where the labels are names rather than dates.
 *
 * A separate component rather than an `orientation` prop: the two share an idea but almost
 * no markup, and a prop that swaps every x for a y produces a component that is harder to
 * read than both of them written out.
 */
export function HorizontalBarChart({
  bars,
  emptyMessage = 'Nothing to rank yet.',
}: {
  bars: Bar[];
  emptyMessage?: string;
}) {
  const max = Math.max(...bars.map((bar) => bar.value), 0);

  if (bars.length === 0 || max === 0) {
    return (
      <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700">
        <p className="text-sm text-neutral-500">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <ul className="space-y-2.5">
      {bars.map((bar) => (
        <li key={bar.label}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate font-medium">{bar.label}</span>
            <span className="shrink-0 tabular-nums text-neutral-500">{bar.display}</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
            <div
              className="h-full rounded-full bg-emerald-500"
              style={{ width: `${Math.max(2, (bar.value / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
