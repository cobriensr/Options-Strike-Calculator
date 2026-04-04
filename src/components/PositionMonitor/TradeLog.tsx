import { useCallback, useState } from 'react';
import { ScrollHint } from '../ui';
import type { CashEntry, ClosedSpread, ExecutedTrade } from './types';

interface TradeLogProps {
  trades: readonly ExecutedTrade[];
  cashEntries: readonly CashEntry[];
  closedSpreads: readonly ClosedSpread[];
}

type Filter = 'all' | 'opens' | 'closes';

// ── Formatting helpers ──────────────────────────────────

function fmtCurrency(value: number): string {
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

function fmtTime(execTime: string): string {
  // execTime may be ISO or "HH:MM:SS" — extract HH:MM
  if (execTime.includes('T')) {
    const timePart = execTime.split('T')[1];
    return timePart ? timePart.slice(0, 5) : execTime;
  }
  return execTime.slice(0, 5);
}

function pnlColor(value: number): string {
  if (value > 0) return 'text-success';
  if (value < 0) return 'text-danger';
  return 'text-primary';
}

/** Build strike label from trade legs */
function strikeLabel(trade: ExecutedTrade): string {
  const firstLeg = trade.legs[0];
  if (!firstLeg) return '\u2014';
  const strikes = trade.legs.map((l) => String(l.strike));
  const optType = firstLeg.type === 'CALL' ? 'C' : 'P';
  // Check if mixed types
  const hasMixed = trade.legs.some((l) => l.type !== firstLeg.type);
  if (hasMixed) {
    return trade.legs
      .map((l) => `${String(l.strike)}${l.type === 'CALL' ? 'C' : 'P'}`)
      .join('/');
  }
  return `${strikes.join('/')} ${optType}`;
}

/** Determine posEffect from first leg */
function actionLabel(trade: ExecutedTrade): {
  text: string;
  isOpen: boolean;
} {
  const first = trade.legs[0];
  if (!first) {
    return { text: '\u2014', isOpen: false };
  }
  const direction = first.side === 'SELL' ? 'SOLD' : 'BOT';
  const isOpen = first.posEffect === 'TO OPEN';
  return {
    text: `${direction} ${first.posEffect}`,
    isOpen,
  };
}

/** Total contracts from legs */
function totalQty(trade: ExecutedTrade): number {
  if (trade.legs.length === 0) return 0;
  return Math.max(...trade.legs.map((l) => Math.abs(l.qty)));
}

/** Find matching cash entry for a trade by time proximity */
function matchCashEntry(
  trade: ExecutedTrade,
  cashEntries: readonly CashEntry[],
): CashEntry | null {
  const tradeTime = fmtTime(trade.execTime);
  // TRD entries matching within the same minute
  const trdEntries = cashEntries.filter((e) => e.type === 'TRD');
  const match = trdEntries.find((e) => e.time.slice(0, 5) === tradeTime);
  return match ?? null;
}

/** Find closed spread matching a closing trade */
function matchClosedSpread(
  trade: ExecutedTrade,
  closedSpreads: readonly ClosedSpread[],
): ClosedSpread | null {
  const { isOpen } = actionLabel(trade);
  if (isOpen) return null;

  // Match by close time and strikes
  for (const cs of closedSpreads) {
    const closeTimeMatch = fmtTime(cs.closeTime) === fmtTime(trade.execTime);
    if (!closeTimeMatch) continue;

    const strikes = new Set(trade.legs.map((l) => l.strike));
    if (strikes.has(cs.shortStrike) || strikes.has(cs.longStrike)) {
      return cs;
    }
  }
  return null;
}

// ── Table Style Constants ───────────────────────────────

const TH_CLASS =
  'bg-table-header text-tertiary px-3 py-2 text-left text-xs font-bold uppercase tracking-wider';
const TH_RIGHT =
  'bg-table-header text-tertiary px-3 py-2 text-right text-xs font-bold uppercase tracking-wider';
const TD_CLASS = 'px-3 py-2 text-right font-mono text-sm';
const TD_LEFT = 'px-3 py-2 text-left font-mono text-sm';

// ── Filter Buttons ──────────────────────────────────────

const FILTER_OPTS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'opens', label: 'Opens' },
  { value: 'closes', label: 'Closes' },
];

// ── Main Component ──────────────────────────────────────

export default function TradeLog({
  trades,
  cashEntries,
  closedSpreads,
}: Readonly<TradeLogProps>) {
  const [filter, setFilter] = useState<Filter>('all');
  const [expandedIdx, setExpandedIdx] = useState<Set<number>>(new Set());

  const filtered = trades.filter((t) => {
    if (filter === 'all') return true;
    const { isOpen } = actionLabel(t);
    return filter === 'opens' ? isOpen : !isOpen;
  });

  const toggleExpand = useCallback((idx: number) => {
    setExpandedIdx((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  }, []);

  if (trades.length === 0) {
    return (
      <div
        className="text-muted py-8 text-center font-sans text-sm"
        data-testid="trade-log"
      >
        No trades found in this statement.
      </div>
    );
  }

  return (
    <section
      className="flex flex-col gap-2"
            aria-label="Trade log"
      data-testid="trade-log"
    >
      {/* Filter buttons */}
      <div className="flex gap-1">
        {FILTER_OPTS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setFilter(opt.value)}
            className={`cursor-pointer rounded-md border-[1.5px] px-3 py-1 font-sans text-xs font-semibold transition-colors duration-100 ${
              filter === opt.value
                ? 'border-chip-active-border bg-chip-active-bg text-chip-active-text'
                : 'border-chip-border bg-chip-bg text-chip-text hover:border-edge-heavy hover:bg-surface-alt'
            }`}
          >
            {opt.label}
          </button>
        ))}
        <span className="text-muted ml-2 self-center font-sans text-xs">
          {filtered.length} trade
          {filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Trade table */}
      <ScrollHint>
        <table
          className="w-full font-mono text-sm"
          role="table"
          aria-label="Trade history"
        >
          <thead>
            <tr>
              <th scope="col" className={TH_CLASS}>
                Time
              </th>
              <th scope="col" className={TH_CLASS}>
                Action
              </th>
              <th scope="col" className={TH_CLASS}>
                Spread
              </th>
              <th scope="col" className={TH_CLASS}>
                Strikes
              </th>
              <th scope="col" className={TH_RIGHT}>
                Qty
              </th>
              <th scope="col" className={TH_RIGHT}>
                Net Price
              </th>
              <th scope="col" className={TH_RIGHT}>
                Fees
              </th>
              <th scope="col" className={TH_RIGHT}>
                Balance
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((trade, i) => {
              const action = actionLabel(trade);
              const cash = matchCashEntry(trade, cashEntries);
              const closed = matchClosedSpread(trade, closedSpreads);
              const isExpanded = expandedIdx.has(i);
              const alt = i % 2 === 1;
              const bg = alt ? 'bg-table-alt' : 'bg-surface';

              return (
                <TradeRow
                  key={`trade-${String(i)}`}
                  trade={trade}
                  index={i}
                  action={action}
                  cash={cash}
                  closed={closed}
                  isExpanded={isExpanded}
                  bg={bg}
                  onToggle={toggleExpand}
                />
              );
            })}
          </tbody>
        </table>
      </ScrollHint>
    </section>
  );
}

// ── Trade Row ───────────────────────────────────────────

function TradeRow({
  trade,
  index,
  action,
  cash,
  closed,
  isExpanded,
  bg,
  onToggle,
}: Readonly<{
  trade: ExecutedTrade;
  index: number;
  action: { text: string; isOpen: boolean };
  cash: CashEntry | null;
  closed: ClosedSpread | null;
  isExpanded: boolean;
  bg: string;
  onToggle: (idx: number) => void;
}>) {
  const fees = cash ? Math.abs(cash.commissions) + Math.abs(cash.miscFees) : 0;
  const handleClick = useCallback(() => onToggle(index), [onToggle, index]);

  return (
    <>
      <tr
        className={`${bg} hover:bg-surface-alt/80 cursor-pointer`}
        onClick={handleClick}
      >
        <td className={TD_LEFT}>
          <span className="inline-flex items-center gap-1">
            <span
              className="inline-block text-[10px] transition-transform"
              style={{
                transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
              }}
              aria-hidden="true"
            >
              {'\u25B6'}
            </span>
            {fmtTime(trade.execTime)}
          </span>
        </td>
        <td className={TD_LEFT}>
          <span
            className={`text-xs font-bold ${
              action.isOpen ? 'text-accent' : 'text-tertiary'
            }`}
          >
            {action.text}
          </span>
        </td>
        <td className={TD_LEFT}>{trade.spread}</td>
        <td className={TD_LEFT}>
          <span className="inline-flex items-center gap-1.5">
            {strikeLabel(trade)}
            {closed && (
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                  closed.realizedPnl >= 0
                    ? 'bg-success/15 text-success'
                    : 'bg-danger/15 text-danger'
                }`}
              >
                {fmtCurrency(closed.realizedPnl)}
              </span>
            )}
          </span>
        </td>
        <td className={TD_CLASS}>{totalQty(trade)}</td>
        <td className={`${TD_CLASS} ${pnlColor(trade.netPrice)}`}>
          {fmtCurrency(trade.netPrice)}
        </td>
        <td className={TD_CLASS}>{fees > 0 ? fmtCurrency(fees) : '\u2014'}</td>
        <td className={TD_CLASS}>
          {cash ? fmtCurrency(cash.balance) : '\u2014'}
        </td>
      </tr>

      {/* Expanded leg detail */}
      {isExpanded &&
        trade.legs.map((leg, j) => (
          <tr key={`leg-${String(j)}`} className="bg-surface-alt/50">
            <td className={`${TD_LEFT} pl-8 text-xs`}>
              <span className="text-muted">Leg {j + 1}</span>
            </td>
            <td className={`${TD_LEFT} text-xs`}>
              {leg.side} {leg.posEffect}
            </td>
            <td className={`${TD_LEFT} text-muted text-xs`}>{leg.symbol}</td>
            <td className={`${TD_LEFT} text-xs`}>
              {leg.strike} {leg.type === 'CALL' ? 'C' : 'P'}
            </td>
            <td className="px-3 py-1 text-right font-mono text-xs">
              {Math.abs(leg.qty)}
            </td>
            <td className="px-3 py-1 text-right font-mono text-xs">
              {leg.price.toFixed(2)}
            </td>
            <td className="text-muted px-3 py-1 text-right font-mono text-xs">
              {leg.creditDebit ?? '\u2014'}
            </td>
            <td className="px-3 py-1" />
          </tr>
        ))}
    </>
  );
}
