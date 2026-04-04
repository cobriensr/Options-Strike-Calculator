import { theme } from '../../themes';
import type { HedgeScenario } from '../../types';
import { mkTh, mkTd, fmtDollar } from '../../utils/ui-utils';

interface Props {
  scenarios: readonly HedgeScenario[];
  spot: number;
  direction: 'crash' | 'rally';
}

export default function ScenarioTable({
  scenarios,
  spot,
  direction,
}: Readonly<Props>) {
  return (
    <section
      className="border-edge overflow-x-auto rounded-[10px] border"
      aria-label="Hedge scenarios"
    >
      <table
        className="w-full border-collapse font-mono text-xs"
        role="table"
        aria-label={'Hedge P&L ' + direction + ' scenarios'}
      >
        <thead>
          <tr className="bg-table-header">
            <th scope="col" className={mkTh('right')}>
              Move
            </th>
            <th scope="col" className={mkTh('right')}>
              SPX
            </th>
            <th scope="col" className={mkTh('right')}>
              IC P&L
            </th>
            <th
              scope="col"
              className={mkTh(
                'right',
                direction === 'crash' ? 'text-danger' : 'text-success',
              )}
            >
              {direction === 'crash' ? 'Put' : 'Call'} Hedge
            </th>
            <th scope="col" className={mkTh('right')}>
              Hedge Cost
            </th>
            <th scope="col" className={mkTh('right')}>
              Net P&L
            </th>
          </tr>
        </thead>
        <tbody>
          {scenarios.map((s, i) => {
            const spxLevel =
              direction === 'crash' ? spot - s.movePoints : spot + s.movePoints;
            const hedgePayout =
              direction === 'crash' ? s.hedgePutPnL : s.hedgeCallPnL;
            return (
              <tr
                key={s.movePoints}
                className={i % 2 === 1 ? 'bg-table-alt' : 'bg-surface'}
              >
                <td className={`${mkTd()} text-right font-semibold`}>
                  {direction === 'crash' ? '\u2193' : '\u2191'}
                  {s.movePoints}{' '}
                  <span className="text-muted text-[10px]">({s.movePct}%)</span>
                </td>
                <td className={`${mkTd()} text-secondary text-right`}>
                  {Math.round(spxLevel)}
                </td>
                <td
                  className={`${mkTd()} text-right font-semibold`}
                  style={{ color: s.icPnL >= 0 ? theme.green : theme.red }}
                >
                  <span className="sr-only">
                    {s.icPnL >= 0 ? '(gain)' : '(loss)'}
                  </span>
                  {s.icPnL >= 0 ? '+' : ''}
                  {fmtDollar(s.icPnL)}
                </td>
                <td
                  className={`${mkTd()} text-right`}
                  style={{
                    color: hedgePayout > 0 ? theme.green : theme.textMuted,
                  }}
                >
                  <span className="sr-only">
                    {hedgePayout > 0 ? '(gain)' : '(no payout)'}
                  </span>
                  {hedgePayout > 0 ? '+$' + fmtDollar(hedgePayout) : '$0'}
                </td>
                <td className={`${mkTd()} text-danger text-right text-[11px]`}>
                  {fmtDollar(s.hedgeCost)}
                </td>
                <td
                  className={`${mkTd()} text-right text-[13px] font-bold`}
                  style={{ color: s.netPnL >= 0 ? theme.green : theme.red }}
                >
                  <span className="sr-only">
                    {s.netPnL >= 0 ? '(gain)' : '(loss)'}
                  </span>
                  {s.netPnL >= 0 ? '+' : ''}${fmtDollar(s.netPnL)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
