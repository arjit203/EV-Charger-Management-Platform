'use client';

/**
 * A line chart, same reasoning as `BarChart` — one `<polyline>` over a handful of points,
 * which is what Module 8's energy curve on the session page already does.
 *
 * The subtlety worth writing down: the series handed to this component is ALREADY
 * ZERO-FILLED by the server. An aggregation returns only the days that had rows, and a line
 * drawn straight from that closes the gaps — three points scattered across a fortnight
 * render as a continuous rising line and read as steady growth. The backend fills every day
 * in the window precisely so this component can stay this simple, and so an empty day is
 * visibly on the floor rather than invisibly absent.
 */

interface Point {
  label: string;
  value: number;
  display: string;
}

export function LineChart({
  points,
  emptyMessage = 'No activity in this period.',
  colorClass = 'text-emerald-600',
}: {
  points: Point[];
  emptyMessage?: string;
  colorClass?: string;
}) {
  const max = Math.max(...points.map((point) => point.value), 0);

  if (points.length < 2 || max === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700">
        <p className="text-sm text-neutral-500">{emptyMessage}</p>
      </div>
    );
  }

  const width = 720;
  const height = 160;
  const padding = 6;
  const step = width / (points.length - 1);

  const coords = points.map((point, index) => {
    const x = index * step;
    const y = height - padding - (point.value / max) * (height - padding * 2);
    return { x, y, point };
  });

  const line = coords.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

  // Closed back along the baseline so the area under the line can be tinted. Purely
  // decorative — the polyline above it is what carries the data.
  const area = `${line} ${width},${height} 0,${height}`;

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className={`h-40 w-full min-w-[420px] ${colorClass}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Line chart, ${points.length} points, peak ${points.find((p) => p.value === max)?.display ?? ''}`}
      >
        <polygon points={area} className="fill-current opacity-10" />
        <polyline
          points={line}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {coords.map(({ x, point }) => (
          // An invisible wide target so a 720-unit-wide chart is still hoverable per day.
          <rect key={point.label} x={x - step / 2} y={0} width={step} height={height} fill="transparent">
            <title>{`${point.label}: ${point.display}`}</title>
          </rect>
        ))}
      </svg>

      <div className="mt-1 flex justify-between text-[11px] text-neutral-400">
        <span>{points[0].label}</span>
        <span>{points[points.length - 1].label}</span>
      </div>
    </div>
  );
}
