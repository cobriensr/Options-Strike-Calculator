/**
 * PositionTable — Table container for open positions.
 *
 * Handles table headers, empty state, sorting, and delegates
 * row rendering to PositionRow sub-components.
 */

import { ScrollHint } from '../ui';
import { useIsMobile } from '../../hooks/useIsMobile';
import type {
  ButterflyPosition,
  HedgePosition,
  IronCondor,
  NakedPosition,
  Spread,
} from './types';
import {
  IronCondorRow,
  SpreadRow,
  ButterflyRow,
  HedgeRows,
  NakedRows,
} from './PositionRow';
import {
  IronCondorCard,
  SpreadCard,
  ButterflyCard,
  HedgeCards,
  NakedCards,
} from './PositionCards';
import { cushionPct } from './position-helpers';

interface PositionTableProps {
  spreads: readonly Spread[];
  ironCondors: readonly IronCondor[];
  butterflies: readonly ButterflyPosition[];
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
  butterflies,
  hedges,
  nakedPositions,
  spotPrice,
}: Readonly<PositionTableProps>) {
  const isMobile = useIsMobile();
  const sorted = sortedSpreads(spreads, spotPrice);
  const hasPositions =
    ironCondors.length > 0 ||
    sorted.length > 0 ||
    butterflies.length > 0 ||
    hedges.length > 0 ||
    nakedPositions.length > 0;

  if (!hasPositions) {
    return (
      <div className="text-muted py-8 text-center font-sans text-sm">
        No open positions found in this statement.
      </div>
    );
  }

  // Render either cards (<md) or table (md+) — exclusively, based on
  // matchMedia. Tailwind's `hidden md:block` would render BOTH branches
  // in JSDOM and break the existing 49 `getByText` assertions. With
  // useIsMobile, JSDOM's default no-match returns false → table always
  // renders in tests, no test updates needed.
  return isMobile ? (
    <div
      className="space-y-2"
      role="list"
      aria-label="Open positions (mobile cards)"
    >
      {ironCondors.map((ic) => (
        <IronCondorCard
          key={`${ic.putSpread.shortLeg.optionCode}/${ic.callSpread.shortLeg.optionCode}`}
          ic={ic}
          spotPrice={spotPrice}
        />
      ))}
      {sorted.map((s) => (
        <SpreadCard
          key={s.shortLeg.optionCode}
          spread={s}
          spotPrice={spotPrice}
        />
      ))}
      {butterflies.map((bfly) => (
        <ButterflyCard key={bfly.middleLeg.optionCode} butterfly={bfly} />
      ))}
      {hedges.length > 0 && <HedgeCards hedges={hedges} />}
      {nakedPositions.length > 0 && <NakedCards naked={nakedPositions} />}
    </div>
  ) : (
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
              key={`${ic.putSpread.shortLeg.optionCode}/${ic.callSpread.shortLeg.optionCode}`}
              ic={ic}
              spotPrice={spotPrice}
              index={i}
            />
          ))}
          {/* Vertical spreads */}
          {sorted.map((s, i) => (
            <SpreadRow
              key={s.shortLeg.optionCode}
              spread={s}
              spotPrice={spotPrice}
              rowIndex={ironCondors.length + i}
            />
          ))}
          {/* Butterflies / BWBs */}
          {butterflies.map((bfly, i) => (
            <ButterflyRow
              key={bfly.middleLeg.optionCode}
              butterfly={bfly}
              rowIndex={ironCondors.length + sorted.length + i}
            />
          ))}
          {/* Hedges */}
          {hedges.length > 0 && (
            <HedgeRows
              hedges={hedges}
              startIndex={
                ironCondors.length + sorted.length + butterflies.length
              }
            />
          )}
          {/* Naked positions */}
          {nakedPositions.length > 0 && (
            <NakedRows
              naked={nakedPositions}
              startIndex={
                ironCondors.length +
                sorted.length +
                butterflies.length +
                hedges.length
              }
            />
          )}
        </tbody>
      </table>
    </ScrollHint>
  );
}
