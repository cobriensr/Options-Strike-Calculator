import type { Theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import type { VvixResult } from './classifiers';

interface Props {
  th: Theme;
  result: VvixResult;
}

export default function VvixCard({ th, result }: Props) {
  const { value, label, color, advice } = result;

  // Bar scale: 60–140 range
  const barPct = Math.min(Math.max((value - 60) / 80, 0), 1) * 100;

  return (
    <div className="bg-surface border-edge rounded-[10px] border p-3 sm:p-3.5">
      <div className="mb-2 flex items-start justify-between">
        <div>
          <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
            VVIX
          </div>
          <div className="text-muted font-sans text-[10px]">
            Volatility of VIX
          </div>
        </div>
        <span
          className="rounded-full px-2 py-0.5 font-sans text-[10px] font-bold tracking-[0.06em] uppercase"
          style={{ backgroundColor: tint(color, '18'), color }}
        >
          {label}
        </span>
      </div>

      <div
        className="mb-1.5 font-mono text-[22px] font-extrabold"
        style={{ color }}
      >
        {value.toFixed(1)}
      </div>

      {/* VVIX bar visualization: 60–140 scale */}
      <div className="mb-2">
        <div className="bg-surface-alt relative h-1.5 overflow-hidden rounded-[3px]">
          <div
            className="absolute top-0 left-0 h-full rounded-[3px] transition-[width] duration-300"
            style={{
              width: barPct + '%',
              backgroundColor: color,
            }}
          />
          {/* 100 marker (midpoint of concern) */}
          <div
            className="absolute -top-px h-2 w-0.5"
            style={{
              left: ((100 - 60) / 80) * 100 + '%',
              backgroundColor: tint(th.textMuted, '60'),
            }}
          />
        </div>
        <div className="text-muted mt-0.5 flex justify-between font-mono text-[8px]">
          <span>60</span>
          <span>80</span>
          <span>100</span>
          <span>120</span>
          <span>140</span>
        </div>
      </div>

      <div className="text-secondary font-sans text-[11px] leading-normal">
        {advice}
      </div>
    </div>
  );
}
