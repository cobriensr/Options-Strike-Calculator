/**
 * TradeBiasStrip — big prominent banner at the very top of the playbook.
 *
 * Collapses the six-panel synthesis (regime × rules × conviction × drift
 * × wall-flow × level status) into a single directional call:
 *   - 🟢 LONG @ <entry>   with short reason
 *   - 🔴 SHORT @ <entry>  with short reason
 *   - ⚪ NEUTRAL          with reason why no call
 *
 * Pure presentational — consumes the `TradeBias` object derived by
 * `tradeBias.ts` from the hook's state. No logic here beyond rendering.
 *
 * When the panel is scrubbed (historical view), `aria-live` drops to
 * `off` and a `BACKTEST` tag is prefixed — same pattern as
 * `ActionDirective`. A trader reviewing yesterday doesn't need a screen
 * reader announcing "GO LONG" as if it were current.
 */

import { memo } from 'react';
import type { TradeBias } from './types';

export interface TradeBiasStripProps {
  bias: TradeBias;
  /** False when viewing a scrubbed historical snapshot. Default true. */
  isLive?: boolean;
}

const DIRECTION_META: Record<
  TradeBias['direction'],
  { label: string; icon: string; containerClass: string; badgeClass: string }
> = {
  LONG: {
    label: 'LONG',
    icon: '▲',
    containerClass: 'border-emerald-500/40 bg-emerald-500/10',
    badgeClass: 'bg-emerald-500/25 text-emerald-300',
  },
  SHORT: {
    label: 'SHORT',
    icon: '▼',
    containerClass: 'border-red-500/40 bg-red-500/10',
    badgeClass: 'bg-red-500/25 text-red-300',
  },
  NEUTRAL: {
    label: 'NEUTRAL',
    icon: '·',
    containerClass: 'border-edge bg-surface-alt',
    badgeClass: 'bg-white/10 text-muted',
  },
};

const CONVICTION_META: Record<
  TradeBias['conviction'],
  { label: string; className: string } | null
> = {
  strong: {
    label: 'STRONG',
    className: 'bg-white/10 text-[color:var(--color-primary)]',
  },
  mild: {
    label: 'MILD',
    className: 'bg-white/5 text-[color:var(--color-secondary)]',
  },
  // No conviction label when NEUTRAL — the direction itself is the verdict.
  neutral: null,
};

function fmtEntry(entryEs: number | null): string {
  return entryEs === null ? '' : ` @ ${entryEs.toFixed(2)}`;
}

export const TradeBiasStrip = memo(function TradeBiasStrip({
  bias,
  isLive = true,
}: TradeBiasStripProps) {
  const dm = DIRECTION_META[bias.direction];
  const cm = CONVICTION_META[bias.conviction];

  return (
    <div
      role="status"
      aria-live={isLive ? 'polite' : 'off'}
      aria-label={
        isLive
          ? `Trade bias: ${bias.direction}`
          : `Trade bias: ${bias.direction} (backtest)`
      }
      className={`mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-2.5 ${dm.containerClass}`}
    >
      {/* Optional BACKTEST prefix for scrubbed views. */}
      {!isLive && (
        <span
          className="inline-flex items-center rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider uppercase"
          style={{ color: 'var(--color-tertiary)' }}
          aria-hidden="true"
        >
          Backtest
        </span>
      )}

      {/* Direction badge — big, high-contrast, left side. */}
      <span
        className={`inline-flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[15px] font-bold tracking-wide ${dm.badgeClass}`}
      >
        <span aria-hidden="true" className="text-[16px] leading-none">
          {dm.icon}
        </span>
        <span>{dm.label}</span>
        {bias.entryEs !== null && (
          <span
            className="ml-1 font-mono text-[13px] font-semibold tabular-nums"
            style={{ color: 'var(--color-primary)' }}
          >
            {fmtEntry(bias.entryEs)}
          </span>
        )}
      </span>

      {/* Optional conviction label. */}
      {cm !== null && (
        <span
          className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider uppercase ${cm.className}`}
        >
          {cm.label}
        </span>
      )}

      {/* Reason — secondary, smaller text. */}
      <span
        className="font-mono text-[11px]"
        style={{ color: 'var(--color-secondary)' }}
      >
        {bias.reason}
      </span>
    </div>
  );
});

export default TradeBiasStrip;
