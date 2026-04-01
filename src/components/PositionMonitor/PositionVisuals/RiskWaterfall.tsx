import type { HedgePosition, IronCondor, Spread } from '../types';
import { fmtK, fmtStrike } from './helpers';

export default function RiskWaterfall({
  spreads,
  ironCondors,
  hedges,
}: {
  spreads: readonly Spread[];
  ironCondors: readonly IronCondor[];
  hedges: readonly HedgePosition[];
}) {
  // Build segments: each spread/IC contributes, hedges subtract
  type Segment = {
    label: string;
    value: number;
    color: string;
    isHedge: boolean;
  };

  const segments: Segment[] = [];

  for (const ic of ironCondors) {
    segments.push({
      label: `IC ${fmtStrike(ic.putSpread.shortLeg.strike)}/${fmtStrike(ic.callSpread.shortLeg.strike)}`,
      value: ic.maxLoss,
      color: 'var(--color-chart-purple)',
      isHedge: false,
    });
  }
  for (const s of spreads) {
    const isPut = s.spreadType === 'PUT_CREDIT_SPREAD';
    segments.push({
      label: `${isPut ? 'P' : 'C'} ${fmtStrike(s.shortLeg.strike)}/${fmtStrike(s.longLeg.strike)}`,
      value: s.maxLoss,
      color: isPut ? 'var(--color-danger)' : 'var(--color-success)',
      isHedge: false,
    });
  }
  for (const h of hedges) {
    segments.push({
      label: `Hedge ${fmtStrike(h.leg.strike)}${h.leg.type[0]}`,
      value: -h.entryCost,
      color: 'var(--color-accent)',
      isHedge: true,
    });
  }

  if (segments.length === 0) {
    return (
      <div className="text-muted py-4 text-center text-xs">
        No risk to display.
      </div>
    );
  }

  // Scale bars relative to the largest individual segment
  const maxVal = Math.max(...segments.map((s) => Math.abs(s.value))) || 1;
  const W = 800;
  const barH = 26;
  const gap = 8;
  const labelW = 180;
  const barAreaW = W - labelW - 80;
  const totalH = segments.length * (barH + gap) + 4;

  const toW = (v: number) => (Math.abs(v) / maxVal) * barAreaW;

  return (
    <svg
      viewBox={`0 0 ${W} ${totalH}`}
      className="h-auto w-full"
      role="img"
      aria-label="Risk waterfall"
    >
      {segments.map((seg, i) => {
        const y = i * (barH + gap) + 4;
        const w = Math.max(toW(seg.value), 2);

        return (
          <g key={`${seg.label}-${String(i)}`}>
            {/* Label */}
            <text
              x={labelW - 6}
              y={y + barH / 2 + 4}
              textAnchor="end"
              fill="var(--color-secondary)"
              fontSize="12"
              fontFamily="var(--font-mono)"
            >
              {seg.label}
            </text>
            {/* Bar */}
            <rect
              x={labelW}
              y={y}
              width={w}
              height={barH}
              rx={4}
              fill={seg.color}
              opacity={seg.isHedge ? 0.5 : 0.7}
            />
            {/* Diagonal hatch for hedges */}
            {seg.isHedge && (
              <rect
                x={labelW}
                y={y}
                width={w}
                height={barH}
                rx={4}
                fill="url(#hedge-hatch)"
              />
            )}
            {/* Value */}
            <text
              x={labelW + w + 6}
              y={y + barH / 2 + 4}
              fill={
                seg.isHedge ? 'var(--color-accent)' : 'var(--color-secondary)'
              }
              fontSize="12"
              fontWeight="600"
              fontFamily="var(--font-mono)"
            >
              {seg.isHedge ? '-' : ''}
              {fmtK(Math.abs(seg.value))}
            </text>
          </g>
        );
      })}

      <defs>
        <pattern
          id="hedge-hatch"
          patternUnits="userSpaceOnUse"
          width="6"
          height="6"
        >
          <path
            d="M0,6 L6,0"
            stroke="var(--color-accent)"
            strokeWidth="1"
            opacity="0.3"
          />
        </pattern>
      </defs>
    </svg>
  );
}
