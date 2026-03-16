import type { Theme } from '../themes';

interface Props {
  th: Theme;
  ratio: number;
  label: string; // 'IV Rich' | 'Fair Value' | 'IV Cheap'
  rvAnnualized: number;
  iv: number; // annualized IV used (decimal)
}

export default function RvIvCard({
  th,
  ratio,
  label,
  rvAnnualized,
  iv,
}: Props) {
  const color =
    label === 'IV Rich' ? th.green : label === 'IV Cheap' ? th.red : th.accent;

  const advice =
    label === 'IV Rich'
      ? 'IV exceeds recent realized vol — premium selling is favorable. You are being paid more than the market has been delivering.'
      : label === 'IV Cheap'
        ? "Realized vol exceeds IV — the market moved more yesterday than today's IV implies. Widen strikes or reduce size."
        : 'IV and realized vol are roughly aligned — standard conditions, follow your delta guide.';

  return (
    <div className="bg-surface border-edge rounded-[10px] border p-3 sm:p-3.5">
      <div className="mb-2 flex items-start justify-between">
        <div>
          <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
            RV / IV Ratio
          </div>
          <div className="text-muted font-sans text-[9px]">
            Yesterday&apos;s realized vol vs today&apos;s implied
          </div>
        </div>
        <span
          className="rounded-full px-2 py-0.5 font-sans text-[9px] font-bold tracking-[0.06em] uppercase"
          style={{ backgroundColor: color + '18', color }}
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

      {/* Ratio bar: 0.5x to 2.0x range, 1.0x is center */}
      <div className="mb-2">
        <div className="bg-surface-alt relative h-1.5 overflow-hidden rounded-[3px]">
          <div
            className="absolute top-0 left-0 h-full rounded-[3px] transition-[width] duration-300"
            style={{
              width: Math.min(ratio / 2, 1) * 100 + '%',
              backgroundColor: color,
            }}
          />
          {/* 0.8x marker (IV Rich threshold) */}
          <div
            className="absolute -top-px h-2 w-0.5"
            style={{
              left: (0.8 / 2) * 100 + '%',
              backgroundColor: th.green + '50',
            }}
          />
          {/* 1.0x marker */}
          <div
            className="absolute -top-px left-1/2 h-2 w-0.5"
            style={{ backgroundColor: th.textMuted + '60' }}
          />
          {/* 1.2x marker (IV Cheap threshold) */}
          <div
            className="absolute -top-px h-2 w-0.5"
            style={{
              left: (1.2 / 2) * 100 + '%',
              backgroundColor: th.red + '50',
            }}
          />
        </div>
        <div className="text-muted mt-0.5 flex justify-between font-mono text-[8px]">
          <span>0.5x</span>
          <span>1.0x</span>
          <span>1.5x</span>
          <span>2.0x</span>
        </div>
      </div>

      {/* RV and IV breakdown */}
      <div className="text-muted mb-2 flex gap-4 font-mono text-[10px]">
        <span>RV: {(rvAnnualized * 100).toFixed(1)}%</span>
        <span>IV: {(iv * 100).toFixed(1)}%</span>
      </div>

      <div className="text-secondary font-sans text-[11px] leading-normal">
        {advice}
      </div>
    </div>
  );
}
