import { useMemo } from 'react';
import type { SilentBoomAlert } from './types.js';

interface SilentBoomRegimeBannerProps {
  alerts: SilentBoomAlert[];
}

/**
 * Day-level macro banner — at-a-glance regime context independent of
 * any specific alert. Sourced from the most recent alert's macro
 * snapshot (Market Tide / 0DTE Flow / SPX Gamma persisted at fire
 * time). Mirrors LotteryDayBanner; same visual rhythm, same display-
 * only framing.
 *
 * On a quiet day with zero alerts the empty-state line renders so the
 * dashboard tells the user nothing has fired yet.
 */
export function SilentBoomRegimeBanner({
  alerts,
}: SilentBoomRegimeBannerProps) {
  const macroAlert = useMemo(() => {
    if (alerts.length === 0) return null;
    return alerts.reduce((latest, a) =>
      a.bucketCt > latest.bucketCt ? a : latest,
    );
  }, [alerts]);

  if (!macroAlert) {
    return (
      <div className="rounded border border-neutral-800 bg-neutral-950 p-2 text-[11px] text-neutral-500">
        Regime context will appear with the first alert of the day.
      </div>
    );
  }

  const tideDiff = macroAlert.mktTideDiff;
  const zeroDteDiff = macroAlert.zeroDteDiff;
  const spxGamma = macroAlert.spxSpotGammaOi;
  const asOf = new Date(macroAlert.bucketCt).toLocaleTimeString('en-US', {
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

        <RegimeMetric
          label="Market Tide"
          value={tideDiff}
          format="signed"
          tooltip="Market Tide NCP - NPP at the latest alert's spike-bucket time. Positive = net call premium dominant; negative = net put premium dominant. Display-only — not a selection signal."
        />
        <RegimeMetric
          label="0DTE Flow"
          value={zeroDteDiff}
          format="signed"
          tooltip="zero_dte_greek_flow NCP - NPP at the latest alert's spike-bucket time. Same direction signal but limited to 0DTE prints. Display-only."
        />
        <RegimeMetric
          label="SPX Gamma"
          value={spxGamma}
          format="sign-only"
          tooltip="SPX dealer gamma_oi sign at the latest alert's spike-bucket time. 🟢 positive = dealers long gamma (vol-suppressing); 🔴 negative = dealers short gamma (vol-amplifying). Display-only."
        />

        <span className="ml-auto text-[10px] text-neutral-600">
          display-only — see methodology
        </span>
      </div>
    </div>
  );
}

interface RegimeMetricProps {
  label: string;
  value: number | null;
  format: 'signed' | 'sign-only';
  tooltip: string;
}

function RegimeMetric({ label, value, format, tooltip }: RegimeMetricProps) {
  if (value == null) {
    return (
      <span
        className="font-mono text-neutral-500"
        title={`${tooltip}\n\n(no data — alert fired outside the macro window or before macro tables were populated)`}
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

  const arrow = value > 0 ? '⬆' : value < 0 ? '⬇' : '→';
  const cls =
    value > 0
      ? 'text-green-300'
      : value < 0
        ? 'text-red-300'
        : 'text-neutral-300';
  return (
    <span className={`font-mono ${cls}`} title={tooltip}>
      {label} {arrow} {formatLarge(value)}
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
