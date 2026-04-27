import { theme } from '../themes';
import type { DeltaRow, DeltaRowError } from '../types';
import { mkTh, mkTd, tint } from '../utils/ui-utils';
import { ScrollHint } from './ui';

interface Props {
  allDeltas: ReadonlyArray<DeltaRow | DeltaRowError>;
  spot: number;
}

export default function DeltaStrikesTable({
  allDeltas,
  spot,
}: Readonly<Props>) {
  // Get IV acceleration mult from first non-error row
  const firstRow = allDeltas.find((r) => !('error' in r));
  const ivAccelMult =
    firstRow && !('error' in firstRow) ? firstRow.ivAccelMult : 1;
  return (
    <>
      {/* Mobile (<md): card-flip layout. Each row becomes a card with
          delta as header and put/call as a 2-column grid. Snap/SPY/Γ
          are dropped on mobile — primary trade-decision data
          (strike + premium + Δ) stays. Rotate to landscape or use the
          desktop view to see the full table. */}
      <div className="space-y-2 md:hidden" aria-label="Delta strikes">
        {allDeltas.map((row, i) => {
          if ('error' in row) return null;
          const r = row;
          const width = r.callStrike - r.putStrike;
          const widthPct = ((width / spot) * 100).toFixed(1);
          return (
            <div
              key={r.delta}
              className={`border-edge rounded-lg border p-3 ${
                i % 2 === 1 ? 'bg-table-alt' : 'bg-surface'
              }`}
            >
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-accent font-mono text-base font-bold">
                  {r.delta}
                  {'Δ'}
                </span>
                <span className="text-secondary font-mono text-[11px]">
                  Width {width}{' '}
                  <span className="text-muted">({widthPct}%)</span>
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-danger mb-0.5 font-sans text-[10px] font-bold tracking-wider uppercase">
                    {'▾'} Put
                  </div>
                  <div className="text-danger font-mono text-sm font-medium">
                    {r.putStrike}
                  </div>
                  <div className="text-danger font-mono text-xs font-semibold">
                    ${r.putPremium.toFixed(2)}
                  </div>
                  <div className="text-danger font-mono text-[11px] opacity-70">
                    {(r.putActualDelta * 100).toFixed(1)}
                    {'Δ'}
                  </div>
                </div>
                <div>
                  <div className="text-success mb-0.5 font-sans text-[10px] font-bold tracking-wider uppercase">
                    {'▴'} Call
                  </div>
                  <div className="text-success font-mono text-sm font-medium">
                    {r.callStrike}
                  </div>
                  <div className="text-success font-mono text-xs font-semibold">
                    ${r.callPremium.toFixed(2)}
                  </div>
                  <div className="text-success font-mono text-[11px] opacity-70">
                    {(r.callActualDelta * 100).toFixed(1)}
                    {'Δ'}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Desktop (md+): full 14-col table. */}
      <ScrollHint className="hidden md:block">
        <section
          className="border-edge rounded-[10px] border"
          aria-label="Delta strikes"
        >
          <table className="w-full border-collapse font-mono text-[13px]">
            <caption className="sr-only">
              Strike prices by delta — put strikes on the left, call strikes on
              the right.
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
                const r = row;
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
