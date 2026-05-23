/**
 * DayConfidenceBanner — the top stripe of the Gamma-Node Composite
 * Detector tile.
 *
 * Renders three groups (left to right):
 *   1. DOW label + confidence tier badge (MAXIMUM/HIGH/MEDIUM).
 *   2. Pre-day filter status line ("pre-day filter active" / "—").
 *   3. Anti-filter warning chips when applicable (FOMC, DOM 1-5, DOM 16-20)
 *      AND nearest +γ floor/ceiling context.
 *
 * Confidence color mapping (matches spec):
 *   - MAXIMUM / HIGH → theme.green
 *   - MEDIUM        → theme.caution
 *
 * Anti-filter color mapping:
 *   - FOMC          → theme.caution (slow down, not a hard veto)
 *   - DOM 1-5       → theme.red     (E5 anti-filter, avoid that signal)
 *   - DOM 16-20     → theme.red     (E1 weak)
 */

import { memo } from 'react';

import { StatusBadge } from '../ui/StatusBadge';
import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import type {
  ConfidenceTier,
  DowLabel,
  GammaSetupsResponse,
} from '../../hooks/useGammaSetups';

interface DayConfidenceBannerProps {
  data: GammaSetupsResponse;
}

function confidenceColor(tier: ConfidenceTier): string {
  return tier === 'MEDIUM' ? theme.caution : theme.green;
}

interface AntiFilter {
  key: string;
  label: string;
  color: string;
  title: string;
}

function activeAntiFilters(data: GammaSetupsResponse): AntiFilter[] {
  const out: AntiFilter[] = [];
  if (data.anti_filters.is_fomc_day) {
    out.push({
      key: 'fomc',
      label: 'FOMC DAY',
      color: theme.caution,
      title:
        'FOMC days historically destroy the E1 long-call edge (-13.75 Δ in backtest, n=4)',
    });
  }
  if (data.anti_filters.is_dom_1_5) {
    out.push({
      key: 'dom1-5',
      label: 'DOM 1-5',
      color: theme.red,
      title:
        'Early-month days break E5 long-put edge (-18.82 Δ in backtest, n=12)',
    });
  }
  if (data.anti_filters.is_dom_16_20) {
    out.push({
      key: 'dom16-20',
      label: 'DOM 16-20',
      color: theme.red,
      title:
        'Mid-month gamma void weakens E1 long-call edge (-1.43 Δ in backtest, n=24)',
    });
  }
  return out;
}

function formatGexK(gex: number): string {
  const abs = Math.abs(gex);
  if (abs >= 1_000_000) return `${(gex / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(gex / 1_000).toFixed(0)}K`;
  return gex.toFixed(0);
}

function PreDayFilterLine({ data }: Readonly<{ data: GammaSetupsResponse }>) {
  if (data.pre_day_filter_fires) {
    const ret =
      data.prior_5d_ret != null
        ? `prior 5d: ${(data.prior_5d_ret * 100).toFixed(2)}%`
        : 'prior 5d: n/a';
    const iv =
      data.prior_iv_rank != null
        ? `iv rank: ${data.prior_iv_rank.toFixed(0)}`
        : 'iv rank: n/a';
    return (
      <span
        className="font-mono text-[10px]"
        style={{ color: theme.green }}
        title="Pre-day filter is firing: prior 5d return < -1% AND prior IV rank > 25"
      >
        pre-day filter active ({ret}, {iv})
      </span>
    );
  }
  return (
    <span
      className="text-muted font-mono text-[10px]"
      title="Pre-day filter inactive — requires prior 5d return < -1% AND prior IV rank > 25"
    >
      pre-day filter inactive
    </span>
  );
}

function AntiFilterChips({ filters }: Readonly<{ filters: AntiFilter[] }>) {
  if (filters.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {filters.map((f) => (
        <span
          key={f.key}
          className="shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-bold tracking-[0.06em] uppercase"
          style={{ backgroundColor: tint(f.color, '18'), color: f.color }}
          title={f.title}
        >
          {f.label}
        </span>
      ))}
    </div>
  );
}

function GammaContext({ data }: Readonly<{ data: GammaSetupsResponse }>) {
  const floor = data.nearest_floor;
  const ceiling = data.nearest_ceiling;
  if (floor == null && ceiling == null) return null;
  return (
    <div className="text-muted flex flex-wrap items-center gap-2.5 font-mono text-[10px]">
      {ceiling != null && (
        <span title="Nearest positive-γ ceiling above current spot">
          ceiling {ceiling.strike}
          <span className="text-tertiary"> ({formatGexK(ceiling.gex)})</span>
        </span>
      )}
      {floor != null && (
        <span title="Nearest positive-γ floor below current spot">
          floor {floor.strike}
          <span className="text-tertiary"> ({formatGexK(floor.gex)})</span>
        </span>
      )}
    </div>
  );
}

export const DayConfidenceBanner = memo(function DayConfidenceBanner({
  data,
}: DayConfidenceBannerProps) {
  const filters = activeAntiFilters(data);
  const tier = data.confidence_tier;
  const dow: DowLabel | null = data.dow_label;

  return (
    <div className="border-edge bg-surface-alt mb-3 rounded-[10px] border p-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-tertiary font-sans text-[11px] font-bold tracking-[0.08em] uppercase">
          {dow ?? 'Weekend'}
        </span>
        {tier != null ? (
          <StatusBadge label={tier} color={confidenceColor(tier)} />
        ) : (
          <span
            className="text-muted font-mono text-[10px]"
            title="No confidence tier outside the weekday RTH window"
          >
            —
          </span>
        )}
        <PreDayFilterLine data={data} />
        <AntiFilterChips filters={filters} />
      </div>
      <div className="mt-2">
        <GammaContext data={data} />
      </div>
    </div>
  );
});
