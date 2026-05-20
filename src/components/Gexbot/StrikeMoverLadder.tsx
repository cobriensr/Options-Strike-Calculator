/**
 * StrikeMoverLadder — SPX-spine, spot-anchored ladder of strike movers
 * focused on 0DTE trading. Replaces the StrikeMoverTicker chip wall.
 *
 * The body shows at most 5 ceilings above spot and 5 floors below, with
 * an ATM-magnet band rendered between them. Cross-asset confirmation is
 * shown as symbol dots + a 3✓/2✓ badge. Position-aware coloring distinguishes
 * a strengthening level from a failing one (see colors.ts).
 *
 * Data: useGexbotData({view:'maxchange-winners'}) for the rows; SPX spot
 * is threaded as a prop from App.tsx (Schwab realtime) — GEXBot's
 * snapshots-latest is intentionally NOT used here because its minute
 * cadence can lag the divider position by ~60 s during fast moves.
 *
 * Spec: docs/superpowers/specs/strike-mover-ladder-2026-05-19.md
 */

import { memo, useMemo, useState } from 'react';

import { useGexbotData } from '../../hooks/useGexbotData';
import {
  buildLadderRows,
  sortAndCapRows,
} from './strike-mover-ladder/aggregation';
import { classifyRow } from './strike-mover-ladder/colors';
import {
  CATEGORY_LABEL,
  MIN_BAR_PCT,
  type AggregatedRow,
  type CategoryTab,
} from './strike-mover-ladder/types';

interface StrikeMoverLadderProps {
  marketOpen: boolean;
  /** SPX last price from Schwab via useMarketData in App.tsx. Null when unauth or pre-fetch. */
  spxSpot: number | null;
}

const SPEC = { view: 'maxchange-winners' as const };
const TABS: readonly CategoryTab[] = [
  'gex',
  'gamma',
  'delta',
  'vanna',
  'charm',
];

function formatChange(value: number): string {
  const abs = Math.abs(value);
  const sign = value >= 0 ? '+' : '−';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

function formatSpot(spot: number): string {
  // Number.parseFloat strips trailing zeros and the trailing dot.
  // Use typographic minus (−) to match formatChange convention.
  const abs = Math.abs(spot);
  const sign = spot >= 0 ? '' : '−';
  return `${sign}${Number.parseFloat(abs.toFixed(2)).toString()}`;
}

function StrikeMoverLadderInner({
  marketOpen,
  spxSpot,
}: StrikeMoverLadderProps) {
  const { rows: rawRows, loading, error } = useGexbotData(SPEC, marketOpen);
  const [activeTab, setActiveTab] = useState<CategoryTab>('gex');

  const visibleRows = useMemo<AggregatedRow[]>(() => {
    if (spxSpot == null) return [];
    const built = buildLadderRows(rawRows, activeTab);
    return sortAndCapRows(built, spxSpot);
  }, [rawRows, activeTab, spxSpot]);

  const maxAbsChange = useMemo(
    () => visibleRows.reduce((m, r) => Math.max(m, Math.abs(r.change)), 0),
    [visibleRows],
  );

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="strike-mover-ladder-loading"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        Strike Mover Ladder — loading…
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="strike-mover-ladder-error"
        className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/80"
      >
        Strike Mover Ladder — {error}
      </div>
    );
  }

  const hasRows = visibleRows.length > 0;

  return (
    <div
      data-testid="strike-mover-ladder"
      className="rounded-md border border-white/5 bg-white/[0.02]"
    >
      <div className="flex items-baseline justify-between border-b border-white/5 px-3 py-2">
        <span className="text-tertiary text-[10px] tracking-wide uppercase">
          Strike Movers — SPX 0DTE
          {spxSpot != null && ` · spot ${formatSpot(spxSpot)}`}
        </span>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-white/5 px-3 py-1.5">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            aria-pressed={activeTab === tab}
            className={`rounded-sm px-2 py-0.5 text-[11px] tabular-nums transition ${
              activeTab === tab
                ? 'bg-white/10 text-white'
                : 'text-tertiary hover:bg-white/5'
            }`}
          >
            {CATEGORY_LABEL[tab]}
          </button>
        ))}
      </div>

      {hasRows ? (
        <LadderBody
          rows={visibleRows}
          spot={spxSpot!}
          maxAbsChange={maxAbsChange}
        />
      ) : (
        <div
          role="status"
          aria-live="polite"
          data-testid="strike-mover-ladder-empty"
          className="text-tertiary px-3 py-3 text-xs"
        >
          No SPX winners in last 5 min for {CATEGORY_LABEL[activeTab]} (0DTE)
        </div>
      )}
    </div>
  );
}

interface LadderBodyProps {
  rows: AggregatedRow[];
  spot: number;
  maxAbsChange: number;
}

const LadderBody = memo(function LadderBody({
  rows,
  spot,
  maxAbsChange,
}: LadderBodyProps) {
  // Find the index where to insert the spot divider — between the
  // last ceiling (strike > spot) and the first floor (strike <= spot).
  const dividerIdx = rows.findIndex((r) => r.strike <= spot);

  return (
    <div className="px-3 py-2">
      {rows.map((row, idx) => (
        <div key={row.strike}>
          {idx === dividerIdx && <SpotDivider spot={spot} />}
          <LadderRow row={row} spot={spot} maxAbsChange={maxAbsChange} />
        </div>
      ))}
      {/* Edge: all rows are above spot — divider goes at the bottom. */}
      {dividerIdx === -1 && rows.length > 0 && <SpotDivider spot={spot} />}
    </div>
  );
});

const SpotDivider = memo(function SpotDivider({ spot }: { spot: number }) {
  return (
    <div
      data-testid="strike-mover-ladder-spot-divider"
      className="my-1 flex items-center gap-2 text-[10px] tracking-wide text-white/40 uppercase"
    >
      <span className="flex-1 border-t border-white/20" />
      <span className="font-medium">SPX spot {formatSpot(spot)}</span>
      <span className="flex-1 border-t border-white/20" />
    </div>
  );
});

interface LadderRowProps {
  row: AggregatedRow;
  spot: number;
  maxAbsChange: number;
}

const LadderRow = memo(function LadderRow({
  row,
  spot,
  maxAbsChange,
}: LadderRowProps) {
  const classified = classifyRow(row.strike, spot, row.change);
  const barPct =
    maxAbsChange > 0
      ? Math.max(MIN_BAR_PCT, (Math.abs(row.change) / maxAbsChange) * 100)
      : 0;
  const barColor =
    classified.tone === 'magnet'
      ? 'bg-violet-400/50'
      : row.change >= 0
        ? 'bg-emerald-400/50'
        : 'bg-rose-400/50';

  return (
    <div
      data-testid={`strike-mover-ladder-row-${row.strike}`}
      className={`flex items-center gap-2 py-0.5 text-[11px] tabular-nums ${classified.toneClass}`}
    >
      <span className="w-12 font-medium">{row.strike}</span>

      {classified.marker === '◈ ATM' && (
        <span className="text-[10px] font-semibold tracking-wide">◈ ATM</span>
      )}

      <span className="text-tertiary flex gap-1">
        {row.symbols.map((s) => (
          <span key={s} role="img" aria-label={s}>
            ▪{s === 'ES_SPX' ? 'ES' : s}
          </span>
        ))}
      </span>

      {row.confirmCount > 0 && (
        <span className="rounded-sm bg-white/10 px-1 text-[10px] font-semibold">
          {row.confirmCount}✓
        </span>
      )}

      <span className="ml-auto font-mono">{formatChange(row.change)}</span>

      <span
        aria-hidden="true"
        className="h-1.5 w-16 overflow-hidden rounded-sm bg-white/5"
      >
        <span
          className={`block h-full ${barColor}`}
          style={{ width: `${barPct}%` }}
        />
      </span>

      {/*
        Status icon column. ⚡ (largest mover in visible set) takes
        precedence over ▽ (direction mismatch — e.g. a floor that's
        weakening or a ceiling that's strengthening unexpectedly). A
        row that's both will show only ⚡; the ▽ signal would be
        redundant for the largest mover since users will inspect it
        regardless.
      */}
      <span className="w-5 text-center">
        {row.isLargestMover ? '⚡' : classified.marker === '▽' ? '▽' : ''}
      </span>
    </div>
  );
});

export const StrikeMoverLadder = memo(StrikeMoverLadderInner);
