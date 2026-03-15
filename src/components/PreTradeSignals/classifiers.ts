import type { MoversResponse } from '../../types/api';

export type Signal = 'green' | 'yellow' | 'red';

export interface SignalResult {
  signal: Signal;
  label: string;
  value: string;
  detail: string;
}

/**
 * #5 — Realized vs Implied Volatility
 * Compares yesterday's actual SPX range to what VIX predicted.
 */
export function computeRvIv(
  yesterdayRangePct: number | undefined,
  vixPrevClose: number | undefined,
): SignalResult | null {
  if (!yesterdayRangePct || !vixPrevClose || vixPrevClose <= 0) return null;

  const predictedDailyPct = vixPrevClose / 15.874; // sqrt(252) ≈ 15.874
  const ratio = yesterdayRangePct / predictedDailyPct;

  const signal: Signal = ratio < 0.8 ? 'green' : ratio < 1.2 ? 'yellow' : 'red';
  const label =
    ratio < 0.8 ? 'PREMIUM RICH' : ratio < 1.2 ? 'FAIR VALUE' : 'PREMIUM CHEAP';
  const detail =
    ratio < 0.8
      ? 'Yesterday\u2019s actual move was smaller than VIX predicted. Premium you\u2019re selling is relatively expensive \u2014 favorable edge.'
      : ratio < 1.2
        ? 'Yesterday\u2019s move was in line with VIX expectations. Standard conditions.'
        : 'Yesterday\u2019s actual move exceeded what VIX predicted. Premium is cheap relative to real risk \u2014 the edge is thinner.';

  return {
    signal,
    label,
    value: ratio.toFixed(2) + 'x',
    detail,
  };
}

/**
 * #6 — Overnight Gap
 * Compares today's SPX open to yesterday's close.
 */
export function computeGap(
  spxOpen: number | undefined,
  spxPrevClose: number | undefined,
): SignalResult | null {
  if (!spxOpen || !spxPrevClose || spxPrevClose <= 0) return null;

  const gapPts = spxOpen - spxPrevClose;
  const gapPct = (gapPts / spxPrevClose) * 100;
  const absGapPct = Math.abs(gapPct);

  const signal: Signal =
    absGapPct < 0.3 ? 'green' : absGapPct < 0.7 ? 'yellow' : 'red';
  const direction = gapPct >= 0 ? 'up' : 'down';
  const label =
    absGapPct < 0.3
      ? 'FLAT OPEN'
      : absGapPct < 0.7
        ? 'MODERATE GAP'
        : 'LARGE GAP';
  const detail =
    absGapPct < 0.3
      ? 'Minimal overnight move. Market opened near yesterday\u2019s close \u2014 normal conditions for IC entry.'
      : absGapPct < 0.7
        ? `Market gapped ${direction} ${absGapPct.toFixed(2)}% overnight. Directional bias may persist \u2014 consider skewing deltas.`
        : `Significant ${direction} gap of ${absGapPct.toFixed(2)}%. Large gaps often extend. Widen the ${direction === 'down' ? 'put' : 'call'} side or reduce size.`;

  return {
    signal,
    label,
    value: (gapPct >= 0 ? '+' : '') + gapPct.toFixed(2) + '%',
    detail,
  };
}

/**
 * #7 — Move Breadth (from movers data)
 * Concentrated moves (driven by 1–2 mega-caps) may be contained.
 * Broad moves (many components) tend to persist.
 */
export function computeBreadth(
  movers: MoversResponse | null,
): SignalResult | null {
  if (!movers) return null;

  const { concentrated, megaCapCount, bias, topUp, topDown } = movers.analysis;
  const totalMovers = movers.up.length + movers.down.length;
  if (totalMovers === 0) return null;

  const signal: Signal =
    !concentrated && bias === 'mixed'
      ? 'yellow'
      : concentrated
        ? 'green'
        : 'red';

  const topMover = bias === 'bearish' && topDown ? topDown : topUp;

  const label = concentrated
    ? 'CONCENTRATED'
    : bias === 'mixed'
      ? 'BROAD / MIXED'
      : bias === 'bullish'
        ? 'BROAD RALLY'
        : 'BROAD SELLOFF';

  const detail = concentrated
    ? `Move driven by ${megaCapCount} mega-cap${megaCapCount > 1 ? 's' : ''} (${movers.analysis.megaCapSymbols.join(', ')}). Concentrated moves are more likely to be contained \u2014 standard IC positioning.`
    : bias === 'mixed'
      ? 'Mix of up and down movers across the index. No strong directional bias \u2014 favorable for non-directional ICs.'
      : `Broad ${bias} move across many SPX components${topMover ? ' led by ' + topMover.symbol + ' (' + (topMover.change >= 0 ? '+' : '') + topMover.change.toFixed(1) + '%)' : ''}. Broad moves tend to persist \u2014 consider wider deltas on the ${bias === 'bearish' ? 'put' : 'call'} side.`;

  return {
    signal,
    label,
    value: `${megaCapCount}/${totalMovers} mega`,
    detail,
  };
}
