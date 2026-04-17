/**
 * MAE (Max Adverse Excursion) and MFE (Max Favorable Excursion) panels —
 * rendered when the corresponding input (adverse / favorable) has a valid
 * price. Both share the same table shape, so one component covers both
 * with a color and label variant.
 */

import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import { ResultRow } from './ui-primitives';
import { fmtPrice, fmtDollar, pnlColor } from './formatters';
import type { TradeCalc } from './useFuturesCalc';

interface ExcursionProps {
  calc: TradeCalc;
  contracts: number;
  pctOfAccount: (dollars: number) => string | null;
}

interface Props {
  adverseCalc: TradeCalc | null;
  favorableCalc: TradeCalc | null;
  contracts: number;
  pctOfAccount: (dollars: number) => string | null;
}

function ExcursionPanel({
  calc,
  contracts,
  pctOfAccount,
  variant,
}: Readonly<ExcursionProps & { variant: 'mae' | 'mfe' }>) {
  const color = variant === 'mae' ? theme.red : theme.green;
  const titleLabel =
    variant === 'mae' ? 'Max Adverse Excursion' : 'Max Favorable Excursion';
  const moveLabel = variant === 'mae' ? 'Adverse move' : 'Favorable move';
  const grossLabel = variant === 'mae' ? 'Gross exposure' : 'Gross upside';
  const netLabel =
    variant === 'mae' ? 'Net exposure (after fees)' : 'Net upside (after fees)';
  const accountImpact = pctOfAccount(calc.net);

  return (
    <div
      className="rounded-xl border p-4"
      style={{
        backgroundColor: tint(color, '08'),
        borderColor: tint(color, '20'),
      }}
    >
      <div
        className="mb-2 font-sans text-[10px] font-bold tracking-[0.10em] uppercase"
        style={{ color }}
      >
        {titleLabel} · {contracts} contract{contracts !== 1 ? 's' : ''}
      </div>
      <div className="divide-edge divide-y">
        <ResultRow
          label={moveLabel}
          value={`${calc.points >= 0 ? '+' : ''}${fmtPrice(calc.points)} pts / ${calc.ticks >= 0 ? '+' : ''}${calc.ticks.toFixed(0)} ticks`}
          color={pnlColor(calc.points)}
        />
        <ResultRow
          label={grossLabel}
          value={fmtDollar(calc.gross, true)}
          color={pnlColor(calc.gross)}
        />
        <ResultRow
          label={netLabel}
          value={fmtDollar(calc.net, true)}
          color={pnlColor(calc.net)}
          bold
        />
        {accountImpact !== null && (
          <ResultRow
            label="Account impact"
            value={accountImpact}
            color={pnlColor(calc.net)}
          />
        )}
      </div>
    </div>
  );
}

export function ExcursionPanels({
  adverseCalc,
  favorableCalc,
  contracts,
  pctOfAccount,
}: Readonly<Props>) {
  return (
    <>
      {adverseCalc && (
        <ExcursionPanel
          calc={adverseCalc}
          contracts={contracts}
          pctOfAccount={pctOfAccount}
          variant="mae"
        />
      )}
      {favorableCalc && (
        <ExcursionPanel
          calc={favorableCalc}
          contracts={contracts}
          pctOfAccount={pctOfAccount}
          variant="mfe"
        />
      )}
    </>
  );
}
