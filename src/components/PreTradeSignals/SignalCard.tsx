import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import type { SignalResult } from './classifiers';

interface Props {
  title: string;
  subtitle: string;
  result: SignalResult;
}

export default function SignalCard({ title, subtitle, result }: Props) {
  const color =
    result.signal === 'green'
      ? theme.green
      : result.signal === 'yellow'
        ? theme.caution
        : theme.red;

  return (
    <div className="bg-surface border-edge rounded-[10px] border p-3 sm:p-3.5">
      <div className="mb-1.5 flex items-start justify-between">
        <div>
          <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
            {title}
          </div>
          <div className="text-muted font-sans text-[10px]">{subtitle}</div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="font-mono text-[15px] font-extrabold"
            style={{ color }}
          >
            {result.value}
          </span>
          <span
            className="rounded-full px-2 py-0.5 font-sans text-[10px] font-bold tracking-[0.06em] uppercase"
            style={{ backgroundColor: tint(color, '18'), color }}
          >
            {result.label}
          </span>
        </div>
      </div>
      <div className="text-secondary font-sans text-[11px] leading-normal">
        {result.detail}
      </div>
    </div>
  );
}
