import { theme } from '../../themes';
import { FINE_VIX_STATS } from '../../data/vixRangeStats';
import { mkTh, mkTd, tint } from '../../utils/ui-utils';
import { ScrollHint } from '../ui';

interface Props {
  vix: number | null;
  spot: number | null;
}

export default function FineGrainedBars({ vix, spot }: Props) {
  const activeVix = vix == null ? -1 : Math.floor(vix);
  const maxP90 = Math.max(...FINE_VIX_STATS.map((s) => s.p90HL));

  return (
    <ScrollHint>
      <section
        className="border-edge rounded-[10px] border"
        aria-label="Fine-grained VIX bars"
      >
        <table
          className="w-full border-collapse font-mono text-[12px]"
          role="table"
          aria-label="Fine-grained VIX range breakdown"
        >
          <thead>
            <tr className="bg-table-header">
              <th className={`${mkTh('center')} w-12`}>VIX</th>
              <th className={`${mkTh('right')} w-12.5`}>Days</th>
              <th className={mkTh('left')}>Median H-L Range</th>
              <th className={`${mkTh('right')} w-15`}>90th</th>
              <th className={`${mkTh('right')} w-12.5`}>{'>'}2%</th>
            </tr>
          </thead>
          <tbody>
            {FINE_VIX_STATS.map((s, i) => {
              const isActive = s.vix === activeVix;
              const barWidth = (s.medHL / maxP90) * 100;
              const p90BarWidth = (s.p90HL / maxP90) * 100;
              const barColor =
                s.vix < 18
                  ? theme.accent
                  : s.vix < 25
                    ? theme.caution
                    : theme.red;
              return (
                <tr
                  key={s.vix}
                  className={
                    isActive
                      ? 'border-l-[3px]'
                      : `border-l-[3px] border-transparent ${i % 2 === 1 ? 'bg-table-alt' : 'bg-surface'}`
                  }
                  style={
                    isActive
                      ? {
                          backgroundColor: tint(barColor, '10'),
                          borderLeftColor: barColor,
                        }
                      : undefined
                  }
                >
                  <td
                    className={`${mkTd()} text-center`}
                    style={{
                      fontWeight: isActive ? 700 : 500,
                      color: isActive ? barColor : theme.text,
                    }}
                  >
                    {s.vix}
                  </td>
                  <td className={`${mkTd()} text-muted text-right text-[11px]`}>
                    {s.count}
                  </td>
                  <td className={`${mkTd()} px-3 py-2`}>
                    <div className="flex items-center gap-2">
                      <div className="bg-surface-alt relative h-4 flex-1 overflow-hidden rounded">
                        {/* 90th percentile ghost bar */}
                        <div
                          className="absolute inset-y-0 left-0 rounded"
                          style={{
                            width: p90BarWidth + '%',
                            backgroundColor: tint(barColor, '15'),
                          }}
                        />
                        {/* Median bar */}
                        <div
                          className="absolute top-0.5 left-0 h-3 rounded-[3px] transition-[width] duration-200"
                          style={{
                            width: barWidth + '%',
                            backgroundColor: barColor,
                          }}
                        />
                      </div>
                      <span className="text-primary min-w-10.5 text-right text-[12px] font-semibold">
                        {s.medHL.toFixed(2)}%
                      </span>
                    </div>
                    {spot != null && (
                      <div className="text-muted mt-0.5 text-[10px]">
                        {'\u2248'}
                        {Math.round((s.medHL / 100) * spot)} pts median,{' '}
                        {Math.round((s.p90HL / 100) * spot)} pts 90th
                      </div>
                    )}
                  </td>
                  <td
                    className={`${mkTd()} text-danger text-right text-[11px]`}
                  >
                    {s.p90HL.toFixed(2)}%
                  </td>
                  <td
                    className={`${mkTd()} text-right text-[11px]`}
                    style={{
                      color: s.over2 > 15 ? theme.red : theme.textSecondary,
                      fontWeight: s.over2 > 15 ? 600 : 400,
                    }}
                  >
                    {s.over2}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </ScrollHint>
  );
}
