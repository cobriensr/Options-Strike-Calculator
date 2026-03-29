import { useState } from 'react';
import type {
  ExecutedTrade,
  HedgePosition,
  IronCondor,
  NakedPosition,
  PortfolioRisk,
  Spread,
} from './types';

// ── Props ──────────────────────────────────────────────

interface PositionVisualsProps {
  spreads: readonly Spread[];
  ironCondors: readonly IronCondor[];
  hedges: readonly HedgePosition[];
  nakedPositions: readonly NakedPosition[];
  trades: readonly ExecutedTrade[];
  portfolioRisk: PortfolioRisk;
  spotPrice: number;
}

// ── Formatting helpers ─────────────────────────────────

function fmtK(v: number): string {
  if (Math.abs(v) >= 1000) {
    return `$${(v / 1000).toFixed(1)}k`;
  }
  return `$${v.toLocaleString('en-US', {
    maximumFractionDigits: 0,
  })}`;
}

function fmtStrike(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtTime(t: string): string {
  // "3/27/26 09:30:00" → "09:30" or "09:30:00" → "09:30"
  const match = t.match(/(\d{1,2}:\d{2})/);
  return match?.[1] ?? t;
}

// ── Panel 1: Strike Map ────────────────────────────────

function StrikeMap({
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
    const highPut =
      shortPuts.length > 0
        ? Math.max(...shortPuts)
        : null;
    const lowCall =
      shortCalls.length > 0
        ? Math.min(...shortCalls)
        : null;
    const inferred =
      highPut != null && lowCall != null
        ? (highPut + lowCall) / 2
        : highPut != null
          ? highPut + 30
          : lowCall! - 30;
    // Use inferred if calculator spot is >2% away
    const deviation =
      Math.abs(rawSpotPrice - inferred) / inferred;
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

  const W = 560;
  const PAD_L = 4;
  const PAD_R = 4;
  const plotW = W - PAD_L - PAD_R;
  const toX = (strike: number) =>
    PAD_L + ((strike - lo) / range) * plotW;

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
  for (const s of spreads) {
    bars.push({
      id: `s-${s.shortLeg.strike}-${s.longLeg.strike}`,
      shortStrike: s.shortLeg.strike,
      longStrike: s.longLeg.strike,
      type:
        s.spreadType === 'PUT_CREDIT_SPREAD'
          ? 'PCS'
          : 'CCS',
      contracts: s.contracts,
      breakeven: s.breakeven,
    });
  }
  for (const ic of ironCondors) {
    bars.push({
      id: `ic-p-${ic.putSpread.shortLeg.strike}`,
      shortStrike: ic.putSpread.shortLeg.strike,
      longStrike: ic.putSpread.longLeg.strike,
      type: 'IC_PUT',
      contracts: ic.contracts,
      breakeven: ic.breakevenLow,
    });
    bars.push({
      id: `ic-c-${ic.callSpread.shortLeg.strike}`,
      shortStrike: ic.callSpread.shortLeg.strike,
      longStrike: ic.callSpread.longLeg.strike,
      type: 'IC_CALL',
      contracts: ic.contracts,
      breakeven: ic.breakevenHigh,
    });
  }

  // Stack bars vertically
  const barH = 22;
  const gap = 5;
  const barsStartY = 36;
  const axisY = barsStartY + bars.length * (barH + gap) + 10;
  const totalH = axisY + 20;

  return (
    <svg
      viewBox={`0 0 ${W} ${totalH}`}
      className="h-auto w-full"
      role="img"
      aria-label="Strike position map"
    >
      {/* Spot price vertical line */}
      <line
        x1={spotX}
        y1={8}
        x2={spotX}
        y2={axisY}
        stroke="var(--color-accent)"
        strokeWidth="2"
        strokeDasharray="4 3"
      />
      <text
        x={spotX}
        y={6}
        textAnchor="middle"
        fill="var(--color-accent)"
        fontSize="14"
        fontWeight="700"
        fontFamily="var(--font-mono)"
      >
        SPX {fmtStrike(spotPrice)}
      </text>

      {/* Spread bars */}
      {bars.map((bar, i) => {
        const y = barsStartY + i * (barH + gap);
        const x1 = toX(
          Math.min(bar.shortStrike, bar.longStrike),
        );
        const x2 = toX(
          Math.max(bar.shortStrike, bar.longStrike),
        );
        const w = Math.max(x2 - x1, 2);

        const isPut =
          bar.type === 'PCS' || bar.type === 'IC_PUT';
        const fillColor = isPut
          ? 'var(--color-danger)'
          : 'var(--color-success)';
        const fillOpacity =
          bar.type.startsWith('IC') ? '0.35' : '0.5';

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
              {fmtStrike(bar.shortStrike)}/
              {fmtStrike(bar.longStrike)}{' '}
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
            cy={axisY - 4}
            r="5"
            fill="var(--color-accent)"
            opacity="0.6"
          />
          <text
            x={toX(h.leg.strike)}
            y={axisY - 12}
            textAnchor="middle"
            fill="var(--color-accent)"
            fontSize="11"
            fontFamily="var(--font-mono)"
          >
            H
          </text>
        </g>
      ))}

      {/* Naked markers */}
      {nakedPositions.map((n) => (
        <g key={`naked-${n.leg.strike}-${n.leg.type}`}>
          <circle
            cx={toX(n.leg.strike)}
            cy={axisY - 4}
            r="5"
            fill="var(--color-danger)"
          />
          <text
            x={toX(n.leg.strike)}
            y={axisY - 12}
            textAnchor="middle"
            fill="var(--color-danger)"
            fontSize="11"
            fontWeight="700"
            fontFamily="var(--font-mono)"
          >
            !
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

// ── Panel 2: Risk Waterfall ────────────────────────────

function RiskWaterfall({
  spreads,
  ironCondors,
  hedges,
  portfolioRisk,
}: {
  spreads: readonly Spread[];
  ironCondors: readonly IronCondor[];
  hedges: readonly HedgePosition[];
  portfolioRisk: PortfolioRisk;
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
      color: isPut
        ? 'var(--color-danger)'
        : 'var(--color-success)',
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

  const maxVal = portfolioRisk.totalMaxLoss || 1;
  const W = 560;
  const barH = 26;
  const gap = 8;
  const labelW = 160;
  const barAreaW = W - labelW - 60;
  const totalH = segments.length * (barH + gap) + barH + gap + 10;

  const toW = (v: number) =>
    (Math.abs(v) / maxVal) * barAreaW;

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
          <g key={seg.label}>
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
                seg.isHedge
                  ? 'var(--color-accent)'
                  : 'var(--color-secondary)'
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

      {/* Net total */}
      {(() => {
        const y =
          segments.length * (barH + gap) + 4;
        const w = toW(portfolioRisk.totalMaxLoss);
        return (
          <g>
            <line
              x1={labelW}
              y1={y - 2}
              x2={labelW + barAreaW}
              y2={y - 2}
              stroke="var(--color-edge)"
              strokeWidth="0.5"
            />
            <text
              x={labelW - 6}
              y={y + barH / 2 + 4}
              textAnchor="end"
              fill="var(--color-primary)"
              fontSize="12"
              fontWeight="700"
              fontFamily="var(--font-mono)"
            >
              NET MAX LOSS
            </text>
            <rect
              x={labelW}
              y={y}
              width={Math.max(w, 2)}
              height={barH}
              rx={4}
              fill="var(--color-danger)"
              opacity="0.85"
            />
            <text
              x={labelW + w + 6}
              y={y + barH / 2 + 4}
              fill="var(--color-danger)"
              fontSize="13"
              fontWeight="700"
              fontFamily="var(--font-mono)"
            >
              {fmtK(portfolioRisk.totalMaxLoss)}
            </text>
          </g>
        );
      })()}

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

// ── Panel 3: Credit vs Time ────────────────────────────

function CreditTimeChart({
  trades,
}: {
  trades: readonly ExecutedTrade[];
}) {
  // Filter to TO OPEN trades with positive net credits
  const openTrades = trades.filter(
    (t) =>
      t.legs.some((l) => l.posEffect === 'TO OPEN') &&
      t.netPrice > 0,
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
    return (
      Number.parseInt(match[1]!, 10) * 60 +
      Number.parseInt(match[2]!, 10)
    );
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
  const maxCredit = Math.max(...entries.map((e) => e.credit));
  const timeRange = maxMin - minMin || 60;

  const W = 560;
  const H = 130;
  const PAD_L = 8;
  const PAD_R = 8;
  const PAD_T = 12;
  const PAD_B = 20;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const toX = (min: number) =>
    PAD_L + ((min - minMin) / timeRange) * plotW;
  const toY = (credit: number) =>
    PAD_T + plotH - (credit / maxCredit) * plotH;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label="Credit received vs entry time"
    >
      {/* Grid lines */}
      {[0.25, 0.5, 0.75].map((f) => (
        <line
          key={f}
          x1={PAD_L}
          y1={PAD_T + plotH * (1 - f)}
          x2={W - PAD_R}
          y2={PAD_T + plotH * (1 - f)}
          stroke="var(--color-edge)"
          strokeDasharray="3 6"
          strokeWidth="0.4"
          opacity="0.5"
        />
      ))}

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
        x={PAD_L}
        y={PAD_T - 3}
        fill="var(--color-muted)"
        fontSize="11"
        fontFamily="var(--font-mono)"
      >
        Credit $
      </text>
    </svg>
  );
}

// ── Panel 4: % Max Profit Gauges ───────────────────────

function ProfitGauges({
  spreads,
  ironCondors,
}: {
  spreads: readonly Spread[];
  ironCondors: readonly IronCondor[];
}) {
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
        : putPct ?? callPct;
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
      type:
        s.spreadType === 'PUT_CREDIT_SPREAD'
          ? 'PCS'
          : 'CCS',
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
    <div className="flex flex-wrap items-start justify-center gap-3">
      {gauges.map((g) => {
        const pct = g.pct != null ? Math.max(0, Math.min(100, g.pct)) : null;
        const filled =
          pct != null
            ? (pct / 100) * arcLen
            : 0;
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
            key={g.label}
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
                {pct != null
                  ? `${Math.round(pct)}%`
                  : '\u2014'}
              </text>
            </svg>
            <div
              className="text-secondary mt-1 text-center font-mono text-xs font-semibold leading-tight"
            >
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

// ── Main 4-Panel Component ─────────────────────────────

export default function PositionVisuals(
  props: PositionVisualsProps,
) {
  const [expanded, setExpanded] = useState<string | null>(
    null,
  );

  const panels = [
    {
      id: 'strike-map',
      title: 'Strike Map',
      desc: 'Positions relative to spot',
      content: (
        <StrikeMap
          spreads={props.spreads}
          ironCondors={props.ironCondors}
          hedges={props.hedges}
          nakedPositions={props.nakedPositions}
          spotPrice={props.spotPrice}
        />
      ),
    },
    {
      id: 'risk-waterfall',
      title: 'Risk Waterfall',
      desc: 'Max loss by position',
      content: (
        <RiskWaterfall
          spreads={props.spreads}
          ironCondors={props.ironCondors}
          hedges={props.hedges}
          portfolioRisk={props.portfolioRisk}
        />
      ),
    },
    {
      id: 'credit-time',
      title: 'Credit vs Time',
      desc: 'Entry prices by time of day',
      content: <CreditTimeChart trades={props.trades} />,
    },
    {
      id: 'profit-gauges',
      title: '% Max Profit',
      desc: 'Theta capture per position',
      content: (
        <ProfitGauges
          spreads={props.spreads}
          ironCondors={props.ironCondors}
        />
      ),
    },
  ] as const;

  return (
    <div
      role="region"
      aria-label="Position visualizations"
      data-testid="position-visuals"
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {panels.map((panel) => {
          const isExpanded = expanded === panel.id;
          return (
            <div
              key={panel.id}
              className={`bg-surface-alt border-edge overflow-hidden rounded-lg border transition-all ${
                isExpanded
                  ? 'md:col-span-2'
                  : ''
              }`}
            >
              {/* Panel header */}
              <button
                type="button"
                onClick={() =>
                  setExpanded(
                    isExpanded ? null : panel.id,
                  )
                }
                className="flex w-full cursor-pointer items-center justify-between px-4 pt-3 pb-1"
              >
                <div>
                  <span className="text-tertiary font-sans text-xs font-bold uppercase tracking-wider">
                    {panel.title}
                  </span>
                  <span className="text-muted ml-2 font-sans text-[10px]">
                    {panel.desc}
                  </span>
                </div>
                <span className="text-muted text-xs">
                  {isExpanded ? '\u25B2' : '\u25BC'}
                </span>
              </button>
              {/* Panel content */}
              <div className="px-3 pb-3">
                {panel.content}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
