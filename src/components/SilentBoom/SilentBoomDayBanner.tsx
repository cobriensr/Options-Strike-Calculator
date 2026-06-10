import { useMemo } from 'react';
import type { SilentBoomAlert } from './types.js';

/**
 * Display floor for the spike-ratio baseline — must match
 * SPIKE_BASELINE_DISPLAY_FLOOR in SilentBoomRow.tsx. The row badge shows
 * `spikeVolume / max(baselineVolume, 100)` (the gate-consistent ratio),
 * not the raw stored `spikeRatio` (`spikeVolume / max(baselineVolume, 1)`).
 * The banner's "loudest" must rank + render with the same floored ratio
 * or it will name an alert / number that no visible row badge shows.
 */
const SPIKE_BASELINE_DISPLAY_FLOOR = 100;

/** The floored spike ratio the row badge displays (×N burst). */
const flooredSpikeRatio = (a: SilentBoomAlert): number =>
  a.spikeVolume / Math.max(a.baselineVolume, SPIKE_BASELINE_DISPLAY_FLOOR);

interface SilentBoomDayBannerProps {
  alerts: SilentBoomAlert[];
  /** Total alerts on the day (server count, may exceed alerts.length on
   *  a paginated view). Used so the headline reflects the full day,
   *  not just the rendered page. */
  total: number;
}

/**
 * Day-level summary banner. Tier breakdown + dominant ticker + the
 * loudest single bucket today. Sourced from the in-page sample —
 * tier counts always reflect the server's `total` because the API
 * response includes scoreTier on every paginated row.
 *
 * On a fresh day with zero alerts the banner renders an empty-state
 * line so the user knows nothing has fired yet.
 */
export function SilentBoomDayBanner({
  alerts,
  total,
}: SilentBoomDayBannerProps) {
  const summary = useMemo(() => {
    if (alerts.length === 0) return null;

    let t1 = 0;
    let t2 = 0;
    let t3 = 0;
    const tickerCounts = new Map<string, number>();
    let topAlert: SilentBoomAlert | null = null;

    for (const a of alerts) {
      if (a.scoreTier === 'tier1') t1 += 1;
      else if (a.scoreTier === 'tier2') t2 += 1;
      else t3 += 1;
      tickerCounts.set(
        a.underlyingSymbol,
        (tickerCounts.get(a.underlyingSymbol) ?? 0) + 1,
      );
      // Rank by the FLOORED ratio the row badge shows, not the raw
      // stored spikeRatio — otherwise the banner's "loudest" can name a
      // different alert (or a ×8500 number) that no visible row matches.
      if (
        topAlert == null ||
        flooredSpikeRatio(a) > flooredSpikeRatio(topAlert)
      ) {
        topAlert = a;
      }
    }

    const dominantTicker = [...tickerCounts.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0];

    return { t1, t2, t3, dominantTicker, topAlert };
  }, [alerts]);

  if (!summary) {
    return (
      <div className="rounded border border-neutral-800 bg-neutral-950 p-2 text-[11px] text-neutral-500">
        No silent-boom alerts yet today — banner populates with the first fire.
      </div>
    );
  }

  const { t1, t2, t3, dominantTicker, topAlert } = summary;

  return (
    <div className="rounded border border-neutral-800 bg-neutral-950 p-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px]">
        <span className="font-semibold text-neutral-300">
          Day so far · {total.toLocaleString()} alert{total === 1 ? '' : 's'}
        </span>

        {/* Tier breakdown — counts only reflect the visible page, but
            tier1 is sparse enough (~5% of fires) that the in-page count
            is usually the day total when the user is on page 0. We
            label this explicitly. */}
        <span
          className="font-mono text-rose-300"
          title="Tier 1 fires on the current page (score ≥ 21). Historically ~5% of daily fires; ~56% peak ≥ 50%."
        >
          🔥🔥🔥 {t1}
        </span>
        <span
          className="font-mono text-amber-300"
          title="Tier 2 fires on the current page (score 8–20). Historically ~19% of daily fires; ~37% peak ≥ 50%."
        >
          🔥🔥 {t2}
        </span>
        <span
          className="font-mono text-neutral-400"
          title="Tier 3 fires on the current page (score < 8). Historically ~76% of daily fires; ~8% peak ≥ 50%."
        >
          🔥 {t3}
        </span>

        {/* Dominant ticker — quick read on which symbol is generating
            the most setups today. */}
        {dominantTicker && (
          <span
            className="text-neutral-500"
            title={`${dominantTicker[0]} dominates today's silent-boom feed with ${dominantTicker[1]} alerts on the current page.`}
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

        {/* Loudest spike — the largest spike_ratio fire of the day so
            far. Anchors the user to the most extreme print. */}
        {topAlert != null && (
          <span
            className="text-neutral-500"
            title={`Largest spike ratio in the current view: ${topAlert.underlyingSymbol} ${topAlert.strike}${topAlert.optionType} at ${flooredSpikeRatio(topAlert).toFixed(0)}× baseline (floored at 100 to match the row badge).`}
          >
            loudest:{' '}
            <span className="font-mono text-neutral-200">
              {topAlert.underlyingSymbol}
            </span>{' '}
            <span className="font-mono text-neutral-400">
              ×{flooredSpikeRatio(topAlert).toFixed(0)}
            </span>
          </span>
        )}

        <span className="ml-auto text-[10px] text-neutral-600">
          counts on current page
        </span>
      </div>
    </div>
  );
}
