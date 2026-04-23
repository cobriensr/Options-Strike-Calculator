import type { DailyProgramSummary } from '../../hooks/useInstitutionalProgram.js';

interface Props {
  days: DailyProgramSummary[];
}

/**
 * Line chart of ceiling_pct_above_spot over the selected window.
 * Pure inline SVG — matches the bundle-lean conventions of
 * RegimeTimeline, CreditTimeChart, and ThetaDecayChart.
 */
export function CeilingChart({ days }: Props) {
  const valid = days.filter(
    (d): d is DailyProgramSummary & { ceiling_pct_above_spot: number } =>
      d.ceiling_pct_above_spot != null,
  );

  if (valid.length < 2) {
    return (
      <div className="text-xs text-slate-500">
        Ceiling chart unavailable — need at least 2 days of ceiling-track blocks
        (have {valid.length}).
      </div>
    );
  }

  const values = valid.map((d) => d.ceiling_pct_above_spot);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const W = 600;
  const H = 200;
  const padL = 44;
  const padR = 16;
  const padT = 20;
  const padB = 28;

  const toX = (i: number) =>
    padL + (i / Math.max(valid.length - 1, 1)) * (W - padL - padR);
  const toY = (v: number) => padT + (1 - (v - min) / range) * (H - padT - padB);

  const points = valid.map((d, i) => ({
    x: toX(i),
    y: toY(d.ceiling_pct_above_spot),
    d,
  }));
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');

  // Grid lines at min, median, max.
  const mid = (min + max) / 2;
  const gridLines = [
    { v: max, label: `${(max * 100).toFixed(1)}%` },
    { v: mid, label: `${(mid * 100).toFixed(1)}%` },
    { v: min, label: `${(min * 100).toFixed(1)}%` },
  ];

  return (
    <figure
      className="border-edge bg-surface-alt rounded-lg border p-3"
      aria-labelledby="ceiling-chart-caption"
    >
      <figcaption
        id="ceiling-chart-caption"
        className="mb-2 text-xs text-slate-400"
      >
        Ceiling % above spot (avg program strike ÷ spot − 1) — over{' '}
        {valid.length} trading days
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Ceiling percentage across ${valid.length} days, range ${(min * 100).toFixed(1)}% to ${(max * 100).toFixed(1)}%`}
        className="block w-full"
      >
        {/* Y-axis grid */}
        {gridLines.map((g, i) => (
          <g key={i}>
            <line
              x1={padL}
              y1={toY(g.v)}
              x2={W - padR}
              y2={toY(g.v)}
              stroke="var(--color-border, #334155)"
              strokeWidth="0.5"
              strokeDasharray="2 3"
            />
            <text
              x={padL - 6}
              y={toY(g.v) + 3}
              textAnchor="end"
              fontSize="10"
              fill="var(--color-text-muted, #94a3b8)"
              fontFamily="var(--font-mono)"
            >
              {g.label}
            </text>
          </g>
        ))}
        {/* Line */}
        <path
          d={path}
          fill="none"
          stroke="var(--color-accent, #60a5fa)"
          strokeWidth="1.5"
        />
        {/* Points with tooltip titles */}
        {points.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={2.5}
            fill="var(--color-accent, #60a5fa)"
          >
            <title>{`${p.d.date}: ${(p.d.ceiling_pct_above_spot * 100).toFixed(2)}% (spot ${p.d.avg_spot?.toFixed(0) ?? 'n/a'})`}</title>
          </circle>
        ))}
        {/* X-axis endpoint labels */}
        <text
          x={toX(0)}
          y={H - 8}
          textAnchor="start"
          fontSize="10"
          fill="var(--color-text-muted, #94a3b8)"
          fontFamily="var(--font-mono)"
        >
          {valid[0]!.date}
        </text>
        <text
          x={toX(valid.length - 1)}
          y={H - 8}
          textAnchor="end"
          fontSize="10"
          fill="var(--color-text-muted, #94a3b8)"
          fontFamily="var(--font-mono)"
        >
          {valid[valid.length - 1]!.date}
        </text>
      </svg>
    </figure>
  );
}
