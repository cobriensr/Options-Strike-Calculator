import { useMemo } from 'react';
import type { LotteryFire } from './types.js';

interface LotteryDayBannerProps {
  fires: LotteryFire[];
}

/**
 * Day-level macro banner — at-a-glance regime context independent of
 * any specific alert. Sourced from the most recent fire's macro
 * snapshot (the macro tables are populated only when the cron runs
 * for an actual fire, so a quiet day has no banner — that's expected
 * and noted in the empty state).
 *
 * Display-only per spec Appendix A — every macro-augmented selection
 * rule UNDERPERFORMED the cheap-call-PM-only baseline on total
 * realized $ in the 15-day backtest. Surfaced as informational
 * regime context, never as a selection signal.
 */
export function LotteryDayBanner({ fires }: LotteryDayBannerProps) {
  // Latest fire's macro snapshot is "regime as-of the most recent
  // trigger." Picks the fire with the largest triggerTimeCt; on a
  // quiet day with zero fires we render nothing.
  const macroFire = useMemo(() => {
    if (fires.length === 0) return null;
    return fires.reduce((latest, f) =>
      f.triggerTimeCt > latest.triggerTimeCt ? f : latest,
    );
  }, [fires]);

  if (!macroFire) {
    return (
      <div className="rounded border border-neutral-800 bg-neutral-950 p-2 text-[11px] text-neutral-500">
        Regime context will appear with the first fire of the day.
      </div>
    );
  }

  const m = macroFire.macro;
  const tideDiff = m.mktTideDiff;
  const zeroDteDiff = m.zeroDteDiff;
  const spxGamma = m.spxSpotGammaOi;
  const asOf = new Date(macroFire.triggerTimeCt).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Chicago',
  });

  return (
    <div className="rounded border border-neutral-800 bg-neutral-950 p-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px]">
        <span className="font-semibold text-neutral-300">Regime today</span>
        <span className="text-neutral-500">@ {asOf} CT</span>

        <DayMetric
          label="Market Tide"
          value={tideDiff}
          format="signed"
          tooltip="Market Tide NCP - NPP at the latest fire time. Positive = net call premium dominant; negative = net put premium dominant. Display-only; not a selection signal (see spec Appendix A)."
        />
        <DayMetric
          label="0DTE Flow"
          value={zeroDteDiff}
          format="signed"
          tooltip="zero_dte_greek_flow NCP - NPP at the latest fire time. Same direction signal but limited to 0DTE prints. Display-only."
        />
        <DayMetric
          label="SPX Gamma"
          value={spxGamma}
          format="sign-only"
          tooltip="SPX dealer gamma_oi sign at the latest fire time. 🟢 positive = dealers long gamma (vol-suppressing); 🔴 negative = dealers short gamma (vol-amplifying). Display-only."
        />

        <span className="ml-auto text-[10px] text-neutral-600">
          display-only — see methodology
        </span>
      </div>
    </div>
  );
}

interface DayMetricProps {
  label: string;
  value: number | null;
  format: 'signed' | 'sign-only';
  tooltip: string;
}

function DayMetric({ label, value, format, tooltip }: DayMetricProps) {
  if (value == null) {
    return (
      <span
        className="font-mono text-neutral-500"
        title={`${tooltip}\n\n(no data — early-session fire before macro tables populated, or backfilled fire without macro)`}
      >
        {label} —
      </span>
    );
  }

  if (format === 'sign-only') {
    const dot = value > 0 ? '🟢' : value < 0 ? '🔴' : '⚪';
    return (
      <span className="font-mono text-neutral-300" title={tooltip}>
        {label} {dot}
      </span>
    );
  }

  // signed numeric
  const arrow = value > 0 ? '⬆' : value < 0 ? '⬇' : '→';
  const cls =
    value > 0
      ? 'text-green-300'
      : value < 0
        ? 'text-red-300'
        : 'text-neutral-300';
  const formatted = formatLarge(value);
  return (
    <span className={`font-mono ${cls}`} title={tooltip}>
      {label} {arrow} {formatted}
    </span>
  );
}

function formatLarge(n: number): string {
  const abs = Math.abs(n);
  const sign = n >= 0 ? '+' : '-';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
  return `${sign}${abs.toFixed(0)}`;
}
