import type { BWBSide, BWBMetrics, PnlRow } from './bwb-math';
import { fmtSpx, fmtPnl } from './bwb-math';

interface BWBResultsProps {
  side: BWBSide;
  contracts: number;
  low: number;
  mid: number;
  high: number;
  net: number;
  metrics: BWBMetrics;
  pnlRows: PnlRow[];
  midStrike: string;
}

export default function BWBResults({
  side,
  contracts,
  low,
  mid,
  high,
  net,
  metrics,
  pnlRows,
  midStrike,
}: Readonly<BWBResultsProps>) {
  const mult = 100 * contracts;
  const sideLabel = side === 'calls' ? 'Call' : 'Put';
  const safeSideLabel = side === 'calls' ? 'Below ' + low : 'Above ' + high;
  const riskSideLabel = side === 'calls' ? 'Above ' + high : 'Below ' + low;

  return (
    <>
      {/* Trade Summary */}
      <div className="bg-surface-alt mt-4 rounded-lg p-3">
        <div className="text-secondary mb-2 font-mono text-[12px] leading-relaxed">
          <div>
            Buy {contracts} {'\u00D7'} {low} {sideLabel}
          </div>
          <div className="text-accent font-semibold">
            Sell {contracts * 2} {'\u00D7'} {mid} {sideLabel}
          </div>
          <div>
            Buy {contracts} {'\u00D7'} {high} {sideLabel}
          </div>
        </div>

        <div className="border-edge border-t pt-2">
          <div className="flex items-baseline justify-between">
            <span className="text-tertiary font-sans text-[11px] font-bold uppercase">
              Net per contract
            </span>
            <span
              className={
                'font-mono text-lg font-bold ' +
                (net >= 0 ? 'text-success' : 'text-danger')
              }
            >
              ${Math.abs(net).toFixed(2)}{' '}
              <span className="text-sm font-medium">
                {net >= 0 ? 'CREDIT' : 'DEBIT'}
              </span>
            </span>
          </div>
          <div className="text-muted mt-0.5 text-right font-mono text-xs">
            Total: {fmtPnl(net * mult)} ({contracts} {'\u00D7'} $
            {Math.abs(Math.round(net * 100)).toLocaleString()})
          </div>
        </div>

        <div className="border-edge mt-2 grid grid-cols-2 gap-2 border-t pt-2">
          <div>
            <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
              Narrow wing
            </div>
            <div className="text-primary font-mono text-sm">
              {metrics.narrowWidth} pts
            </div>
          </div>
          <div>
            <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
              Wide wing
            </div>
            <div className="text-primary font-mono text-sm">
              {metrics.wideWidth} pts
            </div>
          </div>
        </div>
      </div>

      {/* Key Numbers */}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <div className="bg-surface-alt rounded-lg p-3">
          <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
            Max Profit
          </div>
          <div className="text-success font-mono text-[17px] font-bold">
            {fmtPnl(metrics.maxProfit * mult)}
          </div>
          <div className="text-muted font-mono text-[10px]">
            at {midStrike} (sweet spot)
          </div>
        </div>
        <div className="bg-surface-alt rounded-lg p-3">
          <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
            Max Loss {side === 'calls' ? '\u2191' : '\u2193'}
          </div>
          <div className="text-danger font-mono text-[17px] font-bold">
            {fmtPnl(metrics.riskPnl * mult)}
          </div>
          <div className="text-muted font-mono text-[10px]">
            {riskSideLabel}
          </div>
        </div>
        <div className="bg-surface-alt rounded-lg p-3">
          <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
            {net >= 0 ? 'Safe side' : 'Safe loss'}{' '}
            {side === 'calls' ? '\u2193' : '\u2191'}
          </div>
          <div
            className={
              'font-mono text-[17px] font-bold ' +
              (metrics.safePnl >= 0 ? 'text-success' : 'text-danger')
            }
          >
            {fmtPnl(metrics.safePnl * mult)}
          </div>
          <div className="text-muted font-mono text-[10px]">
            {safeSideLabel}
          </div>
        </div>
        <div className="bg-surface-alt rounded-lg p-3">
          <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
            Breakevens
          </div>
          <div className="text-accent font-mono text-[15px] font-bold">
            {metrics.lowerBE !== null ? fmtSpx(metrics.lowerBE) : '\u2014'}
            {', '}
            {metrics.upperBE !== null ? fmtSpx(metrics.upperBE) : '\u2014'}
          </div>
        </div>
      </div>

      {/* P&L Profile Table */}
      <div className="mt-4">
        <div className="text-accent mb-2 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
          P&L at Expiry {'\u2014'} {contracts} contract
          {contracts === 1 ? '' : 's'}
        </div>
        <div className="border-edge max-h-[420px] overflow-y-auto rounded-[10px] border">
          <table
            className="w-full border-collapse font-mono text-[13px]"
            role="table"
            aria-label="BWB P&L at expiry"
          >
            <thead className="bg-table-header sticky top-0">
              <tr>
                <th className="border-edge text-tertiary border-b-2 px-3 py-2 text-left text-[11px] font-bold tracking-[0.06em] uppercase">
                  SPX at Expiry
                </th>
                <th className="border-edge text-tertiary border-b-2 px-3 py-2 text-right text-[11px] font-bold tracking-[0.06em] uppercase">
                  Per Contract
                </th>
                <th className="border-edge text-tertiary border-b-2 px-3 py-2 text-right text-[11px] font-bold tracking-[0.06em] uppercase">
                  Total ({contracts})
                </th>
                <th className="border-edge text-tertiary border-b-2 px-3 py-2 text-left text-[11px] font-bold tracking-[0.06em] uppercase">
                  Zone
                </th>
              </tr>
            </thead>
            <tbody>
              {pnlRows.map((row, i) => {
                const isProfit = row.pnlPerContract > 0.5;
                const isLoss = row.pnlPerContract < -0.5;
                const colorCls = isProfit
                  ? 'text-success'
                  : isLoss
                    ? 'text-danger'
                    : 'text-secondary';
                const bgCls = row.isKey
                  ? 'bg-accent-bg'
                  : i % 2 === 1
                    ? 'bg-table-alt'
                    : 'bg-surface';
                const fontCls = row.isKey ? 'font-bold' : '';

                return (
                  <tr key={row.spx} className={bgCls}>
                    <td
                      className={`border-edge border-b px-3 py-1.5 text-sm ${fontCls} ${row.isKey ? 'text-accent' : 'text-primary'}`}
                    >
                      {fmtSpx(row.spx)}
                      {row.spx === low && ' \u25C0'}
                      {row.spx === mid && ' \u2605'}
                      {row.spx === high && ' \u25C0'}
                    </td>
                    <td
                      className={`border-edge border-b px-3 py-1.5 text-right text-sm ${fontCls} ${colorCls}`}
                    >
                      {fmtPnl(row.pnlPerContract)}
                    </td>
                    <td
                      className={`border-edge border-b px-3 py-1.5 text-right text-sm ${fontCls} ${colorCls}`}
                    >
                      {fmtPnl(row.pnlTotal)}
                    </td>
                    <td
                      className={`border-edge border-b px-3 py-1.5 text-sm ${fontCls} ${row.label === 'Max profit' ? 'text-success' : row.label === 'Breakeven' ? 'text-accent' : 'text-muted'}`}
                    >
                      {row.label}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-muted mt-2 text-[11px] italic">
        P&L based on actual fill prices entered above. SPX $100 multiplier
        {' \u00D7 '}
        {contracts} contract{contracts === 1 ? '' : 's'}. {'\u2605'} = sweet
        spot, {'\u25C0'} = wing strike.
      </p>
    </>
  );
}
