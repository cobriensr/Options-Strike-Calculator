/**
 * StrikeBox — Panel 5: dense sofbot-style leaderboard with greek bars.
 *
 * Shows the top 5 strikes by Hedge/1% (largest |gexDollars|) with rank,
 * rank-change arrow, strike price, distance from spot, 1m delta%,
 * CHEX/DEX/VEX greek bars, Hedge/1% (dealer hedge $ per 1% SPX move),
 * est. Δ, and HOT% badge.
 *
 * Rank-change tracking: a useRef holds the previous snapshot's rank map;
 * a useState holds the computed RankChangeInfo so arrows persist until the
 * next data update without triggering a reset re-render.
 *
 * Greek bar sizing uses tanh(|value| / scale) where scale = median
 * abs(value) across the displayed 5-strike set, recomputed on every render.
 * Near-zero threshold = 5th percentile of abs(value); below it the bar
 * is rendered in muted gray.
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { SectionBox, ScrollHint } from '../../ui';
import { theme } from '../../../themes';
import type { StrikeScore } from '../../../utils/gex-target';
import { computeBarStats } from './bars';
import { Row, type BarStatsBundle } from './Row';
import type { RankChangeInfo } from './RankArrow';

export interface StrikeBoxProps {
  leaderboard: StrikeScore[];
}

const TH_CLS =
  'px-1.5 py-1 text-[10px] uppercase tracking-wide font-mono text-left whitespace-nowrap';

export const StrikeBox = memo(function StrikeBox({
  leaderboard,
}: StrikeBoxProps) {
  // The parent (GexTarget/index.tsx) pre-sorts the leaderboard by |gexDollars|
  // and slices to 5 before passing it in. Use it directly — no re-sort needed.
  const top5 = leaderboard;

  // Track previous ranks in a ref so arrows persist until the NEXT data
  // update. The old useState approach caused arrows to flash once and
  // immediately reset to "same" because setPrevRanks triggered a second
  // render that overwrote the comparison before the user could see it.
  // A ref updates silently (no re-render) so the computed rankChanges
  // state is stable until top5 changes again.
  const prevRanksRef = useRef<Map<number, number>>(new Map());
  const [rankChanges, setRankChanges] = useState<Map<number, RankChangeInfo>>(
    () => new Map(),
  );

  useEffect(() => {
    const prev = prevRanksRef.current;
    const result = new Map<number, RankChangeInfo>();
    top5.forEach((s, idx) => {
      const currentRank = idx + 1;
      const prevRank = prev.get(s.strike);
      if (prevRank === undefined) {
        result.set(s.strike, { type: 'new', delta: 0 });
      } else {
        const delta = prevRank - currentRank; // positive = moved up
        result.set(s.strike, {
          type: delta > 0 ? 'up' : delta < 0 ? 'down' : 'same',
          delta,
        });
      }
    });
    setRankChanges(result);
    const m = new Map<number, number>();
    top5.forEach((s, idx) => m.set(s.strike, idx + 1));
    prevRanksRef.current = m;
  }, [top5]);

  // Compute per-greek bar stats once per render (scoped to the displayed top5).
  // Net dealer delta in contracts from greek_exposure_strike (call_delta + put_delta).
  // Falls back to 0 when the JOIN produced no greek exposure row (early session).
  const barStats = useMemo<BarStatsBundle>(
    () => ({
      charm: computeBarStats(top5.map((s) => s.features.charmNet)),
      delta: computeBarStats(top5.map((s) => s.features.deltaNet)),
      vanna: computeBarStats(top5.map((s) => s.features.vannaNet)),
      cp: computeBarStats(
        top5.map(
          (s) => (s.features.callDelta ?? 0) + (s.features.putDelta ?? 0),
        ),
      ),
    }),
    [top5],
  );

  return (
    <SectionBox label="GEX STRIKE BOARD">
      {top5.length === 0 ? (
        <p className="font-mono text-[11px]" style={{ color: theme.textMuted }}>
          No data
        </p>
      ) : (
        <ScrollHint>
          <table
            role="table"
            className="w-full border-collapse"
            aria-label="GEX Strike Leaderboard"
          >
            <thead>
              <tr style={{ color: theme.textMuted }}>
                <th className={TH_CLS} scope="col">
                  RK
                </th>
                <th className={TH_CLS} scope="col" aria-label="Rank change">
                  &#8597;
                </th>
                <th className={TH_CLS} scope="col">
                  Strike
                </th>
                <th className={TH_CLS} scope="col">
                  Dist
                </th>
                <th className={TH_CLS} scope="col">
                  &#916;%
                </th>
                <th className={TH_CLS} scope="col" title="Charm exposure">
                  CHEX
                </th>
                <th className={TH_CLS} scope="col" title="Delta exposure">
                  DEX
                </th>
                <th className={TH_CLS} scope="col" title="Vanna exposure">
                  VEX
                </th>
                <th
                  className={`${TH_CLS} cursor-help`}
                  scope="col"
                  title="Dealer hedge dollars per 1% SPX move: γ × OI × 100 × spot × 0.01 (from /greek-exposure/strike). Gamma is fixed at the STRIKE, so the profile is smoother across strikes. Estimates how many dollars dealers must trade when SPX touches this strike. Different metric than the GEX Landscape's Dollar Γ — that one uses spot-adjusted gamma and is ~spot times larger (B-scale vs K-scale)."
                >
                  Hedge/1%
                </th>
                <th
                  className={TH_CLS}
                  scope="col"
                  title="Net dealer delta in contracts (Σ call delta + Σ put delta from greek_exposure_strike). Positive = dealers net long delta (support zone); negative = net short delta (resistance zone)."
                >
                  est.&nbsp;Δ
                </th>
                <th className={TH_CLS} scope="col" title="1m momentum">
                  HOT%
                </th>
              </tr>
            </thead>
            <tbody>
              {top5.map((s, idx) => (
                <Row
                  key={s.strike}
                  s={s}
                  displayRank={idx + 1}
                  rankChange={
                    rankChanges.get(s.strike) ?? { type: 'same', delta: 0 }
                  }
                  barStats={barStats}
                  isAlt={idx % 2 === 1}
                />
              ))}
            </tbody>
          </table>
        </ScrollHint>
      )}
    </SectionBox>
  );
});
