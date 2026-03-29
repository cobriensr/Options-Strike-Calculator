import { useState } from 'react';
import { ScrollHint } from '../ui';
import type {
  HedgePosition,
  IronCondor,
  NakedPosition,
  Spread,
} from './types';

interface PositionTableProps {
  spreads: readonly Spread[];
  ironCondors: readonly IronCondor[];
  hedges: readonly HedgePosition[];
  nakedPositions: readonly NakedPosition[];
  spotPrice: number;
}

// ── Formatting helpers ────────────────────────────────────

function formatCurrency(value: number): string {
  if (value < 0) {
    return `($${Math.abs(value).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })})`;
  }
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPct(value: number | null): string {
  if (value === null) return '\u2014';
  return `${value.toFixed(1)}%`;
}

function formatTime(time: string | null): string {
  if (!time) return '\u2014';
  // Already "HH:MM" or similar from parser
  return time;
}

function pnlColor(value: number | null): string {
  if (value === null) return 'text-muted';
  if (value > 0) return 'text-success';
  if (value < 0) return 'text-danger';
  return 'text-primary';
}

function spreadStrikeLabel(s: Spread): string {
  const short = s.shortLeg.strike;
  const long = s.longLeg.strike;
  return `${short}/${long}`;
}

function spreadTypeLabel(s: Spread): string {
  return s.spreadType === 'PUT_CREDIT_SPREAD' ? 'PCS' : 'CCS';
}

/** Cushion: distance from spot to short strike as % of spot */
function cushionPct(s: Spread, spot: number): number | null {
  if (spot <= 0) return null;
  return s.distanceToShortStrikePct ?? null;
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
const TD_CLASS = 'px-3 py-2 text-right font-mono text-sm';
const TD_LEFT = 'px-3 py-2 text-left font-mono text-sm';

// ── Main Component ────────────────────────────────────────

export default function PositionTable({
  spreads,
  ironCondors,
  hedges,
  nakedPositions,
  spotPrice,
}: PositionTableProps) {
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
        className="w-full text-sm font-mono"
        role="table"
        aria-label="Open positions"
      >
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>Type</th>
            <th scope="col" className={TH_CLASS}>Strikes</th>
            <th scope="col" className={TH_RIGHT}>Qty</th>
            <th scope="col" className={TH_RIGHT}>Credit</th>
            <th scope="col" className={TH_RIGHT}>Open P&L</th>
            <th scope="col" className={TH_RIGHT}>% Max</th>
            <th scope="col" className={TH_RIGHT}>Max Loss</th>
            <th scope="col" className={TH_RIGHT}>Risk:Reward</th>
            <th scope="col" className={TH_RIGHT}>Breakeven</th>
            <th scope="col" className={TH_RIGHT}>Cushion</th>
            <th scope="col" className={TH_RIGHT}>Entry</th>
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
            <HedgeRows hedges={hedges} startIndex={
              ironCondors.length + sorted.length
            } />
          )}
          {/* Naked positions */}
          {nakedPositions.length > 0 && (
            <NakedRows naked={nakedPositions} startIndex={
              ironCondors.length + sorted.length + hedges.length
            } />
          )}
        </tbody>
      </table>
    </ScrollHint>
  );
}

// ── Iron Condor Row (expandable) ──────────────────────────

function IronCondorRow({
  ic,
  spotPrice,
  index,
}: {
  ic: IronCondor;
  spotPrice: number;
  index: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const alt = index % 2 === 1;
  const bg = alt ? 'bg-table-alt' : 'bg-surface';

  const putStrike = spreadStrikeLabel(ic.putSpread);
  const callStrike = spreadStrikeLabel(ic.callSpread);
  const strikes = `${putStrike}p \u2013 ${callStrike}c`;

  const openPnl =
    ic.putSpread.openPnl !== null && ic.callSpread.openPnl !== null
      ? ic.putSpread.openPnl + ic.callSpread.openPnl
      : null;

  const pctMax =
    ic.maxProfit > 0 && openPnl !== null
      ? (openPnl / ic.maxProfit) * 100
      : null;

  // Cushion = min distance to either short strike
  const putCushion = cushionPct(ic.putSpread, spotPrice);
  const callCushion = cushionPct(ic.callSpread, spotPrice);
  const minCushion =
    putCushion !== null && callCushion !== null
      ? Math.min(Math.abs(putCushion), Math.abs(callCushion))
      : putCushion ?? callCushion;

  return (
    <>
      <tr className={`${bg} cursor-pointer`} onClick={() => setExpanded(!expanded)}>
        <td className={TD_LEFT}>
          <span className="text-accent inline-flex items-center gap-1 font-bold">
            <span
              className="inline-block text-[10px] transition-transform"
              style={{
                transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
              }}
              aria-hidden="true"
            >
              {'\u25B6'}
            </span>
            IC
          </span>
        </td>
        <td className={TD_LEFT}>{strikes}</td>
        <td className={TD_CLASS}>{ic.contracts}</td>
        <td className={`${TD_CLASS} text-success`}>
          {formatCurrency(ic.totalCredit)}
        </td>
        <td className={`${TD_CLASS} ${pnlColor(openPnl)}`}>
          {openPnl !== null ? formatCurrency(openPnl) : '\u2014'}
        </td>
        <td className={TD_CLASS}>
          <PctMaxBar pct={pctMax} />
        </td>
        <td className={`${TD_CLASS} text-danger`}>
          {formatCurrency(ic.maxLoss)}
        </td>
        <td className={TD_CLASS}>
          {ic.riskRewardRatio.toFixed(1)}:1
        </td>
        <td className={TD_CLASS}>
          <span className="text-[11px]">
            {ic.breakevenLow.toFixed(2)} / {ic.breakevenHigh.toFixed(2)}
          </span>
        </td>
        <td className={TD_CLASS}>{formatPct(minCushion)}</td>
        <td className={TD_CLASS}>{formatTime(ic.entryTime)}</td>
      </tr>
      {expanded && (
        <>
          <WingRow
            label="PUT wing"
            spread={ic.putSpread}
            spotPrice={spotPrice}
          />
          <WingRow
            label="CALL wing"
            spread={ic.callSpread}
            spotPrice={spotPrice}
          />
        </>
      )}
    </>
  );
}

/** Sub-row for an expanded IC wing */
function WingRow({
  label,
  spread,
  spotPrice,
}: {
  label: string;
  spread: Spread;
  spotPrice: number;
}) {
  return (
    <tr className="bg-surface-alt/50">
      <td className={`${TD_LEFT} pl-8 text-xs`}>
        <span className="text-muted">{label}</span>
      </td>
      <td className={`${TD_LEFT} text-xs`}>
        {spreadStrikeLabel(spread)}
      </td>
      <td className={`${TD_CLASS} text-xs`}>{spread.contracts}</td>
      <td className={`${TD_CLASS} text-xs text-success`}>
        {formatCurrency(spread.creditReceived)}
      </td>
      <td
        className={`${TD_CLASS} text-xs ${pnlColor(spread.openPnl)}`}
      >
        {spread.openPnl !== null
          ? formatCurrency(spread.openPnl)
          : '\u2014'}
      </td>
      <td className={`${TD_CLASS} text-xs`}>
        <PctMaxBar pct={spread.pctOfMaxProfit} />
      </td>
      <td className={`${TD_CLASS} text-xs text-danger`}>
        {formatCurrency(spread.maxLoss)}
      </td>
      <td className={`${TD_CLASS} text-xs`}>
        {spread.riskRewardRatio.toFixed(1)}:1
      </td>
      <td className={`${TD_CLASS} text-xs`}>
        {spread.breakeven.toFixed(2)}
      </td>
      <td className={`${TD_CLASS} text-xs`}>
        {formatPct(cushionPct(spread, spotPrice))}
      </td>
      <td className={`${TD_CLASS} text-xs`}>
        {formatTime(spread.entryTime)}
      </td>
    </tr>
  );
}

// ── Spread Row ────────────────────────────────────────────

function SpreadRow({
  spread,
  spotPrice,
  rowIndex,
}: {
  spread: Spread;
  spotPrice: number;
  rowIndex: number;
}) {
  const alt = rowIndex % 2 === 1;
  const bg = alt ? 'bg-table-alt' : 'bg-surface';

  return (
    <tr className={bg}>
      <td className={TD_LEFT}>
        <span
          className={`font-bold ${
            spread.spreadType === 'PUT_CREDIT_SPREAD'
              ? 'text-red-400'
              : 'text-green-400'
          }`}
        >
          {spreadTypeLabel(spread)}
        </span>
      </td>
      <td className={TD_LEFT}>{spreadStrikeLabel(spread)}</td>
      <td className={TD_CLASS}>{spread.contracts}</td>
      <td className={`${TD_CLASS} text-success`}>
        {formatCurrency(spread.creditReceived)}
      </td>
      <td className={`${TD_CLASS} ${pnlColor(spread.openPnl)}`}>
        {spread.openPnl !== null
          ? formatCurrency(spread.openPnl)
          : '\u2014'}
      </td>
      <td className={TD_CLASS}>
        <PctMaxBar pct={spread.pctOfMaxProfit} />
      </td>
      <td className={`${TD_CLASS} text-danger`}>
        {formatCurrency(spread.maxLoss)}
      </td>
      <td className={TD_CLASS}>
        {spread.riskRewardRatio.toFixed(1)}:1
      </td>
      <td className={TD_CLASS}>{spread.breakeven.toFixed(2)}</td>
      <td className={TD_CLASS}>
        {formatPct(cushionPct(spread, spotPrice))}
      </td>
      <td className={TD_CLASS}>{formatTime(spread.entryTime)}</td>
    </tr>
  );
}

// ── Hedge Rows ────────────────────────────────────────────

function HedgeRows({
  hedges,
  startIndex,
}: {
  hedges: readonly HedgePosition[];
  startIndex: number;
}) {
  return (
    <>
      {hedges.map((h, i) => {
        const idx = startIndex + i;
        const alt = idx % 2 === 1;
        const bg = alt ? 'bg-table-alt' : 'bg-surface';
        return (
          <tr
            key={`hedge-${String(i)}`}
            className={`${bg} border-accent/40 border-l-4`}
          >
            <td className={TD_LEFT}>
              <span className="text-accent font-bold">HEDGE</span>
            </td>
            <td className={TD_LEFT}>
              {h.leg.strike} {h.protectionSide}
            </td>
            <td className={TD_CLASS}>
              {h.direction === 'LONG' ? '+' : '-'}{h.contracts}
            </td>
            <td className={TD_CLASS}>
              {formatCurrency(h.entryCost)}
            </td>
            <td
              className={`${TD_CLASS} ${pnlColor(h.openPnl)}`}
            >
              {h.openPnl !== null
                ? formatCurrency(h.openPnl)
                : '\u2014'}
            </td>
            <td className={TD_CLASS}>{'\u2014'}</td>
            <td className={TD_CLASS}>{'\u2014'}</td>
            <td className={TD_CLASS}>{'\u2014'}</td>
            <td className={TD_CLASS}>{'\u2014'}</td>
            <td className={TD_CLASS}>
              <span className="text-muted text-xs">
                {h.protectionSide} side
              </span>
            </td>
            <td className={TD_CLASS}>{'\u2014'}</td>
          </tr>
        );
      })}
    </>
  );
}

// ── Naked Position Rows ───────────────────────────────────

function NakedRows({
  naked,
  startIndex,
}: {
  naked: readonly NakedPosition[];
  startIndex: number;
}) {
  return (
    <>
      {naked.map((n, i) => {
        const idx = startIndex + i;
        const alt = idx % 2 === 1;
        const bg = alt ? 'bg-table-alt' : 'bg-surface';
        return (
          <tr
            key={`naked-${String(i)}`}
            className={`${bg} border-danger border-l-4 bg-danger/10`}
          >
            <td className={TD_LEFT}>
              <span className="text-danger font-bold">NAKED</span>
            </td>
            <td className={TD_LEFT}>
              {n.leg.strike} {n.type}
            </td>
            <td className={TD_CLASS}>-{n.contracts}</td>
            <td className={TD_CLASS}>{'\u2014'}</td>
            <td className={TD_CLASS}>{'\u2014'}</td>
            <td className={TD_CLASS}>{'\u2014'}</td>
            <td className={TD_CLASS}>
              <span className="text-danger font-bold">UNDEFINED</span>
            </td>
            <td className={TD_CLASS}>{'\u2014'}</td>
            <td className={TD_CLASS}>{'\u2014'}</td>
            <td className={TD_CLASS}>{'\u2014'}</td>
            <td className={TD_CLASS}>{'\u2014'}</td>
          </tr>
        );
      })}
    </>
  );
}

// ── % Max Progress Bar ────────────────────────────────────

function PctMaxBar({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-muted">{'\u2014'}</span>;

  const clamped = Math.min(Math.max(pct, 0), 100);
  const barColor =
    pct >= 80
      ? 'bg-success'
      : pct >= 50
        ? 'bg-accent'
        : 'bg-caution';

  return (
    <div className="flex items-center gap-1.5">
      <div className="bg-edge h-2 w-12 overflow-hidden rounded-full">
        <div
          className={`h-full rounded-full ${barColor}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="text-xs">{pct.toFixed(0)}%</span>
    </div>
  );
}
