import { useState } from 'react';
import type { BWBSide } from './bwb-math';
import {
  calcNet,
  calcMetrics,
  generatePnlRows,
  fmtSpx,
  fmtPnl,
} from './bwb-math';

const INPUT =
  'bg-input border-[1.5px] border-edge-strong hover:border-edge-heavy rounded-lg text-primary p-[10px_12px] text-[15px] font-mono outline-none w-full transition-[border-color] duration-150';

const LABEL =
  'text-tertiary font-sans text-[10px] font-bold uppercase tracking-[0.08em]';

export default function BWBCalculator() {
  const [side, setSide] = useState<BWBSide>('calls');
  const [lowStrike, setLowStrike] = useState('');
  const [midStrike, setMidStrike] = useState('');
  const [highStrike, setHighStrike] = useState('');
  const [lowPrice, setLowPrice] = useState('');
  const [midPrice, setMidPrice] = useState('');
  const [highPrice, setHighPrice] = useState('');
  const [contracts, setContracts] = useState(1);

  // Parse inputs
  const low = Number.parseFloat(lowStrike);
  const mid = Number.parseFloat(midStrike);
  const high = Number.parseFloat(highStrike);
  const lp = Number.parseFloat(lowPrice);
  const mp = Number.parseFloat(midPrice);
  const hp = Number.parseFloat(highPrice);

  const strikesValid =
    Number.isFinite(low) &&
    Number.isFinite(mid) &&
    Number.isFinite(high) &&
    low < mid &&
    mid < high;
  const pricesValid =
    Number.isFinite(lp) &&
    Number.isFinite(mp) &&
    Number.isFinite(hp) &&
    lp >= 0 &&
    mp >= 0 &&
    hp >= 0;
  const allValid = strikesValid && pricesValid;

  const net = allValid ? calcNet(lp, mp, hp) : 0;
  const metrics = allValid ? calcMetrics(side, low, mid, high, net) : null;
  const pnlRows = allValid
    ? generatePnlRows(side, low, mid, high, net, contracts)
    : [];

  const handleClear = () => {
    setLowStrike('');
    setMidStrike('');
    setHighStrike('');
    setLowPrice('');
    setMidPrice('');
    setHighPrice('');
    setContracts(1);
  };

  const mult = 100 * contracts;
  const sideLabel = side === 'calls' ? 'Call' : 'Put';
  const safeSideLabel =
    side === 'calls' ? 'Below ' + lowStrike : 'Above ' + highStrike;
  const riskSideLabel =
    side === 'calls' ? 'Above ' + highStrike : 'Below ' + lowStrike;

  return (
    <section
      aria-label="BWB live calculator"
      className="bg-surface border-edge-heavy rounded-[14px] border-2 p-[24px_20px] shadow-[0_4px_12px_rgba(0,0,0,0.08),0_12px_32px_rgba(0,0,0,0.06)]"
    >
      {/* Header */}
      <div className="mb-5 flex items-center justify-between">
        <div className="text-accent font-sans text-[13px] font-bold tracking-[0.12em] uppercase">
          BWB Live Calculator
        </div>
        <button
          onClick={handleClear}
          className="border-edge-strong bg-chip-bg text-secondary cursor-pointer rounded-md border-[1.5px] px-3 py-1.5 font-sans text-xs font-semibold hover:border-red-400 hover:text-red-400"
        >
          Clear
        </button>
      </div>

      {/* Side toggle + Contracts */}
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="flex gap-1.5">
          {(['calls', 'puts'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSide(s)}
              className={
                'cursor-pointer rounded-md border-[1.5px] px-4 py-1.5 font-sans text-xs font-semibold transition-colors duration-100 ' +
                (side === s
                  ? 'border-chip-active-border bg-chip-active-bg text-chip-active-text'
                  : 'border-chip-border bg-chip-bg text-chip-text hover:border-edge-heavy hover:bg-surface-alt')
              }
            >
              {s === 'calls' ? 'Calls' : 'Puts'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0">
          <span className={LABEL + ' mr-2'}>Contracts</span>
          <button
            onClick={() => setContracts(Math.max(1, contracts - 1))}
            className="border-edge-strong bg-chip-bg text-primary flex h-8 w-8 cursor-pointer items-center justify-center rounded-l-md border-[1.5px] border-r-0 font-mono text-base font-bold"
          >
            {'\u2212'}
          </button>
          <input
            type="text"
            inputMode="numeric"
            value={contracts}
            onChange={(e) => {
              const v = Number.parseInt(e.target.value);
              if (!Number.isNaN(v) && v >= 1 && v <= 999) setContracts(v);
              else if (e.target.value === '') setContracts(1);
            }}
            className="border-edge-strong bg-input text-primary h-8 w-[48px] border-[1.5px] text-center font-mono text-[15px] font-semibold outline-none"
            aria-label="Number of contracts"
          />
          <button
            onClick={() => setContracts(Math.min(999, contracts + 1))}
            className="border-edge-strong bg-chip-bg text-primary flex h-8 w-8 cursor-pointer items-center justify-center rounded-r-md border-[1.5px] border-l-0 font-mono text-base font-bold"
          >
            +
          </button>
        </div>
      </div>

      {/* Strike + Price inputs */}
      <div className="border-edge rounded-lg border p-3">
        <div className="mb-2 grid grid-cols-[auto_1fr_1fr] gap-x-3 gap-y-0.5">
          <div />
          <div className={LABEL + ' text-center'}>Strike</div>
          <div className={LABEL + ' text-center'}>Price (per ctr)</div>
        </div>
        {[
          {
            label: 'Low',
            sub: 'buy 1',
            strike: lowStrike,
            setStrike: setLowStrike,
            price: lowPrice,
            setPrice: setLowPrice,
          },
          {
            label: 'Mid',
            sub: 'sell \u00D72',
            strike: midStrike,
            setStrike: setMidStrike,
            price: midPrice,
            setPrice: setMidPrice,
          },
          {
            label: 'High',
            sub: 'buy 1',
            strike: highStrike,
            setStrike: setHighStrike,
            price: highPrice,
            setPrice: setHighPrice,
          },
        ].map((row) => (
          <div
            key={row.label}
            className="mb-2 grid grid-cols-[auto_1fr_1fr] items-center gap-x-3"
          >
            <div className="w-[70px]">
              <span className="text-primary font-sans text-sm font-semibold">
                {row.label}
              </span>
              <span className="text-muted ml-1 text-[10px]">({row.sub})</span>
            </div>
            <input
              type="text"
              inputMode="decimal"
              placeholder="e.g. 6500"
              value={row.strike}
              onChange={(e) => row.setStrike(e.target.value)}
              className={INPUT}
              aria-label={row.label + ' strike'}
            />
            <input
              type="text"
              inputMode="decimal"
              placeholder="e.g. 12.10"
              value={row.price}
              onChange={(e) => row.setPrice(e.target.value)}
              className={INPUT}
              aria-label={row.label + ' price'}
            />
          </div>
        ))}
      </div>

      {/* Validation hints */}
      {lowStrike && midStrike && highStrike && !strikesValid && (
        <p className="text-danger mt-2 text-xs">
          Strikes must be in ascending order: low {'<'} mid {'<'} high.
        </p>
      )}

      {/* Results — only when all inputs are valid */}
      {allValid && metrics && (
        <>
          {/* Trade Summary */}
          <div className="bg-surface-alt mt-4 rounded-lg p-3">
            <div className="text-secondary mb-2 font-mono text-[12px] leading-relaxed">
              <div>
                Buy {contracts} {'\u00D7'} {lowStrike} {sideLabel} @ $
                {lp.toFixed(2)}
              </div>
              <div className="text-accent font-semibold">
                Sell {contracts * 2} {'\u00D7'} {midStrike} {sideLabel} @ $
                {mp.toFixed(2)}
              </div>
              <div>
                Buy {contracts} {'\u00D7'} {highStrike} {sideLabel} @ $
                {hp.toFixed(2)}
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
                <div className={LABEL}>Narrow wing</div>
                <div className="text-primary font-mono text-sm">
                  {metrics.narrowWidth} pts
                </div>
              </div>
              <div>
                <div className={LABEL}>Wide wing</div>
                <div className="text-primary font-mono text-sm">
                  {metrics.wideWidth} pts
                </div>
              </div>
            </div>
          </div>

          {/* Key Numbers */}
          <div className="mt-4 grid grid-cols-2 gap-2">
            <div className="bg-surface-alt rounded-lg p-3">
              <div className={LABEL}>Max Profit</div>
              <div className="text-success font-mono text-[17px] font-bold">
                {fmtPnl(metrics.maxProfit * mult)}
              </div>
              <div className="text-muted font-mono text-[10px]">
                at {midStrike} (sweet spot)
              </div>
            </div>
            <div className="bg-surface-alt rounded-lg p-3">
              <div className={LABEL}>
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
              <div className={LABEL}>
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
              <div className={LABEL}>Breakevens</div>
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
      )}

      {/* Empty state */}
      {!allValid && (
        <div className="text-muted mt-5 text-center text-sm italic">
          Enter three strikes and their fill prices to see the P&L profile.
        </div>
      )}
    </section>
  );
}
