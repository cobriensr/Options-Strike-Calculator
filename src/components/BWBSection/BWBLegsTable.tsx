import type { BWBLegs } from '../../types';
import { mkTh, mkTd } from '../../utils/ui-utils';
import { ScrollHint } from '../ui';

interface Props {
  putRows: BWBLegs[];
  callRows: BWBLegs[];
}

export default function BWBLegsTable({ putRows, callRows }: Readonly<Props>) {
  return (
    <ScrollHint>
      <section
        className="border-edge rounded-[10px] border"
        aria-label="BWB legs"
      >
        <table
          className="w-full border-collapse font-mono text-[13px]"
          role="table"
          aria-label="BWB legs by delta"
        >
          <thead>
            <tr className="bg-table-header">
              <th scope="col" className={mkTh('center')}>
                Delta
              </th>
              <th scope="col" className={mkTh('left')}>
                Side
              </th>
              <th scope="col" className={mkTh('left')}>
                Long Far
              </th>
              <th scope="col" className={mkTh('left')}>
                SPY
              </th>
              <th scope="col" className={mkTh('left')}>
                Short {'\u00D7'}2
              </th>
              <th scope="col" className={mkTh('left')}>
                SPY
              </th>
              <th scope="col" className={mkTh('left')}>
                Long Near
              </th>
              <th scope="col" className={mkTh('left')}>
                SPY
              </th>
            </tr>
          </thead>
          <tbody>
            {putRows.map((put, i) => {
              const call = callRows[i];
              const groupBg = i % 2 === 1 ? 'bg-table-alt' : 'bg-surface';
              const borderStyle = '2px solid var(--color-edge)';

              return [
                <tr
                  key={put.delta + '-put'}
                  className={groupBg}
                  style={{ borderBottom: undefined }}
                >
                  <td
                    rowSpan={2}
                    className={`${mkTd()} text-accent text-center align-middle font-bold`}
                    style={{ borderBottom: borderStyle }}
                  >
                    {put.delta}
                    {'\u0394'}
                  </td>
                  <td className={`${mkTd()} text-danger font-medium`}>
                    {'\u25BE'} Put BWB
                  </td>
                  <td className={`${mkTd()} text-danger`}>
                    {put.longFarStrike}
                  </td>
                  <td className={`${mkTd()} text-danger opacity-65`}>
                    {put.longFarStrikeSpy}
                  </td>
                  <td className={`${mkTd()} text-danger font-semibold`}>
                    {put.shortStrike}
                  </td>
                  <td
                    className={`${mkTd()} text-danger font-semibold opacity-65`}
                  >
                    {put.shortStrikeSpy}
                  </td>
                  <td className={`${mkTd()} text-danger`}>
                    {put.longNearStrike}
                  </td>
                  <td className={`${mkTd()} text-danger opacity-65`}>
                    {put.longNearStrikeSpy}
                  </td>
                </tr>,
                call && (
                  <tr
                    key={call.delta + '-call'}
                    className={groupBg}
                    style={{ borderBottom: borderStyle }}
                  >
                    <td className={`${mkTd()} text-success font-medium`}>
                      {'\u25B4'} Call BWB
                    </td>
                    <td className={`${mkTd()} text-success`}>
                      {call.longNearStrike}
                    </td>
                    <td className={`${mkTd()} text-success opacity-65`}>
                      {call.longNearStrikeSpy}
                    </td>
                    <td className={`${mkTd()} text-success font-semibold`}>
                      {call.shortStrike}
                    </td>
                    <td
                      className={`${mkTd()} text-success font-semibold opacity-65`}
                    >
                      {call.shortStrikeSpy}
                    </td>
                    <td className={`${mkTd()} text-success`}>
                      {call.longFarStrike}
                    </td>
                    <td className={`${mkTd()} text-success opacity-65`}>
                      {call.longFarStrikeSpy}
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </section>
    </ScrollHint>
  );
}
