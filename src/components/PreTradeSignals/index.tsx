import type {
  MoversResponse,
  QuotesResponse,
  YesterdayResponse,
} from '../../types/api';
import { computeRvIv, computeGap, computeBreadth } from './classifiers';
import SignalCard from './SignalCard';

interface Props {
  readonly quotes: QuotesResponse | null;
  readonly yesterday: YesterdayResponse | null;
  readonly movers: MoversResponse | null;
  readonly vixPrevClose?: number;
  readonly spxOpen?: number;
  readonly spxPrevClose?: number;
}

export default function PreTradeSignals({
  quotes,
  yesterday,
  movers,
  vixPrevClose,
  spxOpen,
  spxPrevClose,
}: Props) {
  const rvIv = computeRvIv(
    yesterday?.yesterday?.rangePct,
    vixPrevClose ?? quotes?.vix?.prevClose,
  );
  const gap = computeGap(
    spxOpen ?? quotes?.spx?.open,
    spxPrevClose ?? quotes?.spx?.prevClose,
  );
  const breadth = computeBreadth(movers);

  const signals = [rvIv, gap, breadth].filter(Boolean);
  if (signals.length === 0) return null;

  return (
    <div>
      <div className="text-accent mb-2.5 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
        Pre-Trade Signals
      </div>

      <div className="grid grid-cols-1 gap-2.5">
        {rvIv && (
          <SignalCard
            title="Realized vs. Implied Vol"
            subtitle="Yesterday actual \u00F7 VIX predicted"
            result={rvIv}
          />
        )}
        {gap && (
          <SignalCard
            title="Overnight Gap"
            subtitle="SPX open vs. prior close"
            result={gap}
          />
        )}
        {breadth && (
          <SignalCard
            title="Move Breadth"
            subtitle="SPX component concentration"
            result={breadth}
          />
        )}
      </div>
    </div>
  );
}
