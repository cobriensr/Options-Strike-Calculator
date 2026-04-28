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

// ─────────────────────────────────────────────────────────────
// MOBILE CARD VARIANTS (rendered at <md, in place of the table)
// ─────────────────────────────────────────────────────────────
//
// Each card mirrors the same data as its <tr> sibling but arranged
// for finger-friendly readability at 412px. Same fields appear; the
// difference is layout density and visual hierarchy:
//   - Header: type label + strikes + entry time
//   - Primary: P&L + %Max bar
//   - Stats grid: credit, max loss, R:R, breakeven (or variant-specific)
//   - Footer: cushion + contract count
//
// Naked is danger-bordered with UNDEFINED max loss. Hedge has a simpler
// card (no max loss / R:R / cushion). BWB shows pin strike + distance.
// IC is tappable to reveal the wing breakdown.

function CardShell({
  borderTone,
  children,
}: Readonly<{
  borderTone?: 'accent' | 'danger' | 'edge';
  children: React.ReactNode;
}>) {
  const borderClass =
    borderTone === 'danger'
      ? 'border-danger bg-danger/10'
      : borderTone === 'accent'
        ? 'border-accent/40'
        : 'border-edge';
  return (
    <div
      className={`rounded-lg border-[1.5px] ${borderClass} bg-surface p-3 font-mono`}
      role="listitem"
    >
      {children}
    </div>
  );
}

function CardStatsGrid({
  rows,
}: Readonly<{
  rows: ReadonlyArray<{ label: string; value: React.ReactNode }>;
}>) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
      {rows.map((r) => (
        <div key={r.label} className="flex items-baseline justify-between">
          <span className="text-muted text-[10px] tracking-wider uppercase">
            {r.label}
          </span>
          <span>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

function CardPrimaryRow({
  pnl,
  pctMax,
}: Readonly<{
  pnl: number | null;
  pctMax: number | null;
}>) {
  return (
    <div className="border-edge/40 my-2 flex items-center justify-between border-y py-2">
      <div>
        <div className="text-muted text-[10px] tracking-wider uppercase">
          Open P&amp;L
        </div>
        <div className={`font-mono text-base font-semibold ${pnlColor(pnl)}`}>
          {pnl !== null ? formatCurrency(pnl) : '—'}
        </div>
      </div>
      <div className="text-right">
        <div className="text-muted text-[10px] tracking-wider uppercase">
          % of Max
        </div>
        <div className="mt-0.5">
          <PctMaxBar pct={pctMax} />
        </div>
      </div>
    </div>
  );
}

// ── Iron Condor Card ─────────────────────────────────────────

export function IronCondorCard({
  ic,
  spotPrice,
}: Readonly<{
  ic: IronCondor;
  spotPrice: number;
}>) {
  const [expanded, setExpanded] = useState(false);
  const putStrike = spreadStrikeLabel(ic.putSpread);
  const callStrike = spreadStrikeLabel(ic.callSpread);
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
    <CardShell borderTone="accent">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between text-left"
        aria-expanded={expanded}
        aria-label={`Iron Condor ${putStrike}p / ${callStrike}c`}
      >
        <div>
          <span className="text-accent font-bold">IC</span>{' '}
          <span className="text-secondary text-xs">
            {putStrike}p – {callStrike}c
          </span>
        </div>
        <div className="text-muted text-[10px]">
          {formatTime(ic.entryTime)}{' '}
          <span
            className="ml-1 inline-block text-[10px] transition-transform"
            style={{
              transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            }}
            aria-hidden="true"
          >
            ▶
          </span>
        </div>
      </button>
      <CardPrimaryRow pnl={openPnl} pctMax={pctMax} />
      <CardStatsGrid
        rows={[
          {
            label: 'Credit',
            value: (
              <span className="text-success">
                {formatCurrency(ic.totalCredit)}
              </span>
            ),
          },
          {
            label: 'Max Loss',
            value: (
              <span className="text-danger">{formatCurrency(ic.maxLoss)}</span>
            ),
          },
          { label: 'R:R', value: `${ic.riskRewardRatio.toFixed(1)}:1` },
          {
            label: 'Breakevens',
            value: `${ic.breakevenLow.toFixed(0)} / ${ic.breakevenHigh.toFixed(0)}`,
          },
        ]}
      />
      <div className="text-muted mt-2 flex items-center justify-between text-[10px]">
        <span>Cushion {formatPct(minCushion)}</span>
        <span>{ic.contracts} contracts</span>
      </div>
      {expanded && (
        <div className="border-edge/60 mt-2 space-y-2 border-t pt-2">
          <WingCardSection
            label="PUT wing"
            spread={ic.putSpread}
            spotPrice={spotPrice}
          />
          <WingCardSection
            label="CALL wing"
            spread={ic.callSpread}
            spotPrice={spotPrice}
          />
        </div>
      )}
    </CardShell>
  );
}

function WingCardSection({
  label,
  spread,
  spotPrice,
}: Readonly<{
  label: string;
  spread: Spread;
  spotPrice: number;
}>) {
  return (
    <div className="bg-surface-alt/50 rounded p-2 text-xs">
      <div className="text-muted mb-1 text-[10px] tracking-wider uppercase">
        {label} • {spreadStrikeLabel(spread)}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        <div className="flex justify-between">
          <span className="text-muted">P&amp;L</span>
          <span className={pnlColor(spread.openPnl)}>
            {spread.openPnl !== null ? formatCurrency(spread.openPnl) : '—'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">% Max</span>
          <PctMaxBar pct={spread.pctOfMaxProfit} />
        </div>
        <div className="flex justify-between">
          <span className="text-muted">Cushion</span>
          <span>{formatPct(cushionPct(spread, spotPrice))}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">Breakeven</span>
          <span>{spread.breakeven.toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}

// ── Spread Card ──────────────────────────────────────────────

export function SpreadCard({
  spread,
  spotPrice,
}: Readonly<{
  spread: Spread;
  spotPrice: number;
}>) {
  const isPut = spread.spreadType === 'PUT_CREDIT_SPREAD';
  return (
    <CardShell>
      <div className="flex items-center justify-between">
        <div>
          <span
            className={`font-bold ${isPut ? 'text-red-400' : 'text-green-400'}`}
          >
            {spreadTypeLabel(spread)}
          </span>{' '}
          <span className="text-secondary text-xs">
            {spreadStrikeLabel(spread)}
          </span>
        </div>
        <span className="text-muted text-[10px]">
          {formatTime(spread.entryTime)}
        </span>
      </div>
      <CardPrimaryRow pnl={spread.openPnl} pctMax={spread.pctOfMaxProfit} />
      <CardStatsGrid
        rows={[
          {
            label: 'Credit',
            value: (
              <span className="text-success">
                {formatCurrency(spread.creditReceived)}
              </span>
            ),
          },
          {
            label: 'Max Loss',
            value: (
              <span className="text-danger">
                {formatCurrency(spread.maxLoss)}
              </span>
            ),
          },
          { label: 'R:R', value: `${spread.riskRewardRatio.toFixed(1)}:1` },
          { label: 'Breakeven', value: spread.breakeven.toFixed(2) },
        ]}
      />
      <div className="text-muted mt-2 flex items-center justify-between text-[10px]">
        <span>Cushion {formatPct(cushionPct(spread, spotPrice))}</span>
        <span>{spread.contracts} contracts</span>
      </div>
    </CardShell>
  );
}

// ── Butterfly / BWB Card ─────────────────────────────────────

export function ButterflyCard({
  butterfly: bfly,
}: Readonly<{
  butterfly: ButterflyPosition;
}>) {
  const label = bfly.isBrokenWing ? 'BWB' : 'BFLY';
  const strikes = `${bfly.lowerLeg.strike}/${bfly.middleLeg.strike}/${bfly.upperLeg.strike}`;
  const typeChar = bfly.optionType === 'CALL' ? 'C' : 'P';
  const rr =
    bfly.maxProfit > 0
      ? `${(bfly.maxLoss / bfly.maxProfit).toFixed(1)}:1`
      : '—';

  return (
    <CardShell borderTone="accent">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-accent font-bold">{label}</span>{' '}
          <span className="text-secondary text-xs">
            {strikes} {typeChar}
          </span>
        </div>
        <span className="text-muted text-[10px]">
          {formatTime(bfly.entryTime)}
        </span>
      </div>
      <div className="border-edge/40 my-2 flex items-center justify-between border-y py-2">
        <div>
          <div className="text-muted text-[10px] tracking-wider uppercase">
            Debit Paid
          </div>
          <div className="text-danger font-mono text-base font-semibold">
            ({formatCurrency(bfly.debitPaid)})
          </div>
        </div>
        <div className="text-right">
          <div className="text-muted text-[10px] tracking-wider uppercase">
            Pin Strike
          </div>
          <div className="font-mono text-base font-semibold">
            {bfly.maxProfitStrike}
          </div>
        </div>
      </div>
      <CardStatsGrid
        rows={[
          {
            label: 'Max Loss',
            value: (
              <span className="text-danger">
                {formatCurrency(bfly.maxLoss)}
              </span>
            ),
          },
          { label: 'R:R', value: rr },
          {
            label: 'Distance',
            value:
              bfly.distanceToPin != null
                ? `${bfly.distanceToPin > 0 ? '+' : ''}${bfly.distanceToPin.toFixed(0)} pts`
                : '—',
          },
          { label: 'Contracts', value: bfly.contracts },
        ]}
      />
    </CardShell>
  );
}

// ── Hedge Cards ──────────────────────────────────────────────

export function HedgeCards({
  hedges,
}: Readonly<{
  hedges: readonly HedgePosition[];
}>) {
  return (
    <>
      {hedges.map((h, i) => (
        <CardShell key={`hedge-card-${String(i)}`} borderTone="accent">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-accent font-bold">HEDGE</span>{' '}
              <span className="text-secondary text-xs">
                {h.leg.strike} {h.protectionSide}
              </span>
            </div>
            <span className="text-muted text-[10px]">
              {h.direction === 'LONG' ? '+' : '-'}
              {h.contracts}
            </span>
          </div>
          <div className="border-edge/40 my-2 flex items-center justify-between border-y py-2">
            <div>
              <div className="text-muted text-[10px] tracking-wider uppercase">
                Open P&amp;L
              </div>
              <div
                className={`font-mono text-base font-semibold ${pnlColor(h.openPnl)}`}
              >
                {h.openPnl !== null ? formatCurrency(h.openPnl) : '—'}
              </div>
            </div>
            <div className="text-right">
              <div className="text-muted text-[10px] tracking-wider uppercase">
                Entry Cost
              </div>
              <div className="font-mono text-sm">
                {formatCurrency(h.entryCost)}
              </div>
            </div>
          </div>
          <div className="text-muted text-[10px]">
            {h.protectionSide} side protection
          </div>
        </CardShell>
      ))}
    </>
  );
}

// ── Naked Position Cards ─────────────────────────────────────

export function NakedCards({
  naked,
}: Readonly<{
  naked: readonly NakedPosition[];
}>) {
  return (
    <>
      {naked.map((n, i) => (
        <CardShell key={`naked-card-${String(i)}`} borderTone="danger">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-danger font-bold">NAKED</span>{' '}
              <span className="text-secondary text-xs">
                {n.leg.strike} {n.type}
              </span>
            </div>
            <span className="text-muted text-[10px]">-{n.contracts}</span>
          </div>
          <div className="border-edge/40 my-2 border-y py-2 text-center">
            <div className="text-muted text-[10px] tracking-wider uppercase">
              Max Loss
            </div>
            <div className="text-danger font-mono text-base font-bold">
              UNDEFINED
            </div>
          </div>
          <div className="text-muted text-[10px]">
            Naked short {n.type.toLowerCase()} — unlimited risk
          </div>
        </CardShell>
      ))}
    </>
  );
}
