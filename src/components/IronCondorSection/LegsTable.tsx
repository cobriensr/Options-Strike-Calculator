import type { IronCondorLegs } from '../../types';
import { mkTh, mkTd } from '../../utils/ui-utils';

interface Props {
  icRows: IronCondorLegs[];
}

export default function LegsTable({ icRows }: Props) {
  return (
    <section
      className="border-edge overflow-x-auto rounded-[10px] border"
      tabIndex={0}
      aria-label="Iron condor legs"
    >
      <table
        className="w-full border-collapse font-mono text-[13px]"
        role="table"
        aria-label="Iron condor legs by delta"
      >
        <thead>
          <tr className="bg-table-header">
            <th className={mkTh('center')}>Delta</th>
            <th className={mkTh('left', 'text-danger')}>Long Put</th>
            <th className={mkTh('left', 'text-danger')}>SPY</th>
            <th className={mkTh('left', 'text-danger')}>Short Put</th>
            <th className={mkTh('left', 'text-danger')}>SPY</th>
            <th className={mkTh('left', 'text-success')}>Short Call</th>
            <th className={mkTh('left', 'text-success')}>SPY</th>
            <th className={mkTh('left', 'text-success')}>Long Call</th>
            <th className={mkTh('left', 'text-success')}>SPY</th>
          </tr>
        </thead>
        <tbody>
          {icRows.map((ic, i) => (
            <tr
              key={ic.delta}
              className={i % 2 === 1 ? 'bg-table-alt' : 'bg-surface'}
            >
              <td className={`${mkTd()} text-accent text-center font-bold`}>
                {ic.delta}
                {'\u0394'}
              </td>
              <td className={`${mkTd()} text-danger`}>{ic.longPut}</td>
              <td className={`${mkTd()} text-danger opacity-65`}>
                {ic.longPutSpy}
              </td>
              <td className={`${mkTd()} text-danger font-semibold`}>
                {ic.shortPut}
              </td>
              <td className={`${mkTd()} text-danger font-semibold opacity-65`}>
                {ic.shortPutSpy}
              </td>
              <td className={`${mkTd()} text-success font-semibold`}>
                {ic.shortCall}
              </td>
              <td className={`${mkTd()} text-success font-semibold opacity-65`}>
                {ic.shortCallSpy}
              </td>
              <td className={`${mkTd()} text-success`}>{ic.longCall}</td>
              <td className={`${mkTd()} text-success opacity-65`}>
                {ic.longCallSpy}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
