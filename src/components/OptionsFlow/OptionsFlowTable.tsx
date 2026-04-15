/**
 * OptionsFlowTable — sortable table of ranked options-flow strikes.
 *
 * Renders the ranked strikes returned by `useOptionsFlow` as a dense,
 * keyboard-accessible table. Default sort is `score` descending. Column
 * headers are focusable buttons with `aria-sort` semantics so assistive
 * tech can announce the current sort state.
 *
 * Data handling:
 *   - Stateless with respect to fetching — parent owns the hook.
 *   - Only pure presentational state (sort column + direction) lives here.
 *   - Empty / loading / error states are rendered inline so the component
 *     can be mounted unconditionally while the window is quiet.
 *
 * Visual conventions are borrowed from `GexLandscape/StrikeTable`:
 *   - `bg-surface` / `border-edge` theme tokens (dark-mode default)
 *   - mono fonts for numeric columns, compact 10-12px type scale
 *   - row hover: `hover:bg-surface-alt/60`
 *   - ascending-fill rows receive a left emerald border — the strongest
 *     directional tell in the ranking system.
 */

import { useMemo, useState } from 'react';
import type { RankedStrike } from '../../hooks/useOptionsFlow';
import {
  AGGRESSION_LABEL,
  AGGRESSION_TOOLTIP,
  classifyAggression,
} from '../../utils/flow-aggression';

// ============================================================
// TYPES
// ============================================================

type SortColumn =
  | 'strike'
  | 'gex'
  | 'type'
  | 'distance_from_spot'
  | 'distance_pct'
  | 'total_premium'
  | 'ask_side_ratio'
  | 'volume_oi_ratio'
  | 'hit_count'
  | 'score';

type SortDirection = 'asc' | 'desc';

export interface OptionsFlowTableProps {
  strikes: RankedStrike[];
  isLoading: boolean;
  error: Error | null;
  windowMinutes?: number;
  className?: string;
  /**
   * Strike → signed dealer GEX dollars at that strike (positive = long-gamma
   * magnet, negative = short-gamma wall). When undefined or the strike is
   * absent from the map, the Net GEX cell renders "—" and sorts to the
   * bottom regardless of direction. Sourced from `useGexTarget().oi.leaderboard`.
   */
  gexByStrike?: Map<number, number>;
}

// ============================================================
// FORMATTERS — no external deps, only Intl.* primitives
// ============================================================

function formatPremium(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

function formatPct(frac: number, withSign = false): string {
  if (!Number.isFinite(frac)) return '—';
  const pct = frac * 100;
  const sign = withSign && pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

function formatAskPct(ratio: number): string {
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(1)}%`;
}

function formatVolOi(ratio: number): string {
  if (!Number.isFinite(ratio)) return '—';
  if (ratio > 1) return `${ratio.toFixed(2)}×`;
  return ratio.toFixed(2);
}

/**
 * Compact signed-dollar formatter for dealer GEX exposure. Matches the
 * sign-leading convention used by GexTarget's StrikeBox (`formatGex`) but
 * prefixes a `$` so the Options Flow column reads as currency on its own
 * (e.g. `+$120M`, `-$80M`). The leading `+`/`-` is the text affordance so
 * color is not the only signal.
 */
function formatGex(n: number): string {
  const abs = Math.abs(n);
  const sign = n >= 0 ? '+' : '-';
  if (abs >= 1_000_000_000)
    return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(0)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function formatSignedInt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const rounded = Math.round(n);
  if (rounded === 0) return '0';
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

// ============================================================
// SORT HELPERS
// ============================================================

/**
 * Numeric sort key for a non-GEX column. `gex` is handled separately in
 * `sortStrikes` because its "missing values always last" rule doesn't
 * compose with the shared asc/desc reverse trick.
 */
function getSortValue(
  row: RankedStrike,
  col: Exclude<SortColumn, 'gex'>,
): number {
  switch (col) {
    case 'strike':
      return row.strike;
    case 'type':
      // Sort puts before calls so same-strike pairs group; arbitrary but stable
      return row.type === 'call' ? 1 : 0;
    case 'distance_from_spot':
      return row.distance_from_spot;
    case 'distance_pct':
      return row.distance_pct;
    case 'total_premium':
      return row.total_premium;
    case 'ask_side_ratio':
      return row.ask_side_ratio;
    case 'volume_oi_ratio':
      return row.volume_oi_ratio;
    case 'hit_count':
      return row.hit_count;
    case 'score':
      return row.score;
  }
}

function sortStrikes(
  rows: RankedStrike[],
  col: SortColumn,
  dir: SortDirection,
  gexByStrike: Map<number, number> | undefined,
): RankedStrike[] {
  if (col === 'gex') {
    // Missing values always sink to the bottom regardless of direction —
    // a nullish Net GEX can't be meaningfully compared against signed
    // dollar magnitudes in either direction. Partition first, sort the
    // present values per direction, then append the missing tail.
    const withGex: { row: RankedStrike; gex: number }[] = [];
    const withoutGex: RankedStrike[] = [];
    for (const row of rows) {
      const gex = gexByStrike?.get(row.strike);
      if (gex == null) {
        withoutGex.push(row);
      } else {
        withGex.push({ row, gex });
      }
    }
    withGex.sort((a, b) => {
      if (a.gex === b.gex) return 0;
      return a.gex < b.gex ? -1 : 1;
    });
    const ordered = dir === 'desc' ? withGex.reverse() : withGex;
    return [...ordered.map((x) => x.row), ...withoutGex];
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

function TagBadge({
  label,
  variant,
  title,
}: {
  label: string;
  variant:
    | 'itm'
    | 'multileg'
    | 'ascending'
    | 'descending'
    | 'aggressive'
    | 'absorbed';
  title?: string;
}) {
  const variantClass = {
    itm: 'bg-amber-500/15 text-amber-300 border border-amber-500/30',
    multileg: 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/30',
    ascending:
      'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30',
    descending: 'bg-orange-500/15 text-orange-300 border border-orange-500/30',
    aggressive:
      'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40',
    absorbed: 'bg-amber-500/15 text-amber-300 border border-amber-500/40',
  }[variant];
  return (
    <span
      title={title}
      className={`inline-block rounded-full px-1.5 py-0.5 font-mono text-[9px] font-semibold whitespace-nowrap ${variantClass}`}
    >
      {label}
    </span>
  );
}

// ============================================================
// MAIN
// ============================================================

const DEFAULT_WINDOW_MINUTES = 15;

export function OptionsFlowTable({
  strikes,
  isLoading,
  error,
  windowMinutes = DEFAULT_WINDOW_MINUTES,
  className,
  gexByStrike,
}: OptionsFlowTableProps) {
  const [sortColumn, setSortColumn] = useState<SortColumn>('score');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const handleSort = (col: SortColumn) => {
    if (col === sortColumn) {
      // Toggle direction on the same column
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      // New column — default to descending (highest-value-first for numeric)
      setSortColumn(col);
      setSortDirection('desc');
    }
  };

  const sortedStrikes = useMemo(
    () => sortStrikes(strikes, sortColumn, sortDirection, gexByStrike),
    [strikes, sortColumn, sortDirection, gexByStrike],
  );

  const showEmpty = !isLoading && !error && strikes.length === 0;
  const showLoading = isLoading && strikes.length === 0;
  const showError = !!error;

  return (
    <div
      className={`border-edge bg-surface overflow-hidden rounded-lg border ${className ?? ''}`}
    >
      {/* Body */}
      {showError && (
        <div
          className="px-3 py-6 text-center font-sans text-[12px] text-rose-300"
          role="status"
        >
          Couldn&apos;t load flow
        </div>
      )}

      {!showError && showLoading && (
        <div
          className="text-muted px-3 py-6 text-center font-sans text-[12px]"
          role="status"
        >
          Loading flow…
        </div>
      )}

      {!showError && showEmpty && (
        <div
          className="text-muted px-3 py-6 text-center font-sans text-[12px]"
          role="status"
        >
          No active flow clusters in the last {windowMinutes} minutes
        </div>
      )}

      {!showError && !showEmpty && !showLoading && (
        <div className="max-h-[540px] overflow-auto">
          <table
            className="w-full border-collapse font-mono text-[11px]"
            aria-label="Options flow ranked strikes"
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
                  label="Net GEX"
                  column="gex"
                  currentColumn={sortColumn}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  title="Dealer gamma exposure at strike (signed dollars). + = long-gamma magnet; − = short-gamma wall."
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
                  label="Δ Spot"
                  column="distance_from_spot"
                  currentColumn={sortColumn}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  title="Point distance from current spot"
                />
                <SortableHeader
                  label="Δ %"
                  column="distance_pct"
                  currentColumn={sortColumn}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  title="Percent distance from current spot"
                />
                <SortableHeader
                  label="Premium"
                  column="total_premium"
                  currentColumn={sortColumn}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  title="Total premium traded at strike in window"
                />
                <SortableHeader
                  label="Ask %"
                  column="ask_side_ratio"
                  currentColumn={sortColumn}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  title="Share of volume filled at/above the ask"
                />
                <SortableHeader
                  label="Vol/OI"
                  column="volume_oi_ratio"
                  currentColumn={sortColumn}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  title="Volume relative to open interest"
                />
                <SortableHeader
                  label="Hits"
                  column="hit_count"
                  currentColumn={sortColumn}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  title="Distinct alerts at this strike in window"
                />
                <SortableHeader
                  label="Score"
                  column="score"
                  currentColumn={sortColumn}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  title="Composite ranking score"
                />
                <th
                  scope="col"
                  className="bg-surface-alt border-edge-heavy sticky top-0 border-b px-2 py-2 text-left font-sans text-[10px] font-semibold tracking-wider uppercase"
                  style={{ color: 'var(--color-tertiary)' }}
                >
                  Tags
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedStrikes.map((s) => {
                const deltaColor =
                  s.distance_from_spot > 0
                    ? 'text-emerald-400'
                    : s.distance_from_spot < 0
                      ? 'text-rose-400'
                      : 'text-slate-400';
                const sideColor =
                  s.type === 'call' ? 'text-emerald-400' : 'text-rose-400';
                const sideLabel = s.type === 'call' ? 'C' : 'P';
                const rowHighlight = s.has_ascending_fill
                  ? 'border-l-2 border-l-emerald-400/60'
                  : '';
                const aggression = classifyAggression(s.ask_side_ratio);
                // `null` (missing data) and `'mixed'` both render quiet — no
                // row tint and no badge — so missing-data rows don't visually
                // collide with truly-absorbed rows.
                const aggressionTint =
                  aggression === 'aggressive'
                    ? 'bg-emerald-500/[0.03]'
                    : aggression === 'absorbed'
                      ? 'bg-amber-500/[0.03]'
                      : '';
                const gexValue = gexByStrike?.get(s.strike);
                // Em-dash for missing; colored signed-dollar otherwise. The
                // leading +/- in formatGex is the non-color affordance so
                // assistive tech and colorblind users read the sign directly.
                const gexCell =
                  gexValue == null ? (
                    <td className="text-muted px-2 py-1.5 text-right">—</td>
                  ) : (
                    <td
                      className={`px-2 py-1.5 text-right font-mono text-[11px] ${
                        gexValue >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {formatGex(gexValue)}
                    </td>
                  );
                return (
                  <tr
                    key={`${s.strike}-${s.type}`}
                    className={`border-edge/30 hover:bg-surface-alt/60 border-b transition-colors ${rowHighlight} ${aggressionTint}`}
                  >
                    <td className="text-secondary px-2 py-1.5 text-right font-semibold">
                      {s.strike.toLocaleString(undefined, {
                        maximumFractionDigits: 2,
                      })}
                    </td>
                    {gexCell}
                    <td className="px-2 py-1.5 text-center">
                      <span
                        className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${sideColor} bg-current/10`}
                        aria-label={s.type === 'call' ? 'Call' : 'Put'}
                      >
                        {sideLabel}
                      </span>
                    </td>
                    <td className={`px-2 py-1.5 text-right ${deltaColor}`}>
                      {formatSignedInt(s.distance_from_spot)}
                    </td>
                    <td className={`px-2 py-1.5 text-right ${deltaColor}`}>
                      {formatPct(s.distance_pct, true)}
                    </td>
                    <td className="text-secondary px-2 py-1.5 text-right">
                      {formatPremium(s.total_premium)}
                    </td>
                    <td className="text-secondary px-2 py-1.5 text-right">
                      {formatAskPct(s.ask_side_ratio)}
                    </td>
                    <td className="text-secondary px-2 py-1.5 text-right">
                      {formatVolOi(s.volume_oi_ratio)}
                    </td>
                    <td className="text-secondary px-2 py-1.5 text-right">
                      {s.hit_count}
                    </td>
                    <td className="text-secondary px-2 py-1.5 text-right text-[12px] font-bold">
                      {s.score.toFixed(1)}
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex flex-wrap gap-1">
                        {aggression !== null && aggression !== 'mixed' && (
                          <TagBadge
                            label={AGGRESSION_LABEL[aggression]}
                            variant={aggression}
                            title={AGGRESSION_TOOLTIP[aggression]}
                          />
                        )}
                        {s.is_itm && <TagBadge label="ITM" variant="itm" />}
                        {s.has_multileg && (
                          <TagBadge label="Multileg" variant="multileg" />
                        )}
                        {s.has_ascending_fill && (
                          <TagBadge label="↑ Ascending" variant="ascending" />
                        )}
                        {s.has_descending_fill && (
                          <TagBadge label="↓ Descending" variant="descending" />
                        )}
                      </div>
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
