'use client';

/**
 * A bar chart in about forty lines of SVG. NO CHARTING LIBRARY.
 *
 * That is a deliberate dependency decision, not laziness. The frontend's entire dependency
 * list is `next`, `react`, `react-dom` and `socket.io-client`; a charting library would be
 * the largest thing in it, added to draw four charts whose hardest requirement is "a
 * rectangle proportional to a number". Module 8 already set the precedent with the inline
 * energy curve on the session page.
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
  /** What to show in the tooltip and, for the top bar, above the axis. */
  display: string;
}

export function BarChart({
  bars,
  emptyMessage = 'No activity in this period.',
  colorClass = 'fill-emerald-500',
}: {
  bars: Bar[];
  emptyMessage?: string;
  colorClass?: string;
}) {
  const max = Math.max(...bars.map((bar) => bar.value), 0);

  if (bars.length === 0 || max === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700">
        <p className="text-sm text-neutral-500">{emptyMessage}</p>
      </div>
    );
  }

  const width = 720;
  const height = 160;
  const gap = bars.length > 40 ? 0.5 : 2;
  const barWidth = Math.max(1, width / bars.length - gap);

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-40 w-full min-w-[420px]"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Bar chart, ${bars.length} points, peak ${bars.find((b) => b.value === max)?.display ?? ''}`}
      >
        {bars.map((bar, index) => {
          // Every bar with a non-zero value gets at least 2px, so "one session" is visible
          // next to "forty sessions" rather than rounding away to an empty column.
          const barHeight = bar.value === 0 ? 0 : Math.max(2, (bar.value / max) * (height - 4));

          return (
            <rect
              key={bar.label}
              x={index * (barWidth + gap)}
              y={height - barHeight}
              width={barWidth}
              height={barHeight}
              className={colorClass}
              rx={1}
            >
              <title>{`${bar.label}: ${bar.display}`}</title>
            </rect>
          );
        })}
      </svg>

      {/* Only the ends are labelled. Thirty date labels on a 720px axis is not a label. */}
      <div className="mt-1 flex justify-between text-[11px] text-neutral-400">
        <span>{bars[0].label}</span>
        <span>{bars[bars.length - 1].label}</span>
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
