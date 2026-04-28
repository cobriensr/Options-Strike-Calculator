/**
 * EsLevelsPanel — Panel 3 of the FuturesGammaPlaybook widget.
 *
 * Renders the SPX-derived walls / zero-gamma mapped onto ES as a compact
 * table: a kind badge, the SPX strike, the ES price, the signed distance
 * in both points and ticks, and a status badge (APPROACHING / REJECTED /
 * BROKEN / IDLE). Left-border color mirrors the weight convention from
 * `GexLandscape/StrikeTable.tsx` — sky for zero-gamma, green for call
 * wall, red for put wall, neutral for max-pain.
 *
 * Pure presentational — the hook does all the level math. Memoized so
 * re-renders only fire on a level field change, not on every parent tick.
 */

import { memo } from 'react';
import type { EsLevel } from '../../utils/futures-gamma/types';
import { ES_TICK_SIZE } from '../../utils/futures-gamma/playbook';
import { Tooltip } from '../ui/Tooltip';
import { TOOLTIP } from './copy/tooltips';

export interface EsLevelsPanelProps {
  levels: EsLevel[];
}

// ── Presentation metadata ────────────────────────────────────────────

const KIND_META: Record<
  EsLevel['kind'],
  { label: string; badge: string; border: string; title: string }
> = {
  CALL_WALL: {
    label: 'CALL WALL',
    badge: 'bg-emerald-500/15 text-emerald-400',
    border: 'border-l-emerald-400/60',
    title:
      'Highest positive-gamma SPX strike — structural resistance; dealer hedging dampens rallies into it.',
  },
  PUT_WALL: {
    label: 'PUT WALL',
    badge: 'bg-red-500/15 text-red-400',
    border: 'border-l-red-400/60',
    title:
      'Largest negative-gamma SPX strike — structural support; dealer hedging dampens declines into it.',
  },
  ZERO_GAMMA: {
    label: 'ZERO-GAMMA',
    badge: 'bg-sky-500/15 text-sky-400',
    border: 'border-l-sky-400/60',
    title:
      'Interpolated zero-crossing of cumulative SPX gamma — regime pivot between dampened (+GEX) and trending (−GEX).',
  },
  MAX_PAIN: {
    label: 'MAX PAIN',
    badge: 'bg-white/10 text-muted',
    border: 'border-l-white/30',
    title:
      'Strike that minimizes total option-buyer payoff — classic pin target in charm-drift windows.',
  },
};

const STATUS_META: Record<
  EsLevel['status'],
  { label: string; className: string; title: string }
> = {
  APPROACHING: {
    label: 'APPROACHING',
    className: 'bg-amber-500/20 text-amber-300',
    title: 'Price is within the proximity band of this level right now.',
  },
  REJECTED: {
    label: 'REJECTED',
    className: 'bg-emerald-500/20 text-emerald-300',
    title:
      'Price touched the proximity band recently and has pulled away — the level held.',
  },
  BROKEN: {
    label: 'BROKEN',
    className: 'bg-red-500/20 text-red-300',
    title:
      'Price crossed through the level in the last few snapshots — direction flipped.',
  },
  IDLE: {
    label: 'IDLE',
    className: 'bg-white/10 text-muted',
    title: 'Level is too far off to matter right now.',
  },
};

// ── Helpers ───────────────────────────────────────────────────────────

function fmtSignedPts(points: number): string {
  const sign = points >= 0 ? '+' : '';
  return `${sign}${points.toFixed(2)}`;
}

function fmtSignedTicks(points: number): string {
  const ticks = Math.round(points / ES_TICK_SIZE);
  const sign = ticks >= 0 ? '+' : '';
  return `${sign}${ticks}t`;
}

// ── Component ─────────────────────────────────────────────────────────

export const EsLevelsPanel = memo(function EsLevelsPanel({
  levels,
}: EsLevelsPanelProps) {
  if (levels.length === 0) {
    return (
      <div
        className="border-edge bg-surface-alt mb-3 rounded-lg border p-4 text-center"
        aria-label="ES levels"
      >
        <div
          className="font-mono text-[12px] font-semibold tracking-wider uppercase"
          style={{ color: 'var(--color-tertiary)' }}
        >
          ES levels unavailable
        </div>
        <div
          className="mt-1 font-mono text-[11px]"
          style={{ color: 'var(--color-secondary)' }}
        >
          Awaiting basis and ES price data.
        </div>
      </div>
    );
  }

  return (
    <div
      className="border-edge bg-surface-alt mb-3 rounded-lg border"
      aria-label="ES levels"
    >
      {/* Header row */}
      <div
        className="border-edge grid grid-cols-[110px_80px_1fr_130px_110px] items-center gap-2 border-b px-3 py-1.5 font-mono text-[9px] font-semibold tracking-wider uppercase"
        style={{ color: 'var(--color-tertiary)' }}
      >
        <span>Kind</span>
        <span className="text-right">SPX</span>
        <span className="text-right">ES</span>
        <Tooltip content={TOOLTIP.numeric.distance} side="bottom">
          <span className="w-full cursor-help text-right">Distance</span>
        </Tooltip>
        <span className="text-center">Status</span>
      </div>

      {/* Level rows */}
      <ul className="divide-edge divide-y">
        {levels.map((level) => {
          const km = KIND_META[level.kind];
          const sm = STATUS_META[level.status];
          return (
            <li
              key={level.kind}
              className={`grid grid-cols-[110px_80px_1fr_130px_110px] items-center gap-2 border-l-2 px-3 py-2 ${km.border}`}
            >
              {/* Kind badge */}
              <Tooltip content={TOOLTIP.levelKind[level.kind]} side="top">
                <span
                  className={`inline-flex cursor-help items-center justify-center rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${km.badge}`}
                >
                  {km.label}
                </span>
              </Tooltip>

              {/* SPX strike (muted, small) */}
              <span
                className="text-right font-mono text-[11px] tabular-nums"
                style={{ color: 'var(--color-secondary)' }}
                aria-label={`SPX strike ${level.spxStrike}`}
              >
                {level.spxStrike.toLocaleString()}
              </span>

              {/* ES price (large, monospace) with → prefix */}
              <span
                className="flex items-center justify-end gap-1 text-right font-mono text-[14px] font-semibold tabular-nums"
                style={{ color: 'var(--color-primary)' }}
              >
                <span
                  aria-hidden="true"
                  style={{ color: 'var(--color-tertiary)' }}
                >
                  →
                </span>
                <span aria-label={`ES price ${level.esPrice.toFixed(2)}`}>
                  {level.esPrice.toFixed(2)}
                </span>
              </span>

              {/* Signed distance: points + ticks */}
              <Tooltip content={TOOLTIP.numeric.distance} side="top">
                <span
                  className="w-full cursor-help text-right font-mono text-[11px] tabular-nums"
                  style={{ color: 'var(--color-secondary)' }}
                >
                  {fmtSignedPts(level.distanceEsPoints)}{' '}
                  <span style={{ color: 'var(--color-tertiary)' }}>
                    / {fmtSignedTicks(level.distanceEsPoints)}
                  </span>
                </span>
              </Tooltip>

              {/* Status badge */}
              <span className="flex items-center justify-center">
                <Tooltip content={TOOLTIP.levelStatus[level.status]} side="top">
                  <span
                    className={`cursor-help rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${sm.className}`}
                  >
                    {sm.label}
                  </span>
                </Tooltip>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
});

export default EsLevelsPanel;
