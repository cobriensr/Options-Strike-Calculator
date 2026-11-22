import { useMemo } from 'react';
import type { LotteryFinderResponse, LotteryFire } from './types.js';
import { SrHint } from '../ui/SrHint.js';

type TierCutoffs = NonNullable<LotteryFinderResponse['tierCutoffs']>;

interface LotteryTierBannerProps {
  fires: LotteryFire[];
  /** Total fires on the day (server count, may exceed fires.length on
   *  a paginated view). Surfaced as a separate "of N today" clause; the
   *  headline number itself is the page count so it agrees with the tier
   *  sum (t1 + t2 + t3 === fires.length). */
  total: number;
  /** The cutoffs the latest feed response tiered on (the active weights
   *  version's qas thresholds, `tierCutoffs`). Absent before the first
   *  response and from a server build that predates the field, and the
   *  tier tooltips then name no number. */
  cutoffs?: TierCutoffs;
}

/** The measured rates the tooltips quote were taken on the first version. */
const RATE_NOTE = 'measured on the 06-17 seed weights';

/**
 * The tooltip of one tier's count: its band as `qas` numbers when the response
 * carried the cutoffs, and no number at all while it has not.
 */
function tierTitle(
  tier: 1 | 2 | 3,
  cutoffs: TierCutoffs | undefined,
  rate: string,
): string {
  let band = '';
  if (cutoffs != null) {
    const { tier1MinScore: t1, tier2MinScore: t2 } = cutoffs;
    if (tier === 1) band = ` (qas ≥ ${t1})`;
    else if (tier === 2) band = ` (qas ${t2}–${t1 - 1})`;
    else band = ` (qas < ${t2})`;
  }
  return `Tier ${tier} fires on the current page${band}. Historical high-peak rate ~${rate}, ${RATE_NOTE}.`;
}

/**
 * Day-level summary banner — tier breakdown (T1/T2/T3 counts) +
 * dominant ticker + loudest single fire by score. Mirrors the
 * SilentBoomDayBanner shape so both panels carry the same
 * at-a-glance regime strip. Tier counts reflect the current page
 * because the API response includes scoreTier on every row; the
 * headline number is the page count (so it agrees with the tier sum)
 * and the full-day total is shown separately as "of N today". The
 * "counts on current page" caption at the right end reinforces this.
 */
export function LotteryTierBanner({
  fires,
  total,
  cutoffs,
}: LotteryTierBannerProps) {
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

  // Tier counts (t1/t2/t3), dominant ticker, and topFire are computed over
  // the rendered `fires` page only, so the headline number the tiers sit
  // next to must be that same page count (t1 + t2 + t3 === fires.length) —
  // otherwise the full-day server `total` reads as a tier denominator it
  // doesn't match. The full-day total is surfaced separately, clearly
  // labelled, only when it exceeds the page so the day-vs-page distinction
  // stays explicit.
  const pageCount = fires.length;
  const hasMoreToday = total > pageCount;
  const fireWord = pageCount === 1 ? 'fire' : 'fires';
  // The headline's title and its hint for a screen reader. With more fires on
  // the day than on the page the hint repeats the title. When the page holds
  // the whole day the title says "today", and `LotteryTierBanner.test.tsx`
  // asserts no text in that branch says it, so the hint is a variant without
  // the word.
  const headlineTitle = hasMoreToday
    ? `Tier breakdown below covers the ${pageCount.toLocaleString()} ${fireWord} on this page; ${total.toLocaleString()} fired across the full day.`
    : `All ${pageCount.toLocaleString()} ${fireWord} today are shown on this page.`;
  const headlineHint = hasMoreToday
    ? headlineTitle
    : 'every fire of the day is on this page';
  // One title per tier, shared by the count's title and its hint.
  const tier1Title = tierTitle(1, cutoffs, '80%');
  const tier2Title = tierTitle(2, cutoffs, '63%');
  const tier3Title = tierTitle(3, cutoffs, '32%');

  return (
    <div className="rounded border border-neutral-800 bg-neutral-950 p-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px]">
        <span className="font-semibold text-neutral-300" title={headlineTitle}>
          This page · {pageCount.toLocaleString()} fire
          {pageCount === 1 ? '' : 's'}
          {hasMoreToday && (
            <span className="ml-1 font-normal text-neutral-500">
              of {total.toLocaleString()} today
            </span>
          )}
          <SrHint>{headlineHint}</SrHint>
        </span>

        <span className="font-mono text-rose-300" title={tier1Title}>
          🔥🔥🔥 {t1}
          <SrHint>{tier1Title}</SrHint>
        </span>
        <span className="font-mono text-amber-300" title={tier2Title}>
          🔥🔥 {t2}
          <SrHint>{tier2Title}</SrHint>
        </span>
        <span className="font-mono text-neutral-400" title={tier3Title}>
          🔥 {t3}
          <SrHint>{tier3Title}</SrHint>
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
            <SrHint>most fires of any ticker on the current page</SrHint>
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
            <SrHint>{`${topFire.strike}${topFire.optionType}, highest-scoring fire in the current view`}</SrHint>
          </span>
        )}

        <span className="ml-auto text-[10px] text-neutral-600">
          counts on current page
        </span>
      </div>
    </div>
  );
}
