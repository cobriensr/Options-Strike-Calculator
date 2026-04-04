import type { PositionVisualsProps } from './helpers';
import { fmtStrike } from './helpers';

export default function StrikeMap({
  spreads,
  ironCondors,
  hedges,
  nakedPositions,
  spotPrice: rawSpotPrice,
}: Omit<PositionVisualsProps, 'trades' | 'portfolioRisk'>) {
  // Infer spot from position structure when calculator spot is stale
  // (e.g. viewing a past day's CSV while calculator shows today's price)
  const shortPuts: number[] = [];
  const shortCalls: number[] = [];
  for (const s of spreads) {
    if (s.spreadType === 'PUT_CREDIT_SPREAD') {
      shortPuts.push(s.shortLeg.strike);
    } else {
      shortCalls.push(s.shortLeg.strike);
    }
  }
  for (const ic of ironCondors) {
    shortPuts.push(ic.putSpread.shortLeg.strike);
    shortCalls.push(ic.callSpread.shortLeg.strike);
  }

  let spotPrice = rawSpotPrice;
  if (shortPuts.length > 0 || shortCalls.length > 0) {
    const highPut = shortPuts.length > 0 ? Math.max(...shortPuts) : null;
    const lowCall = shortCalls.length > 0 ? Math.min(...shortCalls) : null;
    const inferred =
      highPut != null && lowCall != null
        ? (highPut + lowCall) / 2
        : highPut != null
          ? highPut + 30
          : lowCall! - 30;
    // Use inferred if calculator spot is >2% away
    const deviation = Math.abs(rawSpotPrice - inferred) / inferred;
    if (deviation > 0.02) {
      spotPrice = inferred;
    }
  }

  // Collect all strikes to determine range
  const allStrikes: number[] = [];
  for (const s of spreads) {
    allStrikes.push(s.shortLeg.strike, s.longLeg.strike);
  }
  for (const ic of ironCondors) {
    allStrikes.push(
      ic.putSpread.shortLeg.strike,
      ic.putSpread.longLeg.strike,
      ic.callSpread.shortLeg.strike,
      ic.callSpread.longLeg.strike,
    );
  }
  for (const h of hedges) allStrikes.push(h.leg.strike);
  for (const n of nakedPositions) allStrikes.push(n.leg.strike);

  if (allStrikes.length === 0) {
    return (
      <div className="text-muted py-4 text-center text-xs">
        No positions to map.
      </div>
    );
  }

  const minStrike = Math.min(...allStrikes, spotPrice);
  const maxStrike = Math.max(...allStrikes, spotPrice);
  const pad = (maxStrike - minStrike) * 0.08 || 20;
  const lo = minStrike - pad;
  const hi = maxStrike + pad;
  const range = hi - lo;

  const W = 800;
  const PAD_L = 4;
  const PAD_R = 4;
  const plotW = W - PAD_L - PAD_R;
  const toX = (strike: number) => PAD_L + ((strike - lo) / range) * plotW;

  const spotX = toX(spotPrice);

  // Build spread bars
  type SpreadBar = {
    id: string;
    shortStrike: number;
    longStrike: number;
    type: 'PCS' | 'CCS' | 'IC_PUT' | 'IC_CALL';
    contracts: number;
    breakeven?: number;
  };

  const bars: SpreadBar[] = [];
  for (let si = 0; si < spreads.length; si++) {
    const s = spreads[si]!;
    bars.push({
      id: `s-${si}-${s.shortLeg.strike}-${s.longLeg.strike}`,
      shortStrike: s.shortLeg.strike,
      longStrike: s.longLeg.strike,
      type: s.spreadType === 'PUT_CREDIT_SPREAD' ? 'PCS' : 'CCS',
      contracts: s.contracts,
      breakeven: s.breakeven,
    });
  }
  for (let ici = 0; ici < ironCondors.length; ici++) {
    const ic = ironCondors[ici]!;
    bars.push(
      {
        id: `ic-p-${ici}-${ic.putSpread.shortLeg.strike}`,
        shortStrike: ic.putSpread.shortLeg.strike,
        longStrike: ic.putSpread.longLeg.strike,
        type: 'IC_PUT',
        contracts: ic.contracts,
        breakeven: ic.breakevenLow,
      },
      {
        id: `ic-c-${ici}-${ic.callSpread.shortLeg.strike}`,
        shortStrike: ic.callSpread.shortLeg.strike,
        longStrike: ic.callSpread.longLeg.strike,
        type: 'IC_CALL',
        contracts: ic.contracts,
        breakeven: ic.breakevenHigh,
      },
    );
  }

  // Stack bars vertically
  const barH = 22;
  const gap = 5;
  const barsStartY = 46;
  const axisY = barsStartY + bars.length * (barH + gap) + 16;
  const totalH = axisY + 24;

  return (
    <svg
      viewBox={`0 0 ${W} ${totalH}`}
      className="h-auto w-full"
      role="img"
      aria-label="Strike position map"
    >
      {/* Spot price label + vertical line */}
      <text
        x={spotX}
        y={18}
        textAnchor="middle"
        fill="var(--color-accent)"
        fontSize="14"
        fontWeight="700"
        fontFamily="var(--font-mono)"
      >
        SPX {fmtStrike(spotPrice)}
      </text>
      <line
        x1={spotX}
        y1={24}
        x2={spotX}
        y2={axisY}
        stroke="var(--color-accent)"
        strokeWidth="2"
        strokeDasharray="4 3"
      />

      {/* Spread bars */}
      {bars.map((bar, i) => {
        const y = barsStartY + i * (barH + gap);
        const x1 = toX(Math.min(bar.shortStrike, bar.longStrike));
        const x2 = toX(Math.max(bar.shortStrike, bar.longStrike));
        const w = Math.max(x2 - x1, 2);

        const isPut = bar.type === 'PCS' || bar.type === 'IC_PUT';
        const fillColor = isPut
          ? 'var(--color-danger)'
          : 'var(--color-success)';
        const fillOpacity = bar.type.startsWith('IC') ? '0.35' : '0.5';

        return (
          <g key={bar.id}>
            {/* Bar body */}
            <rect
              x={x1}
              y={y}
              width={w}
              height={barH}
              rx={3}
              fill={fillColor}
              opacity={fillOpacity}
              stroke={fillColor}
              strokeWidth="1"
              strokeOpacity="0.7"
            />
            {/* Short strike marker */}
            <line
              x1={toX(bar.shortStrike)}
              y1={y - 1}
              x2={toX(bar.shortStrike)}
              y2={y + barH + 1}
              stroke={fillColor}
              strokeWidth="2.5"
            />
            {/* Label */}
            <text
              x={x1 + w / 2}
              y={y + barH / 2 + 3.5}
              textAnchor="middle"
              fill="var(--color-primary)"
              fontSize="12"
              fontWeight="600"
              fontFamily="var(--font-mono)"
            >
              {fmtStrike(bar.shortStrike)}/{fmtStrike(bar.longStrike)}{' '}
              {isPut ? 'P' : 'C'} x{bar.contracts}
            </text>
            {/* Breakeven tick */}
            {bar.breakeven != null && (
              <line
                x1={toX(bar.breakeven)}
                y1={y - 2}
                x2={toX(bar.breakeven)}
                y2={y + barH + 2}
                stroke="var(--color-caution)"
                strokeWidth="1"
                strokeDasharray="2 2"
              />
            )}
          </g>
        );
      })}

      {/* Hedge markers */}
      {hedges.map((h) => (
        <g key={`hedge-${h.leg.strike}-${h.leg.type}`}>
          <circle
            cx={toX(h.leg.strike)}
            cy={axisY - 6}
            r="10"
            fill="var(--color-accent)"
            opacity="0.25"
          />
          <circle
            cx={toX(h.leg.strike)}
            cy={axisY - 6}
            r="6"
            fill="var(--color-accent)"
            opacity="0.7"
          />
          <text
            x={toX(h.leg.strike)}
            y={axisY - 20}
            textAnchor="middle"
            fill="var(--color-accent)"
            fontSize="11"
            fontWeight="700"
            fontFamily="var(--font-mono)"
          >
            H {fmtStrike(h.leg.strike)}
          </text>
        </g>
      ))}

      {/* Naked markers */}
      {nakedPositions.map((n) => (
        <g key={`naked-${n.leg.strike}-${n.leg.type}`}>
          <circle
            cx={toX(n.leg.strike)}
            cy={axisY - 6}
            r="10"
            fill="var(--color-danger)"
            opacity="0.25"
          />
          <circle
            cx={toX(n.leg.strike)}
            cy={axisY - 6}
            r="6"
            fill="var(--color-danger)"
          />
          <text
            x={toX(n.leg.strike)}
            y={axisY - 20}
            textAnchor="middle"
            fill="var(--color-danger)"
            fontSize="11"
            fontWeight="700"
            fontFamily="var(--font-mono)"
          >
            ! {fmtStrike(n.leg.strike)}
          </text>
        </g>
      ))}

      {/* Axis line */}
      <line
        x1={PAD_L}
        y1={axisY}
        x2={W - PAD_R}
        y2={axisY}
        stroke="var(--color-edge)"
        strokeWidth="1"
      />
      {/* Axis labels — lo and hi */}
      <text
        x={PAD_L}
        y={axisY + 14}
        fill="var(--color-muted)"
        fontSize="12"
        fontFamily="var(--font-mono)"
      >
        {fmtStrike(Math.round(lo))}
      </text>
      <text
        x={W - PAD_R}
        y={axisY + 14}
        textAnchor="end"
        fill="var(--color-muted)"
        fontSize="12"
        fontFamily="var(--font-mono)"
      >
        {fmtStrike(Math.round(hi))}
      </text>
    </svg>
  );
}
