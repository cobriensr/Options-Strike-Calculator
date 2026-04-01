import type { ExecutedTrade } from '../types';
import { fmtTime } from './helpers';

export default function CreditTimeChart({
  trades,
}: {
  trades: readonly ExecutedTrade[];
}) {
  // Filter to TO OPEN trades with positive net credits
  const openTrades = trades.filter(
    (t) => t.legs.some((l) => l.posEffect === 'TO OPEN') && t.netPrice > 0,
  );

  if (openTrades.length === 0) {
    return (
      <div className="text-muted py-4 text-center text-xs">
        No opening trades to chart.
      </div>
    );
  }

  // Parse times to minutes since midnight for positioning
  const parseMin = (t: string): number => {
    const match = t.match(/(\d{1,2}):(\d{2})/);
    if (!match) return 0;
    return Number.parseInt(match[1]!, 10) * 60 + Number.parseInt(match[2]!, 10);
  };

  const entries = openTrades.map((t) => ({
    time: t.execTime,
    minutes: parseMin(t.execTime),
    credit: t.netPrice,
    contracts: Math.abs(t.legs[0]?.qty ?? 1),
    spread: t.spread,
  }));

  const minMin = Math.min(...entries.map((e) => e.minutes));
  const maxMin = Math.max(...entries.map((e) => e.minutes));
  const credits = entries.map((e) => e.credit);
  const minCredit = Math.min(...credits);
  const maxCredit = Math.max(...credits);
  // Minimal padding — just enough to not clip bubble edges
  const creditPad = (maxCredit - minCredit) * 0.05 || 0.02;
  const creditLo = Math.max(0, minCredit - creditPad);
  const creditHi = maxCredit + creditPad;
  const creditRange = creditHi - creditLo;
  const timeRange = maxMin - minMin || 60;

  const W = 800;
  const H = 400;
  const PAD_L = 55;
  const PAD_R = 16;
  const PAD_T = 20;
  const PAD_B = 32;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const toX = (min: number) => PAD_L + ((min - minMin) / timeRange) * plotW;
  const toY = (credit: number) =>
    PAD_T + plotH - ((credit - creditLo) / creditRange) * plotH;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label="Credit received vs entry time"
    >
      {/* Grid lines with Y-axis labels */}
      {[0, 0.25, 0.5, 0.75, 1].map((f) => {
        const val = creditLo + creditRange * f;
        const y = PAD_T + plotH * (1 - f);
        return (
          <g key={f}>
            <line
              x1={PAD_L}
              y1={y}
              x2={W - PAD_R}
              y2={y}
              stroke="var(--color-edge)"
              strokeDasharray="3 6"
              strokeWidth="0.4"
              opacity="0.4"
            />
            <text
              x={PAD_L - 6}
              y={y + 4}
              textAnchor="end"
              fill="var(--color-muted)"
              fontSize="10"
              fontFamily="var(--font-mono)"
            >
              {val.toFixed(2)}
            </text>
          </g>
        );
      })}

      {/* Bubbles — size by contracts */}
      {entries.map((e, i) => {
        const r = 6 + (e.contracts / 20) * 12;
        return (
          <g key={`${e.time}-${i}`}>
            <circle
              cx={toX(e.minutes)}
              cy={toY(e.credit)}
              r={r}
              fill="var(--color-accent)"
              opacity="0.35"
              stroke="var(--color-accent)"
              strokeWidth="1"
              strokeOpacity="0.7"
            />
            <text
              x={toX(e.minutes)}
              y={toY(e.credit) + 3}
              textAnchor="middle"
              fill="var(--color-primary)"
              fontSize="11"
              fontWeight="600"
              fontFamily="var(--font-mono)"
            >
              {e.credit.toFixed(2)}
            </text>
          </g>
        );
      })}

      {/* Axis labels */}
      <text
        x={PAD_L}
        y={H - 3}
        fill="var(--color-muted)"
        fontSize="12"
        fontFamily="var(--font-mono)"
      >
        {fmtTime(entries[0]?.time ?? '')}
      </text>
      <text
        x={W - PAD_R}
        y={H - 3}
        textAnchor="end"
        fill="var(--color-muted)"
        fontSize="12"
        fontFamily="var(--font-mono)"
      >
        {fmtTime(entries.at(-1)?.time ?? '')}
      </text>
      {/* Y axis label */}
      <text
        x={4}
        y={PAD_T + plotH / 2}
        textAnchor="middle"
        fill="var(--color-muted)"
        fontSize="10"
        fontFamily="var(--font-mono)"
        transform={`rotate(-90, 4, ${PAD_T + plotH / 2})`}
      >
        Credit ($)
      </text>
    </svg>
  );
}
