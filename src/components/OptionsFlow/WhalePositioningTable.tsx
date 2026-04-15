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

type SortDirection = 'asc' | 'desc';

export interface WhalePositioningTableProps {
  alerts: WhaleAlert[];
  spot: number | null;
  lastUpdated: string | null;
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
// FORMATTERS
// ============================================================

/**
 * Compact dollar premium: `$206.5M`, `$1.4M`, `$850K`, `$0`. Matches the
 * conversational shorthand the flow desk uses so the biggest numbers read
 * at a glance without mental math.
 */
function formatPremium(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

function formatAskPct(ratio: number | null): string {
  if (ratio == null || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(1)}%`;
}

function formatVolOi(ratio: number): string {
  if (!Number.isFinite(ratio)) return '—';
  return `${ratio.toFixed(1)}×`;
}

function formatSignedInt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const rounded = Math.round(n);
  if (rounded === 0) return '0';
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

function formatPctSigned(frac: number): string {
  if (!Number.isFinite(frac)) return '—';
  const pct = frac * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
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

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return (
    new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: 'America/Chicago',
    }).format(d) + ' CT'
  );
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
// SORT HELPERS
// ============================================================

/**
 * Numeric sort key for a non-nullable column. `ask_side_ratio` is handled
 * separately in `sortAlerts` because the server returns null for alerts
 * with zero / non-finite total_premium — a null can't be meaningfully
 * compared against a signed ratio in either direction.
 */
function getSortValue(
  row: WhaleAlert,
  col: Exclude<SortColumn, 'ask_side_ratio'>,
): number {
  switch (col) {
    case 'strike':
      return row.strike;
    case 'type':
      return row.type === 'call' ? 1 : 0;
    case 'dte_at_alert':
      return row.dte_at_alert;
    case 'distance_from_spot':
      return row.distance_from_spot;
    case 'total_premium':
      return row.total_premium;
    case 'total_size':
      return row.total_size;
    case 'volume_oi_ratio':
      return row.volume_oi_ratio;
    case 'age_minutes':
      return row.age_minutes;
  }
}

function sortAlerts(
  rows: WhaleAlert[],
  col: SortColumn,
  dir: SortDirection,
): WhaleAlert[] {
  if (col === 'ask_side_ratio') {
    // Null ask_side_ratio rows always sink to the bottom regardless of
    // direction — mirrors the Net GEX null-partition in OptionsFlowTable.
    // Partition first, sort the present values per direction, then append
    // the null tail unchanged.
    const withRatio: { row: WhaleAlert; ratio: number }[] = [];
    const withoutRatio: WhaleAlert[] = [];
    for (const row of rows) {
      if (row.ask_side_ratio == null) {
        withoutRatio.push(row);
      } else {
        withRatio.push({ row, ratio: row.ask_side_ratio });
      }
    }
    withRatio.sort((a, b) => {
      if (a.ratio === b.ratio) return 0;
      return a.ratio < b.ratio ? -1 : 1;
    });
    const ordered = dir === 'desc' ? withRatio.reverse() : withRatio;
    return [...ordered.map((x) => x.row), ...withoutRatio];
  }

  const sorted = [...rows].sort((a, b) => {
    const av = getSortValue(a, col);
    const bv = getSortValue(b, col);
    if (av === bv) return 0;
    return av < bv ? -1 : 1;
  });
  return dir === 'desc' ? sorted.reverse() : sorted;
}

// ============================================================
// SUB-COMPONENTS
// ============================================================

function SortableHeader({
  label,
  column,
  currentColumn,
  currentDirection,
  onSort,
  align = 'right',
  title,
}: {
  label: string;
  column: SortColumn;
  currentColumn: SortColumn;
  currentDirection: SortDirection;
  onSort: (col: SortColumn) => void;
  align?: 'left' | 'right' | 'center';
  title?: string;
}) {
  const active = column === currentColumn;
  const ariaSort: 'ascending' | 'descending' | 'none' = active
    ? currentDirection === 'asc'
      ? 'ascending'
      : 'descending'
    : 'none';
  const alignClass =
    align === 'left'
      ? 'text-left'
      : align === 'center'
        ? 'text-center'
        : 'text-right';
  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className={`bg-surface-alt border-edge-heavy sticky top-0 border-b px-2 py-2 font-sans text-[10px] font-semibold tracking-wider uppercase ${alignClass}`}
      style={{ color: 'var(--color-tertiary)' }}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        title={title}
        className="inline-flex cursor-pointer items-center gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
      >
        <span>{label}</span>
        <span
          aria-hidden="true"
          className={`font-mono text-[9px] ${active ? 'text-secondary' : 'text-muted/40'}`}
        >
          {active ? (currentDirection === 'asc' ? '▲' : '▼') : '▲'}
        </span>
      </button>
    </th>
  );
}

// ============================================================
// MAIN
// ============================================================

export function WhalePositioningTable({
  alerts,
  spot,
  lastUpdated,
  totalPremium,
  alertCount,
  isLoading,
  error,
  className,
}: WhalePositioningTableProps) {
  const [sortColumn, setSortColumn] = useState<SortColumn>('total_premium');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [sliderPremium, setSliderPremium] = useState<number>(SLIDER_DEFAULT);

  const handleSort = (col: SortColumn) => {
    if (col === sortColumn) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(col);
      setSortDirection('desc');
    }
  };

  // Apply the slider filter before sorting so the visible count + sort
  // both reflect the filtered subset. At slider floor this is a no-op.
  const filteredAlerts = useMemo(
    () => alerts.filter((a) => a.total_premium >= sliderPremium),
    [alerts, sliderPremium],
  );

  const sortedAlerts = useMemo(
    () => sortAlerts(filteredAlerts, sortColumn, sortDirection),
    [filteredAlerts, sortColumn, sortDirection],
  );

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
      {/* Header strip */}
      <div className="border-edge-heavy bg-surface-alt flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex items-baseline gap-2">
          <h3 className="text-secondary font-sans text-[12px] font-semibold tracking-wider uppercase">
            Whale Positioning
          </h3>
          <span className="text-muted font-mono text-[10px]">
            today · 0-7 DTE
          </span>
        </div>
        <div className="flex items-center gap-3 font-mono text-[10px]">
          {spot !== null && (
            <span className="text-secondary">
              Spot{' '}
              <span className="text-sky-300">
                {spot.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
            </span>
          )}
          <span
            className="text-muted"
            data-testid="whale-alert-count"
            title={`Server reported ${alertCount} ${alertCount === 1 ? 'alert' : 'alerts'} in window`}
          >
            {totalCount === visibleCount
              ? `${totalCount} ${totalCount === 1 ? 'alert' : 'alerts'} ≥ ${formatSliderPremium(sliderPremium)}`
              : `${visibleCount} of ${totalCount} alerts ≥ ${formatSliderPremium(sliderPremium)}`}
          </span>
          {totalPremium > 0 && (
            <span className="text-secondary">
              Σ{' '}
              <span className="text-amber-300">
                {formatPremium(totalPremium)}
              </span>
            </span>
          )}
          <span className="text-muted">Updated {formatTime(lastUpdated)}</span>
        </div>
      </div>

      {/* Min-premium slider */}
      <div className="border-edge/60 bg-surface-alt/40 flex flex-wrap items-center gap-3 border-b px-3 py-2">
        <label
          htmlFor="whale-min-premium"
          className="text-tertiary font-sans text-[10px] font-semibold tracking-wider uppercase whitespace-nowrap"
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
          className="accent-sky-400 flex-1 min-w-[120px] max-w-[320px] cursor-pointer"
        />
        <span className="text-muted font-mono text-[10px]">
          {formatSliderPremium(SLIDER_MIN)} – {formatSliderPremium(SLIDER_MAX)}
        </span>
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
                <SortableHeader
                  label="Strike"
                  column="strike"
                  currentColumn={sortColumn}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                />
                <SortableHeader
                  label="Side"
                  column="type"
                  currentColumn={sortColumn}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  align="center"
                />
                <SortableHeader
                  label="Expiry"
                  column="dte_at_alert"
                  currentColumn={sortColumn}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  align="left"
                  title="Expiry date and DTE at time of alert"
                />
                <SortableHeader
                  label="Distance"
                  column="distance_from_spot"
                  currentColumn={sortColumn}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  title="Points and percent from spot at alert time"
                />
                <SortableHeader
                  label="Premium"
                  column="total_premium"
                  currentColumn={sortColumn}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  title="Aggregate premium traded on this option_chain today"
                />
                <SortableHeader
                  label="Ask %"
                  column="ask_side_ratio"
                  currentColumn={sortColumn}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  title="Share of premium filled at/above ask"
                />
                <SortableHeader
                  label="Size"
                  column="total_size"
                  currentColumn={sortColumn}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  title="Total contracts transacted in aggregated alerts"
                />
                <SortableHeader
                  label="Vol/OI"
                  column="volume_oi_ratio"
                  currentColumn={sortColumn}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  title="Day volume vs. open interest — new-position signal"
                />
                <th
                  scope="col"
                  className="bg-surface-alt border-edge-heavy sticky top-0 border-b px-2 py-2 text-left font-sans text-[10px] font-semibold tracking-wider uppercase"
                  style={{ color: 'var(--color-tertiary)' }}
                >
                  Rule
                </th>
                <SortableHeader
                  label="Age"
                  column="age_minutes"
                  currentColumn={sortColumn}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  title="Minutes since the alert was emitted"
                />
              </tr>
            </thead>
            <tbody>
              {sortedAlerts.map((a) => {
                const deltaColor =
                  a.distance_from_spot > 0
                    ? 'text-emerald-400'
                    : a.distance_from_spot < 0
                      ? 'text-rose-400'
                      : 'text-slate-400';
                const sideColor =
                  a.type === 'call' ? 'text-emerald-400' : 'text-rose-400';
                const sideLabel = a.type === 'call' ? 'C' : 'P';
                return (
                  <tr
                    key={a.option_chain}
                    className="border-edge/30 hover:bg-surface-alt/60 border-b transition-colors"
                  >
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
                        ({formatPctSigned(a.distance_pct)})
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <span className="text-secondary text-[12px] font-bold">
                        {formatPremium(a.total_premium)}
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
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
