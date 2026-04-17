/**
 * Full P&L results block — shown when entry + exit are both valid.
 * Contains points/ticks/gross, fee breakdown, highlighted Net P&L,
 * and the margin/ROM/R:R footer.
 */

import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import { ResultRow } from './ui-primitives';
import { fmtPrice, fmtDollar, pnlColor } from './formatters';
import { feesPerSide, type ContractSpec } from './futures-calc';
import type { TradeCalc } from './useFuturesCalc';

interface Props {
  calc: TradeCalc;
  spec: ContractSpec;
  contracts: number;
  feePerSide: number;
  rrRatio: number | null;
  pctOfAccount: (dollars: number) => string | null;
}

export function TradeResults({
  calc,
  spec,
  contracts,
  feePerSide,
  rrRatio,
  pctOfAccount,
}: Readonly<Props>) {
  const accountImpact = pctOfAccount(calc.net);

  return (
    <div
      className="border-edge rounded-xl border p-4"
      style={{ backgroundColor: tint(theme.surfaceAlt, '80') }}
    >
      <div className="text-tertiary mb-2 font-sans text-[10px] font-bold tracking-[0.10em] uppercase">
        Trade Results · {contracts} contract{contracts !== 1 ? 's' : ''}
      </div>
      <div className="divide-edge divide-y">
        <ResultRow
          label="Points moved"
          value={`${calc.points >= 0 ? '+' : ''}${fmtPrice(calc.points)} pts`}
          color={pnlColor(calc.points)}
        />
        <ResultRow
          label="Ticks moved"
          value={`${calc.ticks >= 0 ? '+' : ''}${calc.ticks.toFixed(0)} ticks`}
          color={pnlColor(calc.ticks)}
        />
        <ResultRow
          label="Gross P&L"
          value={fmtDollar(calc.gross, true)}
          color={pnlColor(calc.gross)}
        />
        <ResultRow
          label={`Buy-side fees (${contracts}× $${feePerSide.toFixed(2)})`}
          value={fmtDollar(-feesPerSide(spec, contracts))}
          color={theme.red}
        />
        <ResultRow
          label={`Sell-side fees (${contracts}× $${feePerSide.toFixed(2)})`}
          value={fmtDollar(-feesPerSide(spec, contracts))}
          color={theme.red}
        />
        <ResultRow
          label="Total round-trip fees"
          value={fmtDollar(-calc.fees)}
          color={theme.red}
        />
      </div>

      {/* Net P&L highlight */}
      <div
        className="mt-3 flex items-center justify-between rounded-lg px-4 py-3"
        style={{
          backgroundColor: tint(pnlColor(calc.net), '12'),
          border: `1px solid ${tint(pnlColor(calc.net), '30')}`,
        }}
      >
        <span
          className="font-sans text-[12px] font-bold tracking-wide uppercase"
          style={{ color: pnlColor(calc.net) }}
        >
          Net P&amp;L
        </span>
        <span
          className="font-mono text-[18px] font-bold"
          style={{ color: pnlColor(calc.net) }}
        >
          {fmtDollar(calc.net, true)}
        </span>
      </div>

      {/* Margin, ROM & R:R */}
      <div className="mt-2 divide-y" style={{ borderColor: theme.border }}>
        <ResultRow
          label="Day margin required"
          value={fmtDollar(calc.marginRequired)}
        />
        {rrRatio !== null && (
          <ResultRow
            label="Risk:Reward (vs stop)"
            value={
              rrRatio > 0
                ? `${rrRatio.toFixed(2)}:1`
                : `${rrRatio.toFixed(2)}:1 (loss)`
            }
            color={
              rrRatio >= 1
                ? theme.green
                : rrRatio > 0
                  ? theme.caution
                  : theme.red
            }
          />
        )}
        {accountImpact !== null && (
          <ResultRow
            label="Account impact"
            value={accountImpact}
            color={pnlColor(calc.net)}
          />
        )}
        <ResultRow
          label="Return on margin"
          value={`${calc.returnOnMarginPct >= 0 ? '+' : ''}${calc.returnOnMarginPct.toFixed(2)}%`}
          color={pnlColor(calc.returnOnMarginPct)}
          bold
        />
      </div>
    </div>
  );
}
