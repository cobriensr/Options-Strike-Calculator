/**
 * PositionRow — Row renderers for the position table.
 *
 * Exports: IronCondorRow, SpreadRow, HedgeRows, NakedRows
 * Each renders one or more <tr> elements for the parent <tbody>.
 */

import { useState } from 'react';
import type {
  ButterflyPosition,
  HedgePosition,
  IronCondor,
  NakedPosition,
  Spread,
} from './types';
import {
  TD_CLASS,
  TD_LEFT,
  formatCurrency,
  formatPct,
  formatTime,
  pnlColor,
  spreadStrikeLabel,
  spreadTypeLabel,
  cushionPct,
} from './position-helpers';

// ── % Max Progress Bar ───────────────────────────────────────

function PctMaxBar({ pct }: Readonly<{ pct: number | null }>) {
  if (pct === null) return <span className="text-muted">{'\u2014'}</span>;

  const clamped = Math.min(Math.max(pct, 0), 100);
  const barColor =
    pct >= 80 ? 'bg-success' : pct >= 50 ? 'bg-accent' : 'bg-caution';

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

// ── Wing Row (IC sub-row) ────────────────────────────────────

function WingRow({
  label,
  spread,
  spotPrice,
}: Readonly<{
  label: string;
  spread: Spread;
  spotPrice: number;
}>) {
  return (
    <tr className="bg-surface-alt/50">
      <td className={`${TD_LEFT} pl-8 text-xs`}>
        <span className="text-muted">{label}</span>
      </td>
      <td className={`${TD_LEFT} text-xs`}>{spreadStrikeLabel(spread)}</td>
      <td className={`${TD_CLASS} text-xs`}>{spread.contracts}</td>
      <td className={`${TD_CLASS} text-success text-xs`}>
        {formatCurrency(spread.creditReceived)}
      </td>
      <td className={`${TD_CLASS} text-xs ${pnlColor(spread.openPnl)}`}>
        {spread.openPnl !== null ? formatCurrency(spread.openPnl) : '\u2014'}
      </td>
      <td className={`${TD_CLASS} text-xs`}>
        <PctMaxBar pct={spread.pctOfMaxProfit} />
      </td>
      <td className={`${TD_CLASS} text-danger text-xs`}>
        {formatCurrency(spread.maxLoss)}
      </td>
      <td className={`${TD_CLASS} text-xs`}>
        {spread.riskRewardRatio.toFixed(1)}:1
      </td>
      <td className={`${TD_CLASS} text-xs`}>{spread.breakeven.toFixed(2)}</td>
      <td className={`${TD_CLASS} text-xs`}>
        {formatPct(cushionPct(spread, spotPrice))}
      </td>
      <td className={`${TD_CLASS} text-xs`}>{formatTime(spread.entryTime)}</td>
    </tr>
  );
}

// ── Iron Condor Row (expandable) ─────────────────────────────

export function IronCondorRow({
  ic,
  spotPrice,
  index,
}: Readonly<{
  ic: IronCondor;
  spotPrice: number;
  index: number;
}>) {
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

  const putCushion = cushionPct(ic.putSpread, spotPrice);
  const callCushion = cushionPct(ic.callSpread, spotPrice);
  const minCushion =
    putCushion !== null && callCushion !== null
      ? Math.min(Math.abs(putCushion), Math.abs(callCushion))
      : (putCushion ?? callCushion);

  return (
    <>
      <tr
        className={`${bg} cursor-pointer`}
        onClick={() => setExpanded(!expanded)}
      >
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
            </span>{' '}
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
        <td className={TD_CLASS}>{ic.riskRewardRatio.toFixed(1)}:1</td>
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

// ── Spread Row ───────────────────────────────────────────────

export function SpreadRow({
  spread,
  spotPrice,
  rowIndex,
}: Readonly<{
  spread: Spread;
  spotPrice: number;
  rowIndex: number;
}>) {
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
        {spread.openPnl !== null ? formatCurrency(spread.openPnl) : '\u2014'}
      </td>
      <td className={TD_CLASS}>
        <PctMaxBar pct={spread.pctOfMaxProfit} />
      </td>
      <td className={`${TD_CLASS} text-danger`}>
        {formatCurrency(spread.maxLoss)}
      </td>
      <td className={TD_CLASS}>{spread.riskRewardRatio.toFixed(1)}:1</td>
      <td className={TD_CLASS}>{spread.breakeven.toFixed(2)}</td>
      <td className={TD_CLASS}>{formatPct(cushionPct(spread, spotPrice))}</td>
      <td className={TD_CLASS}>{formatTime(spread.entryTime)}</td>
    </tr>
  );
}

// ── Hedge Rows ───────────────────────────────────────────────

export function HedgeRows({
  hedges,
  startIndex,
}: Readonly<{
  hedges: readonly HedgePosition[];
  startIndex: number;
}>) {
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
              {h.direction === 'LONG' ? '+' : '-'}
              {h.contracts}
            </td>
            <td className={TD_CLASS}>{formatCurrency(h.entryCost)}</td>
            <td className={`${TD_CLASS} ${pnlColor(h.openPnl)}`}>
              {h.openPnl !== null ? formatCurrency(h.openPnl) : '\u2014'}
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

// ── Butterfly / BWB Row ─────────────────────────────────────────

export function ButterflyRow({
  butterfly: bfly,
  rowIndex,
}: Readonly<{
  butterfly: ButterflyPosition;
  rowIndex: number;
}>) {
  const alt = rowIndex % 2 === 1;
  const bg = alt ? 'bg-table-alt' : 'bg-surface';
  const label = bfly.isBrokenWing ? 'BWB' : 'BFLY';
  const strikes = `${bfly.lowerLeg.strike}/${bfly.middleLeg.strike}/${bfly.upperLeg.strike}`;
  const typeChar = bfly.optionType === 'CALL' ? 'C' : 'P';

  return (
    <tr className={`${bg} border-accent/40 border-l-4`}>
      <td className={TD_LEFT}>
        <span className="text-accent font-bold">{label}</span>
      </td>
      <td className={TD_LEFT}>
        {strikes} {typeChar}
      </td>
      <td className={TD_CLASS}>{bfly.contracts}</td>
      <td className={`${TD_CLASS} text-danger`}>
        ({formatCurrency(bfly.debitPaid)})
      </td>
      <td className={TD_CLASS}>{'\u2014'}</td>
      <td className={TD_CLASS}>{'\u2014'}</td>
      <td className={`${TD_CLASS} text-danger`}>
        {formatCurrency(bfly.maxLoss)}
      </td>
      <td className={TD_CLASS}>
        {bfly.maxProfit > 0
          ? `${(bfly.maxLoss / bfly.maxProfit).toFixed(1)}:1`
          : '\u2014'}
      </td>
      <td className={TD_CLASS}>{bfly.maxProfitStrike}</td>
      <td className={TD_CLASS}>
        {bfly.distanceToPin != null
          ? `${bfly.distanceToPin > 0 ? '+' : ''}${bfly.distanceToPin.toFixed(0)} pts`
          : '\u2014'}
      </td>
      <td className={TD_CLASS}>{formatTime(bfly.entryTime)}</td>
    </tr>
  );
}

// ── Naked Position Rows ──────────────────────────────────────

export function NakedRows({
  naked,
  startIndex,
}: Readonly<{
  naked: readonly NakedPosition[];
  startIndex: number;
}>) {
  return (
    <>
      {naked.map((n, i) => {
        const idx = startIndex + i;
        const alt = idx % 2 === 1;
        const bg = alt ? 'bg-table-alt' : 'bg-surface';
        return (
          <tr
            key={`naked-${String(i)}`}
            className={`${bg} border-danger bg-danger/10 border-l-4`}
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
