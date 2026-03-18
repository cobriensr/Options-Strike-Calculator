import { mkTh, mkTd } from '../../utils/ui-utils';
import type { DeltaRow } from '../../types';

interface ThresholdDelta {
  readonly label: string;
  readonly pct: number;
  readonly pts: number;
  readonly putDelta: number;
  readonly callDelta: number;
  readonly purpose: string;
  readonly importance: 'primary' | 'secondary';
}

interface Props {
  readonly deltaRows: DeltaRow[];
  readonly computed: ThresholdDelta[];
  readonly guideDistances: Map<number, { putPct: string; callPct: string }>;
}

export default function DeltaThresholdsTable({
  deltaRows,
  computed,
  guideDistances,
}: Props) {
  if (deltaRows.length === 0) return null;

  return (
    <>
      <div className="text-accent mb-2.5 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
        Your Deltas vs. Regime Thresholds
      </div>

      <section
        className="border-edge overflow-x-auto rounded-[10px] border"
        aria-label="Delta thresholds"
      >
        <table
          className="w-full border-collapse font-mono text-[13px]"
          role="table"
          aria-label="Standard deltas vs VIX regime thresholds"
        >
          <thead>
            <tr className="bg-table-header">
              <th className={mkTh('center')}>Delta</th>
              <th className={mkTh('right')}>Put %</th>
              <th className={mkTh('right')}>Call %</th>
              <th className={mkTh('center')}>Med O{'\u2192'}C</th>
              <th className={mkTh('center')}>Med H-L</th>
              <th className={`${mkTh('center')} border-edge border-l-2`}>
                90th O{'\u2192'}C
              </th>
              <th className={mkTh('center')}>90th H-L</th>
            </tr>
          </thead>
          <tbody>
            {deltaRows.map((r, i) => {
              // Use guide-consistent distances (VIX × 1.15 σ) for threshold comparison
              const gd = guideDistances.get(r.delta);
              const putPct = gd
                ? Number.parseFloat(gd.putPct)
                : Number.parseFloat(r.putPct);
              const callPct = gd
                ? Number.parseFloat(gd.callPct)
                : Number.parseFloat(r.callPct);
              return (
                <tr
                  key={r.delta}
                  className={i % 2 === 1 ? 'bg-table-alt' : 'bg-surface'}
                >
                  <td className={`${mkTd()} text-accent text-center font-bold`}>
                    {r.delta}
                    {'\u0394'}
                  </td>
                  <td className={`${mkTd()} text-danger text-right`}>
                    {gd ? gd.putPct : r.putPct}%
                  </td>
                  <td className={`${mkTd()} text-success text-right`}>
                    {gd ? gd.callPct : r.callPct}%
                  </td>
                  {computed.map((c, ci) => {
                    const putClears = putPct >= c.pct;
                    const callClears = callPct >= c.pct;
                    const bothClear = putClears && callClears;
                    return (
                      <td
                        key={c.label}
                        className={`${mkTd()} text-center ${ci === 2 ? 'border-edge border-l-2' : ''}`}
                      >
                        {bothClear ? (
                          <span className="text-success text-[15px] font-bold">
                            {'\u2713'}
                          </span>
                        ) : putClears || callClears ? (
                          <span
                            className="text-[11px] font-semibold"
                            style={{ color: 'var(--color-caution)' }}
                          >
                            {putClears ? 'P\u2713' : 'C\u2713'}
                          </span>
                        ) : (
                          <span className="text-danger text-[13px] font-medium">
                            {'\u2717'}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <p className="text-muted mt-1.5 text-[11px] italic">
        {'\u2713'} = both sides clear threshold (IC safe).{' '}
        <span style={{ color: 'var(--color-caution)' }}>P{'\u2713'}</span> =
        only put side clears (put spread OK).{' '}
        <span style={{ color: 'var(--color-caution)' }}>C{'\u2713'}</span> =
        only call side clears (call spread OK). {'\u2717'} = neither side
        clears. Put/Call % use VIX {'\u00D7'} 1.15 {'\u03C3'} to match the Guide
        {'\u2019'}s thresholds.
      </p>
    </>
  );
}
