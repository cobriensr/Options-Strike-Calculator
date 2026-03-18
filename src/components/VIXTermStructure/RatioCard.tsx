import type { Theme } from '../../themes';
import { tint } from '../../utils/ui-utils';

interface Props {
  th: Theme;
  title: string;
  subtitle: string;
  ratio: number;
  label: string;
  color: string;
  advice: string;
}

export default function RatioCard({
  th,
  title,
  subtitle,
  ratio,
  label,
  color,
  advice,
}: Props) {
  return (
    <div className="bg-surface border-edge rounded-[10px] border p-3 sm:p-3.5">
      <div className="mb-2 flex items-start justify-between">
        <div>
          <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
            {title}
          </div>
          <div className="text-muted font-sans text-[10px]">{subtitle}</div>
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
        {ratio.toFixed(2)}x
      </div>

      {/* Ratio bar visualization */}
      <div className="mb-2">
        <div className="bg-surface-alt relative h-1.5 overflow-hidden rounded-[3px]">
          <div
            className="absolute top-0 left-0 h-full rounded-[3px] transition-[width] duration-300"
            style={{
              width: Math.min(ratio / 2, 1) * 100 + '%',
              backgroundColor: color,
            }}
          />
          {/* 1.0x marker */}
          <div
            className="absolute -top-px left-1/2 h-2 w-0.5"
            style={{ backgroundColor: tint(th.textMuted, '60') }}
          />
        </div>
        <div className="text-muted mt-0.5 flex justify-between font-mono text-[8px]">
          <span>0.5x</span>
          <span>1.0x</span>
          <span>1.5x</span>
          <span>2.0x</span>
        </div>
      </div>

      <div className="text-secondary font-sans text-[11px] leading-normal">
        {advice}
      </div>
    </div>
  );
}
