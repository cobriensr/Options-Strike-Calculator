import { theme } from '../../themes';
import type { BWBLegs } from '../../types';
import { mkTh, mkTd, fmtDollar } from '../../utils/ui-utils';
import { ScrollHint } from '../ui';

interface Props {
  putRows: BWBLegs[];
  callRows: BWBLegs[];
  contracts: number;
  effectiveRatio: number;
}

export default function BWBPnLProfileTable({
  putRows,
  callRows,
  contracts,
  effectiveRatio,
}: Readonly<Props>) {
  return (
    <>
      <div className="text-accent mt-4 mb-2.5 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
        P&L Profile {'\u2014'} {contracts} contract
        {contracts === 1 ? '' : 's'} (theoretical)
      </div>
      <ScrollHint>
        <section
          className="border-edge rounded-[10px] border"
          aria-label="BWB P&amp;L profile"
        >
          <table
            className="w-full border-collapse font-mono text-[13px]"
            role="table"
            aria-label="BWB P&L by delta"
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
                  Max Profit
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
                <th scope="col" className={mkTh('right')}>
                  Sweet Spot
                </th>
              </tr>
            </thead>
            <tbody>
              {putRows.map((put, i) => {
                const call = callRows[i];
                const mult = 100 * contracts;
                const groupBg = i % 2 === 1 ? 'bg-table-alt' : 'bg-surface';
                const borderStyle = '2px solid var(--color-edge)';

                const rows = [
                  {
                    key: put.delta + '-put',
                    side: 'Put BWB',
                    sideColor: theme.red,
                    credit: put.netCredit,
                    maxProfit: put.maxProfit,
                    maxLoss: put.maxLoss,
                    ror: put.returnOnRisk,
                    pop: put.probabilityOfProfit,
                    adjPop: put.adjustedPoP,
                    be: put.breakeven.toFixed(0),
                    spyBe: Math.round(
                      put.breakeven / effectiveRatio,
                    ).toString(),
                    sweetSpot: put.sweetSpot.toFixed(0),
                    isFirst: true,
                  },
                  ...(call
                    ? [
                        {
                          key: call.delta + '-call',
                          side: 'Call BWB',
                          sideColor: theme.green,
                          credit: call.netCredit,
                          maxProfit: call.maxProfit,
                          maxLoss: call.maxLoss,
                          ror: call.returnOnRisk,
                          pop: call.probabilityOfProfit,
                          adjPop: call.adjustedPoP,
                          be: call.breakeven.toFixed(0),
                          spyBe: Math.round(
                            call.breakeven / effectiveRatio,
                          ).toString(),
                          sweetSpot: call.sweetSpot.toFixed(0),
                          isFirst: false,
                        },
                      ]
                    : []),
                ];

                return rows.map((r) => (
                  <tr
                    key={r.key}
                    className={groupBg}
                    style={{
                      borderBottom: r.isFirst ? undefined : borderStyle,
                    }}
                  >
                    {r.isFirst && (
                      <td
                        rowSpan={2}
                        className={`${mkTd()} text-accent text-center align-middle font-bold`}
                        style={{ borderBottom: borderStyle }}
                      >
                        {put.delta}
                        {'\u0394'}
                      </td>
                    )}
                    <td
                      className={`${mkTd()} text-xs font-medium`}
                      style={{
                        color: r.sideColor,
                        borderBottom: r.isFirst
                          ? '1px solid var(--color-edge)'
                          : borderStyle,
                      }}
                    >
                      {r.side}
                    </td>
                    <td
                      className={`${mkTd()} text-right font-medium ${r.credit >= 0 ? 'text-success' : 'text-danger'}`}
                      style={{
                        borderBottom: r.isFirst
                          ? '1px solid var(--color-edge)'
                          : borderStyle,
                      }}
                    >
                      {'$' + fmtDollar(r.credit * mult)}
                      <div className="text-muted text-[10px] font-normal">
                        {r.credit.toFixed(2)} pts
                      </div>
                    </td>
                    <td
                      className={`${mkTd()} text-success text-right font-medium`}
                      style={{
                        borderBottom: r.isFirst
                          ? '1px solid var(--color-edge)'
                          : borderStyle,
                      }}
                    >
                      {'$' + fmtDollar(r.maxProfit * mult)}
                      <div className="text-muted text-[10px] font-normal">
                        {r.maxProfit.toFixed(2)} pts
                      </div>
                    </td>
                    <td
                      className={`${mkTd()} text-danger text-right font-medium`}
                      style={{
                        borderBottom: r.isFirst
                          ? '1px solid var(--color-edge)'
                          : borderStyle,
                      }}
                    >
                      {'$' + fmtDollar(r.maxLoss * mult)}
                      <div className="text-muted text-[10px] font-normal">
                        {r.maxLoss.toFixed(2)} pts
                      </div>
                    </td>
                    <td
                      className={`${mkTd()} text-primary text-right font-medium`}
                      style={{
                        borderBottom: r.isFirst
                          ? '1px solid var(--color-edge)'
                          : borderStyle,
                      }}
                    >
                      {'$' + fmtDollar(r.maxLoss * mult)}
                    </td>
                    <td
                      className={`${mkTd()} text-accent text-right font-semibold`}
                      style={{
                        borderBottom: r.isFirst
                          ? '1px solid var(--color-edge)'
                          : borderStyle,
                      }}
                    >
                      {(r.ror * 100).toFixed(1)}%
                    </td>
                    <td
                      className={`${mkTd()} text-right font-semibold`}
                      style={{
                        borderBottom: r.isFirst
                          ? '1px solid var(--color-edge)'
                          : borderStyle,
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
                        borderBottom: r.isFirst
                          ? '1px solid var(--color-edge)'
                          : borderStyle,
                      }}
                    >
                      {r.be}
                    </td>
                    <td
                      className={`${mkTd()} text-secondary text-right opacity-75`}
                      style={{
                        borderBottom: r.isFirst
                          ? '1px solid var(--color-edge)'
                          : borderStyle,
                      }}
                    >
                      {r.spyBe}
                    </td>
                    <td
                      className={`${mkTd()} text-accent text-right font-bold`}
                      style={{
                        borderBottom: r.isFirst
                          ? '1px solid var(--color-edge)'
                          : borderStyle,
                      }}
                    >
                      {r.sweetSpot}
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
