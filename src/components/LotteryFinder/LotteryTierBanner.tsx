import { useMemo } from 'react';
import type { LotteryFire } from './types.js';

interface LotteryTierBannerProps {
  fires: LotteryFire[];
  /** Total fires on the day (server count, may exceed fires.length on
   *  a paginated view). Headline reflects the full day, not the page. */
  total: number;
}

/**
 * Day-level summary banner — tier breakdown (T1/T2/T3 counts) +
 * dominant ticker + loudest single fire by score. Mirrors the
 * SilentBoomDayBanner shape so both panels carry the same
 * at-a-glance regime strip. Tier counts reflect the current page
 * because the API response includes scoreTier on every row;
 * disclaimer at the right end notes this for the user.
 */
export function LotteryTierBanner({ fires, total }: LotteryTierBannerProps) {
  const summary = useMemo(() => {
    if (fires.length === 0) return null;
    let t1 = 0;
    let t2 = 0;
    let t3 = 0;
    const tickerCounts = new Map<string, number>();
    let topFire: LotteryFire | null = null;
    for (const f of fires) {
      if (f.scoreTier === 'tier1') t1 += 1;
      else if (f.scoreTier === 'tier2') t2 += 1;
      else t3 += 1;
      tickerCounts.set(
        f.underlyingSymbol,
        (tickerCounts.get(f.underlyingSymbol) ?? 0) + 1,
      );
      const fScore = f.score ?? -Infinity;
      const topScore = topFire?.score ?? -Infinity;
      if (topFire == null || fScore > topScore) topFire = f;
    }
    const dominantTicker = [...tickerCounts.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0];
    return { t1, t2, t3, dominantTicker, topFire };
  }, [fires]);

  if (!summary) {
    return (
      <div className="rounded border border-neutral-800 bg-neutral-950 p-2 text-[11px] text-neutral-500">
        No lottery fires yet today — banner populates with the first fire.
      </div>
    );
  }

  const { t1, t2, t3, dominantTicker, topFire } = summary;

  return (
    <div className="rounded border border-neutral-800 bg-neutral-950 p-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px]">
        <span className="font-semibold text-neutral-300">
          Day so far · {total.toLocaleString()} fire{total === 1 ? '' : 's'}
        </span>

        <span
          className="font-mono text-rose-300"
          title="Tier 1 fires on the current page (score ≥ 18). Historical high-peak rate ~80%."
        >
          🔥🔥🔥 {t1}
        </span>
        <span
          className="font-mono text-amber-300"
          title="Tier 2 fires on the current page (score 12–17). Historical high-peak rate ~63%."
        >
          🔥🔥 {t2}
        </span>
        <span
          className="font-mono text-neutral-400"
          title="Tier 3 fires on the current page (score < 12). Historical high-peak rate ~32%."
        >
          🔥 {t3}
        </span>

        {dominantTicker && (
          <span
            className="text-neutral-500"
            title={`${dominantTicker[0]} dominates today's lottery feed with ${dominantTicker[1]} fires on the current page.`}
          >
            top:{' '}
            <span className="font-mono font-semibold text-neutral-200">
              {dominantTicker[0]}
            </span>{' '}
            <span className="font-mono text-neutral-400">
              ×{dominantTicker[1]}
            </span>
          </span>
        )}

        {topFire != null && topFire.score != null && (
          <span
            className="text-neutral-500"
            title={`Highest-scoring fire in the current view: ${topFire.underlyingSymbol} ${topFire.strike}${topFire.optionType} at score ${topFire.score}.`}
          >
            top score:{' '}
            <span className="font-mono text-neutral-200">
              {topFire.underlyingSymbol}
            </span>{' '}
            <span className="font-mono text-neutral-400">{topFire.score}</span>
          </span>
        )}

        <span className="ml-auto text-[10px] text-neutral-600">
          counts on current page
        </span>
      </div>
    </div>
  );
}
