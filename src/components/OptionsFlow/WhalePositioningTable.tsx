/**
 * WhalePositioningTable — sortable table of whale-sized options flow.
 *
 * Renders aggregated per-option_chain whale alerts returned by
 * `useWhalePositioning`. Each row represents a single strike/expiry/side
 * with >=$1M premium and <=7 DTE. Default sort is total_premium DESC so
 * the biggest institutional prints read at the top of the table.
 *
 * Stateless re: fetching — parent owns the hook. Empty / loading / error
 * states render inline so the component can mount unconditionally while
 * the session is quiet.
 *
 * Visual language matches `OptionsFlowTable` so the two tables feel like
 * one flow module with two lenses (intraday 0-1 DTE vs. multi-day whale).
 * Aggression tints are intentionally omitted — at whale size the
 * ask-side-ratio signal is noisier and the premium magnitude is the
 * dominant read.
 */

import { useMemo, useState } from 'react';
import type { WhaleAlert } from '../../types/flow';
import {
  formatAskPct,
  formatPct,
  formatPremium,
  formatSignedInt,
} from '../../utils/flow-formatters';
import { useTableSort, type KeyExtractors } from '../../hooks/useTableSort';
import { SortableHeader } from '../ui/SortableHeader';

// ============================================================
// TYPES
// ============================================================

type SortColumn =
  | 'strike'
  | 'type'
  | 'dte_at_alert'
  | 'distance_from_spot'
  | 'total_premium'
  | 'ask_side_ratio'
  | 'total_size'
  | 'volume_oi_ratio'
  | 'age_minutes';

export interface WhalePositioningTableProps {
  alerts: WhaleAlert[];
  totalPremium: number;
  alertCount: number;
  isLoading: boolean;
  error: Error | null;
  className?: string;
}

// ============================================================
// SLIDER CONSTANTS
// ============================================================

/**
 * Min-premium slider bounds. Floor matches the hook's backend-fetch floor
 * ($500K); at floor value the table shows every returned alert. Ceiling is
 * $10M — beyond that the signal is rarely relevant intraday. Step is
 * $100K so sub-$1M granularity is reachable but the slider still feels
 * snappy rather than continuous.
 */
const SLIDER_MIN = 500_000;
const SLIDER_MAX = 10_000_000;
const SLIDER_STEP = 100_000;
const SLIDER_DEFAULT = 1_000_000;

function formatSliderPremium(n: number): string {
  if (n >= 1_000_000) {
    const millions = n / 1_000_000;
    // `$1.0M`, `$2.5M`, `$10.0M` — keep a single decimal for consistency
    return `$${millions.toFixed(1)}M`;
  }
  return `$${Math.round(n / 1_000)}K`;
}

// ============================================================
// LOCAL FORMATTERS — only the ones unique to this table.
// Shared currency / percent / signed-int formatters live in
// `src/utils/flow-formatters.ts`.
// ============================================================

function formatVolOi(ratio: number): string {
  if (!Number.isFinite(ratio)) return '—';
  return `${ratio.toFixed(1)}×`;
}

/**
 * Short expiry label like `4/20 (5d)` — month/day stripped of year to
 * keep the column narrow, with DTE-at-alert in parens so traders see
 * "how far out was this bought".
 */
function formatExpiry(isoDate: string, dte: number): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return '—';
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${m}/${day} (${dte}d)`;
}

/**
 * Short humanized age. `0` → "just now", single-digit-hour prints get
 * `1h 23m ago` to stay compact.
 */
function formatAge(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return '—';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes - hours * 60);
  if (mins === 0) return `${hours}h ago`;
  return `${hours}h ${mins}m ago`;
}

// ============================================================
// RULE LABELS
// ============================================================

/**
 * Maps UW alert rule names to compact badge labels. Unknown rules fall
 * back to a trimmed uppercase form so new server-side rules render
 * sensibly without a frontend change.
 */
const RULE_LABEL: Record<string, string> = {
  RepeatedHits: 'RHITS',
  RepeatedHitsAscendingFill: 'RHITS↑',
  RepeatedHitsDescendingFill: 'RHITS↓',
  FloorTradeLargeCap: 'FLOOR',
  FloorTradeSmallCap: 'FLOOR',
  FloorTradeMidCap: 'FLOOR',
  OpeningCondition: 'OPEN',
  UnusualOptionsActivity: 'UOA',
};

function shortRule(rule: string): string {
  if (RULE_LABEL[rule]) return RULE_LABEL[rule]!;
  // Fallback: strip "Trade"/"Condition" suffixes, uppercase, max 8 chars
  return rule
    .replace(/(Trade|Condition|Fill)/g, '')
    .toUpperCase()
    .slice(0, 8);
}

// ============================================================
// SORT KEY EXTRACTORS
// ============================================================

/**
 * Map every sort column to a row → comparable-or-null extractor for the
 * generic `useTableSort` hook. Returning null for a column opts the row
 * into the null-tail (always sorted last regardless of direction) — used
 * here for `ask_side_ratio` which can be null when total_premium is 0
 * or non-finite.
 */
const KEY_EXTRACTORS: KeyExtractors<WhaleAlert, SortColumn> = {
  strike: (row) => row.strike,
  // Sort puts (0) before calls (1) ascending; calls first descending.
  // Numeric encoding — same convention as OptionsFlowTable.
  type: (row) => (row.type === 'call' ? 1 : 0),
  dte_at_alert: (row) => row.dte_at_alert,
  distance_from_spot: (row) => row.distance_from_spot,
  total_premium: (row) => row.total_premium,
  // Null when server reports `null` (total_premium = 0 / non-finite). The
  // hook partitions null-extractor rows to the tail so direction toggles
  // never mix them with finite ratios.
  ask_side_ratio: (row) => row.ask_side_ratio,
  total_size: (row) => row.total_size,
  volume_oi_ratio: (row) => row.volume_oi_ratio,
  age_minutes: (row) => row.age_minutes,
};

// ============================================================
// SUB-COMPONENTS
// ============================================================

/**
 * One whale-alert row. Extracted from the table body so the per-row
 * branch logic (delta color, side color/label) reads as a self-contained
 * unit and the table render loop stays a one-line `.map`.
 */
function WhaleAlertRow({ alert }: { alert: WhaleAlert }) {
  const a = alert;
  const deltaColor =
    a.distance_from_spot > 0
      ? 'text-emerald-400'
      : a.distance_from_spot < 0
        ? 'text-rose-400'
        : 'text-slate-400';
  const sideColor = a.type === 'call' ? 'text-emerald-400' : 'text-rose-400';
  const sideLabel = a.type === 'call' ? 'C' : 'P';
  return (
    <tr className="border-edge/30 hover:bg-surface-alt/60 border-b transition-colors">
      <td className="text-secondary px-2 py-1.5 text-right font-semibold">
        {Math.round(a.strike).toLocaleString()}
      </td>
      <td className="px-2 py-1.5 text-center">
        <span
          className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${sideColor} bg-current/10`}
          aria-label={a.type === 'call' ? 'Call' : 'Put'}
        >
          {sideLabel}
        </span>
      </td>
      <td className="text-secondary px-2 py-1.5 text-left">
        {formatExpiry(a.expiry, a.dte_at_alert)}
      </td>
      <td className={`px-2 py-1.5 text-right ${deltaColor}`}>
        {formatSignedInt(a.distance_from_spot)}{' '}
        <span className="text-muted text-[10px]">
          ({formatPct(a.distance_pct, { signed: true, digits: 1 })})
        </span>
      </td>
      <td className="px-2 py-1.5 text-right">
        <span className="text-secondary text-[12px] font-bold">
          {formatPremium(a.total_premium, { kDigits: 0 })}
        </span>
      </td>
      <td className="text-secondary px-2 py-1.5 text-right">
        {formatAskPct(a.ask_side_ratio)}
      </td>
      <td className="text-secondary px-2 py-1.5 text-right">
        {Math.round(a.total_size).toLocaleString()}
      </td>
      <td className="text-secondary px-2 py-1.5 text-right">
        {formatVolOi(a.volume_oi_ratio)}
      </td>
      <td className="px-2 py-1.5">
        <div className="flex flex-wrap gap-1">
          <span
            aria-label={`Rule ${a.alert_rule}`}
            title={a.alert_rule}
            className="text-muted border-edge inline-block rounded-full border bg-slate-500/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold whitespace-nowrap"
          >
            {shortRule(a.alert_rule)}
          </span>
          {a.has_multileg && (
            <span
              aria-label="Multileg"
              className="inline-block rounded-full border border-indigo-500/30 bg-indigo-500/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold whitespace-nowrap text-indigo-300"
            >
              ML
            </span>
          )}
          {a.has_sweep && (
            <span
              aria-label="Sweep"
              className="inline-block rounded-full border border-sky-500/30 bg-sky-500/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold whitespace-nowrap text-sky-300"
            >
              SWP
            </span>
          )}
          {a.has_floor && (
            <span
              aria-label="Floor"
              className="inline-block rounded-full border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold whitespace-nowrap text-amber-300"
            >
              FLR
            </span>
          )}
        </div>
      </td>
      <td className="text-muted px-2 py-1.5 text-right">
        {formatAge(a.age_minutes)}
      </td>
    </tr>
  );
}

// ============================================================
// MAIN
// ============================================================

export function WhalePositioningTable({
  alerts,
  totalPremium,
  alertCount,
  isLoading,
  error,
  className,
}: WhalePositioningTableProps) {
  const [sliderPremium, setSliderPremium] = useState<number>(SLIDER_DEFAULT);

  // Apply the slider filter before sorting so the visible count + sort
  // both reflect the filtered subset. At slider floor this is a no-op.
  const filteredAlerts = useMemo(
    () => alerts.filter((a) => a.total_premium >= sliderPremium),
    [alerts, sliderPremium],
  );

  const {
    sortedRows: sortedAlerts,
    sortKey,
    sortDir,
    setSort,
  } = useTableSort<WhaleAlert, SortColumn>({
    rows: filteredAlerts,
    keyExtractors: KEY_EXTRACTORS,
    defaultKey: 'total_premium',
    defaultDir: 'desc',
  });

  const visibleCount = filteredAlerts.length;
  const totalCount = alerts.length;
  const showEmpty = !isLoading && !error && alerts.length === 0;
  const showLoading = isLoading && alerts.length === 0;
  const showError = !!error;
  // When some alerts exist but none pass the slider, render a distinct
  // "no matches" state instead of the "no whale flow today" empty message.
  const showFilteredEmpty =
    !showError && !showLoading && totalCount > 0 && visibleCount === 0;

  return (
    <div
      className={`border-edge bg-surface overflow-hidden rounded-lg border ${className ?? ''}`}
    >
      {/* Min-premium slider — visible count, total, and the slider itself
          are filter-dependent so they stay inside the body rather than
          bubbling up to the SectionBox header. */}
      <div className="border-edge/60 bg-surface-alt/40 flex flex-wrap items-center gap-3 border-b px-3 py-2">
        <label
          htmlFor="whale-min-premium"
          className="text-tertiary font-sans text-[10px] font-semibold tracking-wider whitespace-nowrap uppercase"
        >
          Premium ≥{' '}
          <span className="text-secondary font-mono text-[11px] normal-case">
            {formatSliderPremium(sliderPremium)}
          </span>
        </label>
        <input
          id="whale-min-premium"
          type="range"
          min={SLIDER_MIN}
          max={SLIDER_MAX}
          step={SLIDER_STEP}
          value={sliderPremium}
          onChange={(e) =>
            setSliderPremium(Number.parseInt(e.target.value, 10))
          }
          aria-label="Minimum whale premium filter"
          aria-valuemin={SLIDER_MIN}
          aria-valuemax={SLIDER_MAX}
          aria-valuenow={sliderPremium}
          aria-valuetext={formatSliderPremium(sliderPremium)}
          className="max-w-[320px] min-w-[120px] flex-1 cursor-pointer accent-sky-400"
        />
        <span className="text-muted font-mono text-[10px]">
          {formatSliderPremium(SLIDER_MIN)} – {formatSliderPremium(SLIDER_MAX)}
        </span>
        <span
          className="text-muted ml-auto font-mono text-[10px]"
          data-testid="whale-alert-count"
          title={`Server reported ${alertCount} ${alertCount === 1 ? 'alert' : 'alerts'} in window`}
        >
          {totalCount === visibleCount
            ? `${totalCount} ${totalCount === 1 ? 'alert' : 'alerts'} ≥ ${formatSliderPremium(sliderPremium)}`
            : `${visibleCount} of ${totalCount} alerts ≥ ${formatSliderPremium(sliderPremium)}`}
        </span>
        {totalPremium > 0 && (
          <span className="text-secondary font-mono text-[10px]">
            Σ{' '}
            <span className="text-amber-300">
              {formatPremium(totalPremium, { kDigits: 0 })}
            </span>
          </span>
        )}
      </div>

      {/* Body */}
      {showError && (
        <div
          className="px-3 py-6 text-center font-sans text-[12px] text-rose-300"
          role="status"
        >
          Couldn&apos;t load whale flow
        </div>
      )}

      {!showError && showLoading && (
        <div
          className="text-muted px-3 py-6 text-center font-sans text-[12px]"
          role="status"
        >
          Loading whale positioning…
        </div>
      )}

      {!showError && showEmpty && (
        <div
          className="text-muted px-3 py-6 text-center font-sans text-[12px]"
          role="status"
        >
          No whale-sized flow today (≥$500K, ≤7 DTE)
        </div>
      )}

      {showFilteredEmpty && (
        <div
          className="text-muted px-3 py-6 text-center font-sans text-[12px]"
          role="status"
        >
          No alerts at or above {formatSliderPremium(sliderPremium)} — drag the
          slider left to widen the filter.
        </div>
      )}

      {!showError && !showEmpty && !showLoading && !showFilteredEmpty && (
        <div className="max-h-[540px] overflow-auto">
          <table
            className="w-full border-collapse font-mono text-[11px]"
            aria-label="Whale positioning alerts"
          >
            <thead>
              <tr>
                <SortableHeader<SortColumn>
                  label="Strike"
                  sortKey="strike"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={setSort}
                  align="right"
                />
                <SortableHeader<SortColumn>
                  label="Side"
                  sortKey="type"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={setSort}
                  align="center"
                />
                <SortableHeader<SortColumn>
                  label="Expiry"
                  sortKey="dte_at_alert"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={setSort}
                  align="left"
                  tooltip="Expiry date and DTE at time of alert"
                />
                <SortableHeader<SortColumn>
                  label="Distance"
                  sortKey="distance_from_spot"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={setSort}
                  align="right"
                  tooltip="Points and percent from spot at alert time"
                />
                <SortableHeader<SortColumn>
                  label="Premium"
                  sortKey="total_premium"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={setSort}
                  align="right"
                  tooltip="Aggregate premium traded on this option_chain today"
                />
                <SortableHeader<SortColumn>
                  label="Ask %"
                  sortKey="ask_side_ratio"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={setSort}
                  align="right"
                  tooltip="Share of premium filled at/above ask"
                />
                <SortableHeader<SortColumn>
                  label="Size"
                  sortKey="total_size"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={setSort}
                  align="right"
                  tooltip="Total contracts transacted in aggregated alerts"
                />
                <SortableHeader<SortColumn>
                  label="Vol/OI"
                  sortKey="volume_oi_ratio"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={setSort}
                  align="right"
                  tooltip="Day volume vs. open interest — new-position signal"
                />
                <th
                  scope="col"
                  className="bg-surface-alt border-edge-heavy sticky top-0 border-b px-2 py-2 text-left font-sans text-[10px] font-semibold tracking-wider uppercase"
                  style={{ color: 'var(--color-tertiary)' }}
                >
                  Rule
                </th>
                <SortableHeader<SortColumn>
                  label="Age"
                  sortKey="age_minutes"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={setSort}
                  align="right"
                  tooltip="Minutes since the alert was emitted"
                />
              </tr>
            </thead>
            <tbody>
              {sortedAlerts.map((a) => (
                <WhaleAlertRow key={a.option_chain} alert={a} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
