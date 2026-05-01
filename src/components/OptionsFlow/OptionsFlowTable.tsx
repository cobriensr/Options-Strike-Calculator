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

import type { RankedStrike } from '../../hooks/useOptionsFlow';
import {
  AGGRESSION_LABEL,
  AGGRESSION_TOOLTIP,
  classifyAggression,
} from '../../utils/flow-aggression';
import {
  formatAskPct,
  formatGex,
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
  | 'gex'
  | 'type'
  | 'distance_from_spot'
  | 'distance_pct'
  | 'total_premium'
  | 'ask_side_ratio'
  | 'volume_oi_ratio'
  | 'hit_count'
  | 'score';

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
// SORT KEY EXTRACTORS
// ============================================================

/**
 * Build the per-column extractor map. The `gex` column needs the live
 * `gexByStrike` map in scope so it returns null for missing strikes
 * (which `useTableSort` then partitions into the always-bottom tail).
 * Memoization happens upstream where this is called.
 */
function buildKeyExtractors(
  gexByStrike: Map<number, number> | undefined,
): KeyExtractors<RankedStrike, SortColumn> {
  return {
    strike: (row) => row.strike,
    // Sort puts (0) before calls (1) ascending; calls first descending.
    type: (row) => (row.type === 'call' ? 1 : 0),
    distance_from_spot: (row) => row.distance_from_spot,
    distance_pct: (row) => row.distance_pct,
    total_premium: (row) => row.total_premium,
    ask_side_ratio: (row) => row.ask_side_ratio,
    volume_oi_ratio: (row) => row.volume_oi_ratio,
    hit_count: (row) => row.hit_count,
    score: (row) => row.score,
    // Strikes missing from the GEX lookup map return null so the hook
    // partitions them into the null-tail (always last regardless of
    // direction). A missing GEX dollar amount can't be meaningfully
    // compared against a signed magnitude in either direction.
    gex: (row) => gexByStrike?.get(row.strike) ?? null,
  };
}

// ============================================================
// SUB-COMPONENTS
// ============================================================

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

/**
 * One ranked-strike data row. Extracted from the table body so the
 * derived per-row classifications (aggression, GEX cell branch, badge
 * fan-out) read as a self-contained unit and the table render loop
 * stays a one-line `.map`.
 */
function OptionsFlowRow({
  strike: s,
  gexByStrike,
}: {
  strike: RankedStrike;
  gexByStrike: Map<number, number> | undefined;
}) {
  const deltaColor =
    s.distance_from_spot > 0
      ? 'text-emerald-400'
      : s.distance_from_spot < 0
        ? 'text-rose-400'
        : 'text-slate-400';
  const sideColor = s.type === 'call' ? 'text-emerald-400' : 'text-rose-400';
  const sideLabel = s.type === 'call' ? 'C' : 'P';
  const rowHighlight = s.has_ascending_fill
    ? 'border-l-2 border-l-emerald-400/60'
    : '';
  const aggression = classifyAggression(s.ask_side_ratio);
  // `null` (missing data) and `'mixed'` both render quiet — no row tint
  // and no badge — so missing-data rows don't visually collide with
  // truly-absorbed rows.
  const aggressionTint =
    aggression === 'aggressive'
      ? 'bg-emerald-500/[0.03]'
      : aggression === 'absorbed'
        ? 'bg-amber-500/[0.03]'
        : '';
  const gexValue = gexByStrike?.get(s.strike);
  // Em-dash for missing; colored signed-dollar otherwise. The leading
  // +/- in formatGex is the non-color affordance so assistive tech and
  // colorblind users read the sign directly.
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
        {formatPct(s.distance_pct, { signed: true, digits: 2 })}
      </td>
      <td className="text-secondary px-2 py-1.5 text-right">
        {formatPremium(s.total_premium, { kDigits: 1 })}
      </td>
      <td className="text-secondary px-2 py-1.5 text-right">
        {formatAskPct(s.ask_side_ratio)}
      </td>
      <td className="text-secondary px-2 py-1.5 text-right">
        {Number.isFinite(s.volume_oi_ratio)
          ? s.volume_oi_ratio > 1
            ? `${s.volume_oi_ratio.toFixed(2)}×`
            : s.volume_oi_ratio.toFixed(2)
          : '—'}
      </td>
      <td className="text-secondary px-2 py-1.5 text-right">{s.hit_count}</td>
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
          {s.has_multileg && <TagBadge label="Multileg" variant="multileg" />}
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
  // Rebuild extractors when the GEX lookup changes — only the `gex`
  // column closes over it, but the controller hashes the whole record so
  // a fresh map identity is needed for the sorted output to refresh.
  const keyExtractors = buildKeyExtractors(gexByStrike);

  const {
    sortedRows: sortedStrikes,
    sortKey,
    sortDir,
    setSort,
  } = useTableSort<RankedStrike, SortColumn>({
    rows: strikes,
    keyExtractors,
    defaultKey: 'score',
    defaultDir: 'desc',
  });

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
                <SortableHeader<SortColumn>
                  label="Strike"
                  sortKey="strike"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={setSort}
                  align="right"
                />
                <SortableHeader<SortColumn>
                  label="Net GEX"
                  sortKey="gex"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={setSort}
                  align="right"
                  tooltip="Dealer gamma exposure at strike (signed dollars). + = long-gamma magnet; − = short-gamma wall."
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
                  label="Δ Spot"
                  sortKey="distance_from_spot"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={setSort}
                  align="right"
                  tooltip="Point distance from current spot"
                />
                <SortableHeader<SortColumn>
                  label="Δ %"
                  sortKey="distance_pct"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={setSort}
                  align="right"
                  tooltip="Percent distance from current spot"
                />
                <SortableHeader<SortColumn>
                  label="Premium"
                  sortKey="total_premium"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={setSort}
                  align="right"
                  tooltip="Total premium traded at strike in window"
                />
                <SortableHeader<SortColumn>
                  label="Ask %"
                  sortKey="ask_side_ratio"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={setSort}
                  align="right"
                  tooltip="Share of volume filled at/above the ask"
                />
                <SortableHeader<SortColumn>
                  label="Vol/OI"
                  sortKey="volume_oi_ratio"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={setSort}
                  align="right"
                  tooltip="Volume relative to open interest"
                />
                <SortableHeader<SortColumn>
                  label="Hits"
                  sortKey="hit_count"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={setSort}
                  align="right"
                  tooltip="Distinct alerts at this strike in window"
                />
                <SortableHeader<SortColumn>
                  label="Score"
                  sortKey="score"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={setSort}
                  align="right"
                  tooltip="Composite ranking score"
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
              {sortedStrikes.map((s) => (
                <OptionsFlowRow
                  key={`${s.strike}-${s.type}`}
                  strike={s}
                  gexByStrike={gexByStrike}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
