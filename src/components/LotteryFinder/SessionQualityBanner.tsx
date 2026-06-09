import { currentSessionStage } from '../../data/marketHours.js';
import {
  getTodBucket,
  TOD_QUALITY,
  type SessionQuality,
} from './session-quality.js';

interface SessionQualityBannerProps {
  /** Injectable instant for tests; defaults to now. */
  now?: Date;
}

/**
 * Session-quality backdrop banner for the Lottery Finder feed.
 *
 * Decision-support ONLY — surfaces the CURRENT time-of-day bucket and its
 * historical expectancy (static numbers) so the trader knows the backdrop.
 * Changes no scoring/filtering/data. Renders only during the live trading
 * session (returns null when the market is closed / post-close / pre-market).
 *
 * Mirrors LotteryTierBanner styling.
 */

/** Quality dot by tier. */
const QUALITY_DOT: Record<SessionQuality, string> = {
  strong: '🟢',
  moderate: '🟡',
  weak: '🔴',
};

/**
 * Container border + text color by quality. Full Tailwind class literals
 * (NOT interpolated fragments) so the JIT compiler keeps them.
 */
const QUALITY_CLASS: Record<SessionQuality, string> = {
  strong: 'border-emerald-700/40 text-emerald-300',
  moderate: 'border-amber-700/40 text-amber-300',
  weak: 'border-rose-700/40 text-rose-300',
};

export function SessionQualityBanner({
  now = new Date(),
}: SessionQualityBannerProps) {
  const stage = currentSessionStage(now);
  // Live trading session only. Pre-market teaser is out of scope for v1.
  // half-day is intentionally included — it's a live session (AM_open/MID/LUNCH windows are unaffected by an early close).
  if (stage === 'closed' || stage === 'post-close' || stage === 'pre-market') {
    return null;
  }

  const bucket = getTodBucket(now);
  const stat = TOD_QUALITY[bucket];
  const { quality, label, ctWindow, medianPeakPct, winRatePct, blurb } = stat;

  return (
    <div
      data-testid="lottery-session-quality"
      data-quality={quality}
      className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded border bg-neutral-950 p-2 text-[11px] ${QUALITY_CLASS[quality]}`}
    >
      <span className="font-semibold">
        <span aria-hidden="true">{QUALITY_DOT[quality]}</span> {label}
      </span>
      <span className="text-neutral-400">{ctWindow}</span>
      <span className="font-mono">median peak ~{medianPeakPct}%</span>
      <span className="font-mono">win {winRatePct}%</span>
      <span className="text-neutral-400">{blurb}</span>
      <span className="ml-auto text-[10px] text-neutral-600">
        historical, not predictive
      </span>
    </div>
  );
}
