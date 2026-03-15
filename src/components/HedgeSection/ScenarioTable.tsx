import type { Theme } from '../../themes';
import type { HedgeScenario } from '../../types';
import { mkTh, mkTd, fmtDollar } from '../../utils/ui-utils';

interface Props {
  th: Theme;
  scenarios: readonly HedgeScenario[];
  spot: number;
  direction: 'crash' | 'rally';
}

export default function ScenarioTable({
  th,
  scenarios,
  spot,
  direction,
}: Props) {
  return (
    <div className="border-edge overflow-x-auto rounded-[10px] border">
      <table
        className="w-full border-collapse font-mono text-xs"
        role="table"
        aria-label={'Hedge P&L ' + direction + ' scenarios'}
      >
        <thead>
          <tr className="bg-table-header">
            <th className={mkTh('right')}>Move</th>
            <th className={mkTh('right')}>SPX</th>
            <th className={mkTh('right')}>IC P&L</th>
            <th
              className={mkTh(
                'right',
                direction === 'crash' ? 'text-danger' : 'text-success',
              )}
            >
              {direction === 'crash' ? 'Put' : 'Call'} Hedge
            </th>
            <th className={mkTh('right')}>Hedge Cost</th>
            <th className={mkTh('right')}>Net P&L</th>
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
                  style={{ color: s.icPnL >= 0 ? th.green : th.red }}
                >
                  {s.icPnL >= 0 ? '+' : ''}
                  {fmtDollar(s.icPnL)}
                </td>
                <td
                  className={`${mkTd()} text-right`}
                  style={{ color: hedgePayout > 0 ? th.green : th.textMuted }}
                >
                  {hedgePayout > 0 ? '+$' + fmtDollar(hedgePayout) : '$0'}
                </td>
                <td className={`${mkTd()} text-danger text-right text-[11px]`}>
                  {fmtDollar(s.hedgeCost)}
                </td>
                <td
                  className={`${mkTd()} text-right text-[13px] font-bold`}
                  style={{ color: s.netPnL >= 0 ? th.green : th.red }}
                >
                  {s.netPnL >= 0 ? '+' : ''}${fmtDollar(s.netPnL)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
