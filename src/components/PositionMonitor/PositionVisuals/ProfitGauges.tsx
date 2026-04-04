import type { IronCondor, Spread } from '../types';
import { fmtK, fmtStrike } from './helpers';

export default function ProfitGauges({
  spreads,
  ironCondors,
}: Readonly<{
  spreads: readonly Spread[];
  ironCondors: readonly IronCondor[];
}>) {
  type GaugeData = {
    label: string;
    pct: number | null;
    credit: number;
    type: 'PCS' | 'CCS' | 'IC';
  };

  const gauges: GaugeData[] = [];

  for (const ic of ironCondors) {
    // IC pct: average of both wings, or null
    const putPct = ic.putSpread.pctOfMaxProfit;
    const callPct = ic.callSpread.pctOfMaxProfit;
    const pct =
      putPct != null && callPct != null
        ? (putPct + callPct) / 2
        : (putPct ?? callPct);
    gauges.push({
      label: `${fmtStrike(ic.putSpread.shortLeg.strike)}p/${fmtStrike(ic.callSpread.shortLeg.strike)}c`,
      pct,
      credit: ic.totalCredit,
      type: 'IC',
    });
  }
  for (const s of spreads) {
    gauges.push({
      label: `${fmtStrike(s.shortLeg.strike)}/${fmtStrike(s.longLeg.strike)}${s.spreadType === 'PUT_CREDIT_SPREAD' ? 'p' : 'c'}`,
      pct: s.pctOfMaxProfit,
      credit: s.creditReceived,
      type: s.spreadType === 'PUT_CREDIT_SPREAD' ? 'PCS' : 'CCS',
    });
  }

  if (gauges.length === 0) {
    return (
      <div className="text-muted py-4 text-center text-xs">
        No positions for profit tracking.
      </div>
    );
  }

  // Arc gauge constants
  const size = 96;
  const cx = size / 2;
  const cy = size / 2 + 6;
  const r = 36;
  const strokeW = 8;
  // Arc from -180 to 0 (bottom half = half circle)
  const startAngle = Math.PI;
  const endAngle = 0;
  const arcLen = Math.PI * r;

  const arcPath = (fromA: number, toA: number) => {
    const x1 = cx + r * Math.cos(fromA);
    const y1 = cy + r * Math.sin(fromA);
    const x2 = cx + r * Math.cos(toA);
    const y2 = cy + r * Math.sin(toA);
    const sweep = toA > fromA ? 0 : 1;
    return `M${x1},${y1} A${r},${r} 0 0 ${sweep} ${x2},${y2}`;
  };

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {gauges.map((g, i) => {
        const pct = g.pct != null ? Math.max(0, Math.min(100, g.pct)) : null;
        const filled = pct != null ? (pct / 100) * arcLen : 0;
        const pctColor =
          pct == null
            ? 'var(--color-muted)'
            : pct >= 80
              ? 'var(--color-success)'
              : pct >= 40
                ? 'var(--color-caution)'
                : 'var(--color-danger)';

        return (
          <div
            key={`${g.label}-${String(i)}`}
            className="flex flex-col items-center"
          >
            <svg
              viewBox={`0 0 ${size} ${size / 2 + 16}`}
              width={size}
              height={size / 2 + 16}
            >
              {/* Background arc */}
              <path
                d={arcPath(startAngle, endAngle)}
                fill="none"
                stroke="var(--color-edge)"
                strokeWidth={strokeW}
                strokeLinecap="round"
              />
              {/* Filled arc */}
              {pct != null && pct > 0 && (
                <path
                  d={arcPath(startAngle, endAngle)}
                  fill="none"
                  stroke={pctColor}
                  strokeWidth={strokeW}
                  strokeLinecap="round"
                  strokeDasharray={`${filled} ${arcLen}`}
                />
              )}
              {/* Center text */}
              <text
                x={cx}
                y={cy - 4}
                textAnchor="middle"
                fill={pctColor}
                fontSize="17"
                fontWeight="700"
                fontFamily="var(--font-mono)"
              >
                {pct != null ? `${Math.round(pct)}%` : '\u2014'}
              </text>
            </svg>
            <div className="text-secondary mt-1 text-center font-mono text-xs leading-tight font-semibold">
              {g.label}
            </div>
            <div className="text-muted font-mono text-[10px]">
              {fmtK(g.credit)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
