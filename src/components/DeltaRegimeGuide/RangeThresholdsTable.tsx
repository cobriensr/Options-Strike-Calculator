import { mkTh, mkTd } from '../../utils/ui-utils';

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
  readonly computed: ThresholdDelta[];
}

export default function RangeThresholdsTable({ computed }: Props) {
  return (
    <section
      className="border-edge overflow-x-auto rounded-[10px] border"
      tabIndex={0}
      aria-label="Range thresholds"
    >
      <table
        className="w-full border-collapse font-mono text-[13px]"
        role="table"
        aria-label="VIX regime range thresholds mapped to delta"
      >
        <thead>
          <tr className="bg-table-header">
            <th className={mkTh('left')}>To Clear</th>
            <th className={mkTh('right')}>Range %</th>
            <th className={mkTh('right')}>Points</th>
            <th className={mkTh('right', 'text-danger')}>Max Put {'\u0394'}</th>
            <th className={mkTh('right', 'text-success')}>
              Max Call {'\u0394'}
            </th>
            <th className={mkTh('left')}>Survival</th>
          </tr>
        </thead>
        <tbody>
          {computed.map((c, i) => (
            <tr
              key={c.label}
              className={
                c.importance === 'primary'
                  ? 'border-l-accent bg-accent-bg border-l-[3px]'
                  : `border-l-[3px] border-transparent ${i % 2 === 1 ? 'bg-table-alt' : 'bg-surface'}`
              }
            >
              <td
                className={`${mkTd()} ${c.importance === 'primary' ? 'text-accent font-bold' : 'text-primary font-medium'}`}
              >
                {c.label}
              </td>
              <td className={`${mkTd()} text-right font-semibold`}>
                {c.pct.toFixed(2)}%
              </td>
              <td className={`${mkTd()} text-secondary text-right`}>{c.pts}</td>
              <td className={`${mkTd()} text-danger text-right font-semibold`}>
                {c.putDelta < 1 ? '<1' : c.putDelta.toFixed(1)}
                {'\u0394'}
              </td>
              <td className={`${mkTd()} text-success text-right font-semibold`}>
                {c.callDelta < 1 ? '<1' : c.callDelta.toFixed(1)}
                {'\u0394'}
              </td>
              <td className={`${mkTd()} text-muted text-[11px]`}>
                {c.purpose}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
