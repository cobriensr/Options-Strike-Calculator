/**
 * Position sizing panel — shown when the trader has entered entry +
 * adverse (stop) and account settings are valid. Displays the risk
 * budget, per-contract risk, and the max contracts the budget supports.
 */

import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import { ResultRow } from './ui-primitives';
import { fmtDollar } from './formatters';
import type { PositionSize } from './useFuturesCalc';

interface Props {
  positionSize: PositionSize;
  account: number;
  riskPct: number;
}

export function PositionSizingPanel({
  positionSize,
  account,
  riskPct,
}: Readonly<Props>) {
  return (
    <div
      className="rounded-xl border p-4"
      style={{
        backgroundColor: tint(theme.accent, '08'),
        borderColor: tint(theme.accent, '20'),
      }}
    >
      <div
        className="mb-2 font-sans text-[10px] font-bold tracking-[0.10em] uppercase"
        style={{ color: theme.accent }}
      >
        Position Sizing
      </div>
      <div className="divide-edge divide-y">
        <ResultRow
          label={`Budget (${riskPct.toFixed(2)}% of ${fmtDollar(account)})`}
          value={fmtDollar(positionSize.maxRisk)}
          color={theme.textMuted}
        />
        <ResultRow
          label="Risk per contract (stop loss + fees)"
          value={fmtDollar(positionSize.riskPerContract)}
          color={theme.red}
        />
        <ResultRow
          label="Max contracts"
          value={
            positionSize.contracts > 0
              ? `${positionSize.contracts} contract${positionSize.contracts !== 1 ? 's' : ''}`
              : 'budget too small for 1 contract'
          }
          color={positionSize.contracts > 0 ? theme.green : theme.textMuted}
          bold
        />
      </div>
    </div>
  );
}
