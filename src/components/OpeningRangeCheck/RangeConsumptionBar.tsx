import type { Theme } from '../../themes';
import { tint } from '../../utils/ui-utils';

interface Props {
  th: Theme;
  pctOfMedianUsed: number;
  pctOfP90Used: number;
  signalColor: string;
}

export default function RangeConsumptionBar({
  th,
  pctOfMedianUsed,
  pctOfP90Used,
  signalColor,
}: Props) {
  return (
    <div className="bg-surface border-edge rounded-[10px] border px-4 py-3.5">
      <div className="text-tertiary mb-2 font-sans text-[10px] font-bold tracking-[0.06em] uppercase">
        Range consumed vs. expected daily range
      </div>

      {/* Median bar */}
      <div className="mb-2.5">
        <div className="mb-1 flex items-center justify-between font-mono text-[11px]">
          <span className="text-secondary">vs. Median H-L</span>
          <span className="font-bold" style={{ color: signalColor }}>
            {(pctOfMedianUsed * 100).toFixed(0)}% consumed
          </span>
        </div>
        <div className="bg-surface-alt relative h-2.5 overflow-hidden rounded-[5px]">
          <div
            className="absolute top-0 left-0 h-full rounded-[5px] transition-[width] duration-300"
            style={{
              width: (Math.min(pctOfMedianUsed, 1.5) / 1.5) * 100 + '%',
              backgroundColor: signalColor,
            }}
          />
          {/* 100% marker */}
          <div
            className="absolute -top-0.5 h-3.5 w-0.5"
            style={{
              left: (1 / 1.5) * 100 + '%',
              backgroundColor: tint(th.text, '40'),
            }}
          />
        </div>
        <div className="text-muted mt-0.5 flex justify-between font-mono text-[8px]">
          <span>0%</span>
          <span>50%</span>
          <span className="font-semibold">100%</span>
          <span>150%</span>
        </div>
      </div>

      {/* P90 bar */}
      <div>
        <div className="mb-1 flex items-center justify-between font-mono text-[11px]">
          <span className="text-secondary">vs. 90th Pctile H-L</span>
          <span className="text-secondary font-bold">
            {(pctOfP90Used * 100).toFixed(0)}% consumed
          </span>
        </div>
        <div className="bg-surface-alt relative h-2.5 overflow-hidden rounded-[5px]">
          <div
            className="absolute top-0 left-0 h-full rounded-[5px] transition-[width] duration-300"
            style={{
              width: (Math.min(pctOfP90Used, 1.5) / 1.5) * 100 + '%',
              backgroundColor: tint(th.accent, '80'),
            }}
          />
          <div
            className="absolute -top-0.5 h-3.5 w-0.5"
            style={{
              left: (1 / 1.5) * 100 + '%',
              backgroundColor: tint(th.text, '40'),
            }}
          />
        </div>
        <div className="text-muted mt-0.5 flex justify-between font-mono text-[8px]">
          <span>0%</span>
          <span>50%</span>
          <span className="font-semibold">100%</span>
          <span>150%</span>
        </div>
      </div>
    </div>
  );
}
