/**
 * PositionTable — Table container for open positions.
 *
 * Handles table headers, empty state, sorting, and delegates
 * row rendering to PositionRow sub-components.
 */

import { ScrollHint } from '../ui';
import type { HedgePosition, IronCondor, NakedPosition, Spread } from './types';
import { IronCondorRow, SpreadRow, HedgeRows, NakedRows } from './PositionRow';
import { cushionPct } from './position-helpers';

interface PositionTableProps {
  spreads: readonly Spread[];
  ironCondors: readonly IronCondor[];
  hedges: readonly HedgePosition[];
  nakedPositions: readonly NakedPosition[];
  spotPrice: number;
}

// ── Sort helpers ──────────────────────────────────────────

function sortedSpreads(
  spreads: readonly Spread[],
  spot: number,
): readonly Spread[] {
  const pcs = spreads
    .filter((s) => s.spreadType === 'PUT_CREDIT_SPREAD')
    .slice()
    .sort((a, b) => {
      const ca = cushionPct(a, spot) ?? 999;
      const cb = cushionPct(b, spot) ?? 999;
      return ca - cb;
    });
  const ccs = spreads
    .filter((s) => s.spreadType === 'CALL_CREDIT_SPREAD')
    .slice()
    .sort((a, b) => {
      const ca = cushionPct(a, spot) ?? 999;
      const cb = cushionPct(b, spot) ?? 999;
      return ca - cb;
    });
  return [...pcs, ...ccs];
}

// ── Header cells ──────────────────────────────────────────

const TH_CLASS =
  'bg-table-header text-tertiary px-3 py-2 text-left text-xs font-bold uppercase tracking-wider';
const TH_RIGHT =
  'bg-table-header text-tertiary px-3 py-2 text-right text-xs font-bold uppercase tracking-wider';

// ── Main Component ────────────────────────────────────────

export default function PositionTable({
  spreads,
  ironCondors,
  hedges,
  nakedPositions,
  spotPrice,
}: Readonly<PositionTableProps>) {
  const sorted = sortedSpreads(spreads, spotPrice);
  const hasPositions =
    ironCondors.length > 0 ||
    sorted.length > 0 ||
    hedges.length > 0 ||
    nakedPositions.length > 0;

  if (!hasPositions) {
    return (
      <div className="text-muted py-8 text-center font-sans text-sm">
        No open positions found in this statement.
      </div>
    );
  }

  return (
    <ScrollHint>
      <table
        className="w-full font-mono text-sm"
        role="table"
        aria-label="Open positions"
      >
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>
              Type
            </th>
            <th scope="col" className={TH_CLASS}>
              Strikes
            </th>
            <th scope="col" className={TH_RIGHT}>
              Qty
            </th>
            <th scope="col" className={TH_RIGHT}>
              Credit
            </th>
            <th scope="col" className={TH_RIGHT}>
              Open P&L
            </th>
            <th scope="col" className={TH_RIGHT}>
              % Max
            </th>
            <th scope="col" className={TH_RIGHT}>
              Max Loss
            </th>
            <th scope="col" className={TH_RIGHT}>
              Risk:Reward
            </th>
            <th scope="col" className={TH_RIGHT}>
              Breakeven
            </th>
            <th scope="col" className={TH_RIGHT}>
              Cushion
            </th>
            <th scope="col" className={TH_RIGHT}>
              Entry
            </th>
          </tr>
        </thead>
        <tbody>
          {/* Iron Condors first */}
          {ironCondors.map((ic, i) => (
            <IronCondorRow
              key={`ic-${String(i)}`}
              ic={ic}
              spotPrice={spotPrice}
              index={i}
            />
          ))}
          {/* Vertical spreads */}
          {sorted.map((s, i) => (
            <SpreadRow
              key={`spread-${String(i)}`}
              spread={s}
              spotPrice={spotPrice}
              rowIndex={ironCondors.length + i}
            />
          ))}
          {/* Hedges */}
          {hedges.length > 0 && (
            <HedgeRows
              hedges={hedges}
              startIndex={ironCondors.length + sorted.length}
            />
          )}
          {/* Naked positions */}
          {nakedPositions.length > 0 && (
            <NakedRows
              naked={nakedPositions}
              startIndex={ironCondors.length + sorted.length + hedges.length}
            />
          )}
        </tbody>
      </table>
    </ScrollHint>
  );
}
