/**
 * Tick ladder — shown when only entry is provided (no exit).
 *
 * Lists the preset TICK_STEPS (1,2,4,6,8,10,12,16,20) with exit price,
 * gross, and net columns. Highlights the break-even price in the header
 * and footnotes the round-trip fees below.
 */

import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import { fmtPrice, fmtDollar, pnlColor } from './formatters';
import { roundTripFees, type ContractSpec } from './futures-calc';
import type { TickRow } from './useFuturesCalc';

interface Props {
  tickLadder: TickRow[];
  bePrice: number;
  spec: ContractSpec;
  contracts: number;
  feePerSide: number;
}

export function TickLadderTable({
  tickLadder,
  bePrice,
  spec,
  contracts,
  feePerSide,
}: Readonly<Props>) {
  return (
    <div
      className="border-edge rounded-xl border p-4"
      style={{ backgroundColor: tint(theme.surfaceAlt, '80') }}
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.10em] uppercase">
          Tick ladder · {contracts} contract{contracts !== 1 ? 's' : ''}
        </div>
        <div
          className="font-sans text-[10px]"
          style={{ color: theme.textMuted }}
        >
          Break-even:{' '}
          <span
            className="font-mono font-semibold"
            style={{ color: theme.caution }}
          >
            {fmtPrice(bePrice)}
          </span>
        </div>
      </div>

      <div
        className="mb-1 grid grid-cols-4 gap-2 pb-1 font-sans text-[9px] font-bold tracking-[0.08em] uppercase"
        style={{
          color: theme.textMuted,
          borderBottom: `1px solid ${tint(theme.border, '80')}`,
        }}
      >
        <span>Ticks</span>
        <span>Exit</span>
        <span>Gross</span>
        <span>Net (after fees)</span>
      </div>

      <div className="space-y-0.5">
        {tickLadder.map((row) => (
          <div key={row.ticks} className="grid grid-cols-4 gap-2 py-0.5">
            <span
              className="font-mono text-[11px]"
              style={{ color: theme.textMuted }}
            >
              +{row.ticks}
            </span>
            <span
              className="font-mono text-[11px]"
              style={{ color: theme.text }}
            >
              {fmtPrice(row.exitPx)}
            </span>
            <span
              className="font-mono text-[11px]"
              style={{ color: pnlColor(row.gross) }}
            >
              {fmtDollar(row.gross, true)}
            </span>
            <span
              className="font-mono text-[11px] font-semibold"
              style={{ color: pnlColor(row.net) }}
            >
              {fmtDollar(row.net, true)}
            </span>
          </div>
        ))}
      </div>

      <div
        className="mt-3 rounded px-2 py-1.5 font-sans text-[9px]"
        style={{
          backgroundColor: tint(theme.surfaceAlt, '60'),
          color: theme.textMuted,
        }}
      >
        Round-trip fees deducted:{' '}
        <span className="font-mono font-semibold" style={{ color: theme.red }}>
          {fmtDollar(-roundTripFees(spec, contracts))}
        </span>{' '}
        ({contracts}× ${feePerSide.toFixed(2)} buy + {contracts}× $
        {feePerSide.toFixed(2)} sell)
      </div>
    </div>
  );
}
