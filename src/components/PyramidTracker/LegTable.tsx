/**
 * LegTable — nested table of legs inside an expanded chain card.
 *
 * Columns (kept compact so the nested view doesn't overflow the section):
 *   1. Leg # + signal_type badge (CHoCH / BOS)
 *   2. Entry -> Stop price
 *   3. Stop distance (pts)
 *   4. Compression ratio (2-decimal; empty when null)
 *   5. Outcome — `+points / xR` with green/red/muted colouring
 *   6. OB concentration (POC %)
 *   7. Edit / Delete actions
 *
 * The nested view is not a full spreadsheet — the chain CSV export is the
 * source of truth for analysis. Here the goal is at-a-glance readability
 * during live trading or review.
 *
 * Empty state: when a chain has no legs yet, the table is replaced with a
 * "No legs logged yet" placeholder to avoid an empty <tbody>.
 */

import type { PyramidLeg } from '../../types/pyramid';

export interface LegTableProps {
  readonly legs: ReadonlyArray<PyramidLeg>;
  readonly onEditLeg: (leg: PyramidLeg) => void;
  readonly onDeleteLeg: (legId: string) => void;
}

/** Colour helper for the outcome cell (matches ChainCard net_points logic). */
function pointsColor(pts: number | null): string {
  if (pts == null || pts === 0) return 'text-muted';
  return pts > 0 ? 'text-success' : 'text-danger';
}

/** Format `+178 / 2.0R` style outcome; dashes substituted when either side is null. */
function formatOutcome(
  pts: number | null,
  r: number | null,
): { text: string; color: string } {
  if (pts == null && r == null) {
    return { text: '\u2014', color: 'text-muted' };
  }
  const ptsLabel =
    pts != null ? `${pts > 0 ? '+' : ''}${pts.toFixed(2)}` : '\u2014';
  const rLabel = r != null ? `${r.toFixed(1)}R` : '\u2014';
  return { text: `${ptsLabel} / ${rLabel}`, color: pointsColor(pts) };
}

/** Format `price -> stop` with 2-decimal precision; dash fallback for nulls. */
function formatEntryStop(entry: number | null, stop: number | null): string {
  const entryLabel = entry != null ? entry.toFixed(2) : '\u2014';
  const stopLabel = stop != null ? stop.toFixed(2) : '\u2014';
  return `${entryLabel} ${'\u2192'} ${stopLabel}`;
}

/** Nullable-number -> fixed-decimal string; empty string when null. */
function formatNumber(n: number | null, decimals: number): string {
  return n != null ? n.toFixed(decimals) : '';
}

/** Nullable-percentage -> "NN.N%"; empty when null. */
function formatPct(n: number | null): string {
  return n != null ? `${n.toFixed(1)}%` : '';
}

export default function LegTable({
  legs,
  onEditLeg,
  onDeleteLeg,
}: LegTableProps) {
  if (legs.length === 0) {
    return (
      <p className="text-muted py-3 text-center font-sans text-xs italic">
        No legs logged yet {'\u2014'} click {"'+ Leg'"} above to add one.
      </p>
    );
  }

  // Assert leg_number order in render (source should already provide this).
  const ordered = [...legs].sort((a, b) => a.leg_number - b.leg_number);

  return (
    <div className="overflow-x-auto" data-testid="pyramid-leg-table">
      <table className="w-full border-collapse font-mono text-[11px]">
        <caption className="sr-only">
          Legs within this chain, ordered by leg number.
        </caption>
        <thead>
          <tr className="bg-table-header text-muted text-left font-sans text-[10px] tracking-wider uppercase">
            <th scope="col" className="px-2 py-1.5 text-center">
              Leg
            </th>
            <th scope="col" className="px-2 py-1.5">
              Entry {'\u2192'} Stop
            </th>
            <th scope="col" className="px-2 py-1.5 text-right">
              Stop Dist
            </th>
            <th scope="col" className="px-2 py-1.5 text-right">
              Compression
            </th>
            <th scope="col" className="px-2 py-1.5 text-right">
              Outcome
            </th>
            <th scope="col" className="px-2 py-1.5 text-right">
              OB POC
            </th>
            <th scope="col" className="px-2 py-1.5 text-right">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((leg) => {
            const outcome = formatOutcome(leg.points_captured, leg.r_multiple);
            return (
              <tr key={leg.id} className="border-edge border-b last:border-b-0">
                <td className="px-2 py-1.5 text-center">
                  <div className="flex items-center justify-center gap-1.5">
                    <span className="text-primary font-semibold tabular-nums">
                      {leg.leg_number}
                    </span>
                    {leg.signal_type != null && (
                      <span className="bg-chip-bg text-muted rounded px-1.5 py-0.5 font-sans text-[9px] tracking-wider uppercase">
                        {leg.signal_type}
                      </span>
                    )}
                  </div>
                </td>
                <td className="text-primary px-2 py-1.5 tabular-nums">
                  {formatEntryStop(leg.entry_price, leg.stop_price)}
                </td>
                <td className="text-secondary px-2 py-1.5 text-right tabular-nums">
                  {formatNumber(leg.stop_distance_pts, 2)}
                </td>
                <td className="text-secondary px-2 py-1.5 text-right tabular-nums">
                  {formatNumber(leg.stop_compression_ratio, 2)}
                </td>
                <td
                  className={`${outcome.color} px-2 py-1.5 text-right tabular-nums`}
                >
                  {outcome.text}
                </td>
                <td className="text-secondary px-2 py-1.5 text-right tabular-nums">
                  {formatPct(leg.ob_poc_pct)}
                </td>
                <td className="px-2 py-1.5 text-right">
                  <div className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onEditLeg(leg)}
                      aria-label={`Edit leg ${leg.leg_number}`}
                      className="border-edge-strong bg-chip-bg text-primary hover:bg-surface cursor-pointer rounded border-[1.5px] px-1.5 py-0.5 font-sans text-[9px] font-semibold tracking-wider uppercase"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteLeg(leg.id)}
                      aria-label={`Delete leg ${leg.leg_number}`}
                      className="border-edge-strong bg-chip-bg text-danger hover:bg-surface cursor-pointer rounded border-[1.5px] px-1.5 py-0.5 font-sans text-[9px] font-semibold tracking-wider uppercase"
                    >
                      Del
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
