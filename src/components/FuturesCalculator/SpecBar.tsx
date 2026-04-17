/**
 * Compact contract-spec ribbon: label, point value, tick value, fees/side,
 * and day margin — rendered in the calculator body.
 */

import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import type { ContractSpec } from './futures-calc';

interface Props {
  spec: ContractSpec;
  feePerSide: number;
}

export function SpecBar({ spec, feePerSide }: Readonly<Props>) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg px-3 py-2 font-sans text-[10px]"
      style={{
        backgroundColor: tint(theme.accent, '10'),
        color: theme.textMuted,
      }}
    >
      <span className="font-bold" style={{ color: theme.accent }}>
        {spec.label} · {spec.name}
      </span>
      <span>
        <span className="font-semibold" style={{ color: theme.text }}>
          ${spec.pointValue}
        </span>{' '}
        / pt
      </span>
      <span>
        <span className="font-semibold" style={{ color: theme.text }}>
          ${spec.tickValue}
        </span>{' '}
        / tick
      </span>
      <span>
        Fees{' '}
        <span className="font-semibold" style={{ color: theme.text }}>
          ${feePerSide.toFixed(2)}
        </span>{' '}
        / side
      </span>
      <span>
        Day margin{' '}
        <span className="font-semibold" style={{ color: theme.text }}>
          ${spec.dayMargin.toLocaleString()}
        </span>{' '}
        / contract
      </span>
    </div>
  );
}
