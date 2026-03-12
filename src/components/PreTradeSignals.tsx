import type { Theme } from '../themes';
import type {
  MoversResponse,
  QuotesResponse,
  YesterdayResponse,
} from '../types/api';

interface Props {
  readonly th: Theme;
  readonly quotes: QuotesResponse | null;
  readonly yesterday: YesterdayResponse | null;
  readonly movers: MoversResponse | null;
}

// ============================================================
// SIGNAL CLASSIFIERS
// ============================================================

type Signal = 'green' | 'yellow' | 'red';

interface SignalResult {
  signal: Signal;
  label: string;
  value: string;
  detail: string;
}

/**
 * #5 — Realized vs Implied Volatility
 * Compares yesterday's actual SPX range to what VIX predicted.
 * RV/IV < 0.8 → premium is rich (favorable for sellers)
 * RV/IV 0.8–1.2 → fair value
 * RV/IV > 1.2 → premium is cheap (market moving more than expected)
 */
function computeRvIv(
  yesterdayRangePct: number | undefined,
  vixPrevClose: number | undefined,
): SignalResult | null {
  if (!yesterdayRangePct || !vixPrevClose || vixPrevClose <= 0) return null;

  // VIX predicts 1-day move as VIX / sqrt(252)
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
 * Large gaps tend to extend during the session.
 */
function computeGap(
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
function computeBreadth(movers: MoversResponse | null): SignalResult | null {
  if (!movers) return null;

  const { concentrated, megaCapCount, bias, topUp, topDown } = movers.analysis;
  const totalMovers = movers.up.length + movers.down.length;
  if (totalMovers === 0) return null;

  const signal: Signal =
    !concentrated && bias === 'mixed'
      ? 'yellow'
      : concentrated
        ? 'green' // Concentrated in a few names → move may be contained
        : 'red'; // Broad-based → move likely persists

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

// ============================================================
// COMPONENT
// ============================================================

export default function PreTradeSignals({
  th,
  quotes,
  yesterday,
  movers,
}: Props) {
  const rvIv = computeRvIv(
    yesterday?.yesterday?.rangePct,
    quotes?.vix?.prevClose,
  );
  const gap = computeGap(quotes?.spx?.open, quotes?.spx?.prevClose);
  const breadth = computeBreadth(movers);

  const signals = [rvIv, gap, breadth].filter(Boolean) as SignalResult[];
  if (signals.length === 0) return null;

  return (
    <div>
      <div className="text-accent mb-2.5 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
        Pre-Trade Signals
      </div>

      <div className="grid grid-cols-1 gap-2.5">
        {rvIv && (
          <SignalCard
            th={th}
            title="Realized vs. Implied Vol"
            subtitle="Yesterday actual ÷ VIX predicted"
            result={rvIv}
          />
        )}
        {gap && (
          <SignalCard
            th={th}
            title="Overnight Gap"
            subtitle="SPX open vs. prior close"
            result={gap}
          />
        )}
        {breadth && (
          <SignalCard
            th={th}
            title="Move Breadth"
            subtitle="SPX component concentration"
            result={breadth}
          />
        )}
      </div>
    </div>
  );
}

// ============================================================
// SUB-COMPONENTS
// ============================================================

function SignalCard({
  th,
  title,
  subtitle,
  result,
}: {
  th: Theme;
  title: string;
  subtitle: string;
  result: SignalResult;
}) {
  const color =
    result.signal === 'green'
      ? th.green
      : result.signal === 'yellow'
        ? '#E8A317'
        : th.red;

  return (
    <div className="bg-surface border-edge rounded-[10px] border p-3 sm:p-3.5">
      <div className="mb-1.5 flex items-start justify-between">
        <div>
          <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
            {title}
          </div>
          <div className="text-muted font-sans text-[9px]">{subtitle}</div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="font-mono text-[15px] font-extrabold"
            style={{ color }}
          >
            {result.value}
          </span>
          <span
            className="rounded-full px-2 py-0.5 font-sans text-[9px] font-bold tracking-[0.06em] uppercase"
            style={{ backgroundColor: color + '18', color }}
          >
            {result.label}
          </span>
        </div>
      </div>
      <div className="text-secondary font-sans text-[11px] leading-normal">
        {result.detail}
      </div>
    </div>
  );
}
