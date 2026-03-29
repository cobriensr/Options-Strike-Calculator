import { theme } from '../../themes';
import type { IronCondorLegs } from '../../types';
import { mkTh, mkTd, fmtDollar } from '../../utils/ui-utils';
import { ScrollHint } from '../ui';

interface Props {
  icRows: IronCondorLegs[];
  contracts: number;
  effectiveRatio: number;
}

export default function PnLProfileTable({
  icRows,
  contracts,
  effectiveRatio,
}: Props) {
  return (
    <>
      <div className="text-accent mt-4 mb-2.5 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
        P&L Profile {'\u2014'} {contracts} contract{contracts === 1 ? '' : 's'}{' '}
        (theoretical)
      </div>
      <ScrollHint>
        <section
          className="border-edge rounded-[10px] border"
          aria-label="P&amp;L profile"
        >
          <table
            className="w-full border-collapse font-mono text-[13px]"
            role="table"
            aria-label="Iron condor P&L by delta"
          >
            <thead>
              <tr className="bg-table-header">
                <th scope="col" className={mkTh('center')}>
                  Delta
                </th>
                <th scope="col" className={mkTh('left')}>
                  Side
                </th>
                <th scope="col" className={mkTh('right')}>
                  Credit
                </th>
                <th scope="col" className={mkTh('right')}>
                  Max Loss
                </th>
                <th scope="col" className={mkTh('right')}>
                  Buying Pwr
                </th>
                <th scope="col" className={mkTh('right')}>
                  RoR
                </th>
                <th scope="col" className={mkTh('right')}>
                  PoP
                </th>
                <th scope="col" className={mkTh('right')}>
                  SPX BE
                </th>
                <th scope="col" className={mkTh('right')}>
                  SPY BE
                </th>
              </tr>
            </thead>
            <tbody>
              {icRows.map((ic, i) => {
                const mult = 100 * contracts;
                const groupBg = i % 2 === 1 ? 'bg-table-alt' : 'bg-surface';
                const borderStyle = '2px solid var(--color-edge)';

                const rows = [
                  {
                    key: ic.delta + '-put',
                    side: 'Put Spread',
                    sideColor: theme.red,
                    credit: ic.putSpreadCredit,
                    maxLoss: ic.putSpreadMaxLoss,
                    ror: ic.putSpreadRoR,
                    pop: ic.putSpreadPoP,
                    adjPop: ic.adjustedPutSpreadPoP,
                    be: ic.putSpreadBE.toFixed(0),
                    spyBe: Math.round(
                      ic.putSpreadBE / effectiveRatio,
                    ).toString(),
                    isFirst: true,
                    isLast: false,
                  },
                  {
                    key: ic.delta + '-call',
                    side: 'Call Spread',
                    sideColor: theme.green,
                    credit: ic.callSpreadCredit,
                    maxLoss: ic.callSpreadMaxLoss,
                    ror: ic.callSpreadRoR,
                    pop: ic.callSpreadPoP,
                    adjPop: ic.adjustedCallSpreadPoP,
                    be: ic.callSpreadBE.toFixed(0),
                    spyBe: Math.round(
                      ic.callSpreadBE / effectiveRatio,
                    ).toString(),
                    isFirst: false,
                    isLast: false,
                  },
                  {
                    key: ic.delta + '-ic',
                    side: 'Iron Condor',
                    sideColor: theme.accent,
                    credit: ic.creditReceived,
                    maxLoss: ic.maxLoss,
                    ror: ic.returnOnRisk,
                    pop: ic.probabilityOfProfit,
                    adjPop: ic.adjustedPoP,
                    be:
                      ic.breakEvenLow.toFixed(0) +
                      '\u2013' +
                      ic.breakEvenHigh.toFixed(0),
                    spyBe:
                      Math.round(ic.breakEvenLow / effectiveRatio) +
                      '\u2013' +
                      Math.round(ic.breakEvenHigh / effectiveRatio),
                    isFirst: false,
                    isLast: true,
                  },
                ];

                return rows.map((r) => (
                  <tr
                    key={r.key}
                    className={groupBg}
                    style={{ borderBottom: r.isLast ? borderStyle : undefined }}
                  >
                    {r.isFirst && (
                      <td
                        rowSpan={3}
                        className={`${mkTd()} text-accent text-center align-middle font-bold`}
                        style={{ borderBottom: borderStyle }}
                      >
                        {ic.delta}
                        {'\u0394'}
                      </td>
                    )}
                    <td
                      className={`${mkTd()} ${r.isLast ? 'text-[13px] font-bold' : 'text-xs font-medium'}`}
                      style={{
                        color: r.sideColor,
                        borderBottom: r.isLast
                          ? borderStyle
                          : '1px solid var(--color-edge)',
                      }}
                    >
                      {r.side}
                    </td>
                    <td
                      className={`${mkTd()} text-success text-right ${r.isLast ? 'font-bold' : 'font-medium'}`}
                      style={{
                        borderBottom: r.isLast
                          ? borderStyle
                          : '1px solid var(--color-edge)',
                      }}
                    >
                      {'$' + fmtDollar(r.credit * mult)}
                      <div className="text-muted text-[10px] font-normal">
                        {r.credit.toFixed(2)} pts
                      </div>
                    </td>
                    <td
                      className={`${mkTd()} text-danger text-right ${r.isLast ? 'font-bold' : 'font-medium'}`}
                      style={{
                        borderBottom: r.isLast
                          ? borderStyle
                          : '1px solid var(--color-edge)',
                      }}
                    >
                      {'$' + fmtDollar(r.maxLoss * mult)}
                      <div className="text-muted text-[10px] font-normal">
                        {r.maxLoss.toFixed(2)} pts
                      </div>
                    </td>
                    <td
                      className={`${mkTd()} text-primary text-right ${r.isLast ? 'font-bold' : 'font-medium'}`}
                      style={{
                        borderBottom: r.isLast
                          ? borderStyle
                          : '1px solid var(--color-edge)',
                      }}
                    >
                      {'$' + fmtDollar(r.maxLoss * mult)}
                    </td>
                    <td
                      className={`${mkTd()} text-accent text-right ${r.isLast ? 'font-bold' : 'font-semibold'}`}
                      style={{
                        borderBottom: r.isLast
                          ? borderStyle
                          : '1px solid var(--color-edge)',
                      }}
                    >
                      {(r.ror * 100).toFixed(1)}%
                    </td>
                    <td
                      className={`${mkTd()} text-right ${r.isLast ? 'font-bold' : 'font-semibold'}`}
                      style={{
                        borderBottom: r.isLast
                          ? borderStyle
                          : '1px solid var(--color-edge)',
                      }}
                    >
                      <span style={{ color: theme.green }}>
                        {(r.adjPop * 100).toFixed(1)}%
                      </span>
                      <div
                        className="text-[10px] font-normal line-through opacity-50"
                        title="Log-normal PoP (without fat-tail adjustment)"
                      >
                        {(r.pop * 100).toFixed(1)}%
                      </div>
                    </td>
                    <td
                      className={`${mkTd()} text-secondary text-right`}
                      style={{
                        borderBottom: r.isLast
                          ? borderStyle
                          : '1px solid var(--color-edge)',
                      }}
                    >
                      {r.be}
                    </td>
                    <td
                      className={`${mkTd()} text-secondary text-right opacity-75`}
                      style={{
                        borderBottom: r.isLast
                          ? borderStyle
                          : '1px solid var(--color-edge)',
                      }}
                    >
                      {r.spyBe}
                    </td>
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </section>
      </ScrollHint>
    </>
  );
}
