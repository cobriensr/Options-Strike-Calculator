import type { Theme } from '../themes';
import type { DeltaRow, DeltaRowError } from '../types';
import { mkTh, mkTd } from '../utils/ui-utils';

interface Props {
  th: Theme;
  allDeltas: ReadonlyArray<DeltaRow | DeltaRowError>;
  spot: number;
}

export default function DeltaStrikesTable({ allDeltas, spot }: Props) {
  return (
    <div className="border-edge overflow-x-auto rounded-[10px] border">
      <table
        className="w-full border-collapse font-mono text-[13px]"
        role="table"
        aria-label="Strike prices by delta"
      >
        <thead>
          <tr className="bg-table-header">
            <th className={mkTh('center')}>Delta</th>
            <th className={mkTh('left', 'text-danger')}>Put (SPX)</th>
            <th className={mkTh('left', 'text-danger')}>{'\u2192'} Snap</th>
            <th className={mkTh('left', 'text-danger')}>SPY</th>
            <th className={mkTh('right', 'text-danger')}>Put $</th>
            <th className={mkTh('right', 'text-danger')}>{'\u0394'}</th>
            <th className={mkTh('right', 'text-danger')}>{'\u0393'}</th>
            <th className={mkTh('left', 'text-success')}>Call (SPX)</th>
            <th className={mkTh('left', 'text-success')}>{'\u2192'} Snap</th>
            <th className={mkTh('left', 'text-success')}>SPY</th>
            <th className={mkTh('right', 'text-success')}>Call $</th>
            <th className={mkTh('right', 'text-success')}>{'\u0394'}</th>
            <th className={mkTh('right', 'text-success')}>{'\u0393'}</th>
            <th className={mkTh('left')}>Width</th>
          </tr>
        </thead>
        <tbody>
          {allDeltas.map((row, i) => {
            if ('error' in row) return null;
            const r = row as DeltaRow;
            return (
              <tr
                key={r.delta}
                className={i % 2 === 1 ? 'bg-table-alt' : 'bg-surface'}
              >
                <td className={`${mkTd()} text-accent text-center font-bold`}>
                  {r.delta}
                  {'\u0394'}
                </td>
                <td className={`${mkTd()} text-danger font-medium`}>
                  {r.putStrike}
                </td>
                <td className={`${mkTd()} text-danger opacity-80`}>
                  {r.putSnapped}
                </td>
                <td className={`${mkTd()} text-danger opacity-65`}>
                  {r.putSpySnapped}
                </td>
                <td
                  className={`${mkTd()} text-danger text-right font-semibold`}
                >
                  {r.putPremium.toFixed(2)}
                </td>
                <td className={`${mkTd()} text-danger text-right text-xs`}>
                  {(r.putActualDelta * 100).toFixed(1)}
                </td>
                <td
                  className={`${mkTd()} text-danger text-right text-[11px] opacity-70`}
                >
                  {r.putGamma.toFixed(4)}
                </td>
                <td className={`${mkTd()} text-success font-medium`}>
                  {r.callStrike}
                </td>
                <td className={`${mkTd()} text-success opacity-80`}>
                  {r.callSnapped}
                </td>
                <td className={`${mkTd()} text-success opacity-65`}>
                  {r.callSpySnapped}
                </td>
                <td
                  className={`${mkTd()} text-success text-right font-semibold`}
                >
                  {r.callPremium.toFixed(2)}
                </td>
                <td className={`${mkTd()} text-success text-right text-xs`}>
                  {(r.callActualDelta * 100).toFixed(1)}
                </td>
                <td
                  className={`${mkTd()} text-success text-right text-[11px] opacity-70`}
                >
                  {r.callGamma.toFixed(4)}
                </td>
                <td className={`${mkTd()} text-secondary`}>
                  {r.callStrike - r.putStrike}
                  <span className="text-muted ml-0.5 text-[11px]">
                    ({(((r.callStrike - r.putStrike) / spot) * 100).toFixed(1)}
                    %)
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
