import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';

interface Thresholds {
  p50: number;
  p75: number;
  p90: number;
}

interface Props {
  thresholds: Thresholds;
  yestRangePct: number;
  signalColor: string;
}

export default function PercentileBar({
  thresholds,
  yestRangePct,
  signalColor,
}: Props) {
  const maxRange = thresholds.p90 * 1.5;
  const pos = Math.min(yestRangePct / maxRange, 1) * 100;

  return (
    <div className="bg-surface border-edge rounded-[10px] border p-3 sm:px-4 sm:py-3">
      <div className="text-tertiary mb-2 font-sans text-[10px] font-bold tracking-[0.06em] uppercase">
        Yesterday{'\u2019'}s range vs. regime percentiles
      </div>

      <div className="bg-surface-alt relative mb-5 h-3 overflow-visible rounded-md">
        {/* Colored segments */}
        <div
          className="absolute top-0 left-0 h-full w-1/2 rounded-l-md"
          style={{ backgroundColor: tint(theme.green, '30') }}
        />
        <div
          className="absolute top-0 left-1/2 h-full w-1/4"
          style={{ backgroundColor: tint(theme.accent, '20') }}
        />
        <div
          className="absolute top-0 left-3/4 h-full w-[15%]"
          style={{ backgroundColor: tint(theme.caution, '30') }}
        />
        <div
          className="absolute top-0 left-[90%] h-full w-[10%] rounded-r-md"
          style={{ backgroundColor: tint(theme.red, '30') }}
        />

        {/* Yesterday's position marker */}
        <div
          className="absolute -top-1 h-5 w-1 -translate-x-1/2 rounded-sm"
          style={{
            left: pos + '%',
            backgroundColor: signalColor,
            boxShadow: '0 0 6px ' + tint(signalColor, '88'),
          }}
        />

        {/* Threshold labels */}
        <div
          className="text-muted absolute top-4 -translate-x-1/2 font-mono text-[8px]"
          style={{
            left: (thresholds.p50 / maxRange) * 100 + '%',
          }}
        >
          p50 ({thresholds.p50.toFixed(2)}%)
        </div>
        <div
          className="text-muted absolute top-4 -translate-x-1/2 font-mono text-[8px]"
          style={{
            left: (thresholds.p75 / maxRange) * 100 + '%',
          }}
        >
          p75 ({thresholds.p75.toFixed(2)}%)
        </div>
        <div
          className="text-muted absolute top-4 -translate-x-1/2 font-mono text-[8px]"
          style={{
            left: (thresholds.p90 / maxRange) * 100 + '%',
          }}
        >
          p90 ({thresholds.p90.toFixed(2)}%)
        </div>
      </div>
    </div>
  );
}
