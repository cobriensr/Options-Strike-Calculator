/**
 * Header row for FuturesCalculator — collapse/expand caret, title,
 * Clear button, and symbol chips (ES/MES/NQ/MNQ).
 */

import type { FuturesSymbol } from './futures-calc';

interface Props {
  symbol: FuturesSymbol;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSymbolChange: (sym: FuturesSymbol) => void;
  onClear: () => void;
}

function chipClass(active: boolean): string {
  return (
    'cursor-pointer rounded-md border-[1.5px] px-2.5 py-1 font-sans text-[10px] font-bold tracking-[0.08em] uppercase transition-colors duration-100 ' +
    (active
      ? 'border-chip-active-border bg-chip-active-bg text-chip-active-text'
      : 'border-chip-border bg-chip-bg text-chip-text hover:border-edge-heavy hover:bg-surface-alt')
  );
}

export function CalcHeader({
  symbol,
  collapsed,
  onToggleCollapse,
  onSymbolChange,
  onClear,
}: Readonly<Props>) {
  return (
    <div
      className={
        (collapsed ? '' : 'mb-3.5 ') +
        'flex cursor-pointer flex-col gap-2 select-none'
      }
      onClick={onToggleCollapse}
      role="button"
      tabIndex={0}
      aria-label="Toggle Futures P&L Calculator"
      aria-expanded={!collapsed}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggleCollapse();
        }
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span
            className="text-muted text-[12px] transition-transform duration-200"
            style={{
              transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
            }}
            aria-hidden="true"
          >
            &#x25BE;
          </span>
          <h2 className="text-tertiary font-sans text-[13px] font-bold tracking-[0.12em] uppercase">
            Futures P&amp;L Calculator
          </h2>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
          className="border-edge-strong bg-chip-bg text-secondary cursor-pointer rounded-md border-[1.5px] px-3 py-1.5 font-sans text-xs font-semibold hover:border-red-400 hover:text-red-400"
        >
          Clear
        </button>
      </div>

      <div className="flex gap-1">
        {(['ES', 'MES', 'NQ', 'MNQ'] as const).map((sym) => (
          <button
            key={sym}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSymbolChange(sym);
            }}
            className={chipClass(symbol === sym)}
          >
            {sym}
          </button>
        ))}
      </div>
    </div>
  );
}
