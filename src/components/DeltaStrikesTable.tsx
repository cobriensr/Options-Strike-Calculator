import { theme } from '../themes';
import type { DeltaRow, DeltaRowError } from '../types';
import { mkTh, mkTd, tint } from '../utils/ui-utils';
import { ScrollHint } from './ui';

interface Props {
  allDeltas: ReadonlyArray<DeltaRow | DeltaRowError>;
  spot: number;
}

export default function DeltaStrikesTable({ allDeltas, spot }: Props) {
  // Get IV acceleration mult from first non-error row
  const firstRow = allDeltas.find((r) => !('error' in r));
  const ivAccelMult =
    firstRow && !('error' in firstRow) ? firstRow.ivAccelMult : 1;
  return (
    <>
      <ScrollHint>
        <section
          className="border-edge rounded-[10px] border"
          aria-label="Delta strikes"
        >
          <table
            className="w-full border-collapse font-mono text-[13px]"
          >
            <caption className="sr-only">
              Strike prices by delta — put strikes on the left, call
              strikes on the right.
            </caption>
            <thead>
              <tr className="bg-table-header">
                <th scope="col" className={mkTh('center')}>
                  Delta
                </th>
                <th scope="col" className={mkTh('left', 'text-danger')}>
                  {'\u25BE'} Put (SPX)
                </th>
                <th scope="col" className={mkTh('left', 'text-danger')}>
                  {'\u2192'} Snap
                </th>
                <th scope="col" className={mkTh('left', 'text-danger')}>
                  SPY
                </th>
                <th scope="col" className={mkTh('right', 'text-danger')}>
                  Put $
                </th>
                <th scope="col" className={mkTh('right', 'text-danger')}>
                  {'\u0394'}
                </th>
                <th scope="col" className={mkTh('right', 'text-danger')}>
                  {'\u0393'}
                </th>
                <th scope="col" className={mkTh('left', 'text-success')}>
                  {'\u25B4'} Call (SPX)
                </th>
                <th scope="col" className={mkTh('left', 'text-success')}>
                  {'\u2192'} Snap
                </th>
                <th scope="col" className={mkTh('left', 'text-success')}>
                  SPY
                </th>
                <th scope="col" className={mkTh('right', 'text-success')}>
                  Call $
                </th>
                <th scope="col" className={mkTh('right', 'text-success')}>
                  {'\u0394'}
                </th>
                <th scope="col" className={mkTh('right', 'text-success')}>
                  {'\u0393'}
                </th>
                <th scope="col" className={mkTh('left')}>
                  Width
                </th>
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
                    <td
                      className={`${mkTd()} text-accent text-center font-bold`}
                    >
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
                        (
                        {(((r.callStrike - r.putStrike) / spot) * 100).toFixed(
                          1,
                        )}
                        %)
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </ScrollHint>
      {ivAccelMult > 1.01 && (
        <div
          className="mt-2 flex items-center gap-2 rounded-lg px-3 py-2 font-sans text-[11px]"
          style={{
            backgroundColor: tint(
              ivAccelMult > 1.2
                ? theme.red
                : ivAccelMult > 1.08
                  ? theme.caution
                  : theme.accent,
              '10',
            ),
            border:
              '1px solid ' +
              tint(
                ivAccelMult > 1.2
                  ? theme.red
                  : ivAccelMult > 1.08
                    ? theme.caution
                    : theme.accent,
                '25',
              ),
          }}
        >
          <span
            className="font-mono text-xs font-bold"
            style={{
              color:
                ivAccelMult > 1.2
                  ? theme.red
                  : ivAccelMult > 1.08
                    ? theme.caution
                    : theme.accent,
            }}
          >
            {'\u03C3'} {'\u00D7'} {ivAccelMult.toFixed(2)}
          </span>
          <span className="text-secondary">
            IV acceleration applied — premiums and Greeks reflect intraday gamma
            acceleration at this entry time.
            {ivAccelMult > 1.2 &&
              ' Late session: premiums are significantly inflated vs. open.'}
          </span>
        </div>
      )}
    </>
  );
}
