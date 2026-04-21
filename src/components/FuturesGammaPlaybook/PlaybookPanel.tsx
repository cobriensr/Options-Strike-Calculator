/**
 * PlaybookPanel — regime-reactive rules cheat sheet.
 *
 * Renders the rules produced by `rulesForRegime` as a compact table: direction
 * badge | condition text | entry ES | target ES | stop ES | sizing note.
 *
 * When the rule list is empty — either because the regime is STAND_ASIDE or
 * the session is outside RTH — the panel shows a single neutral "stand aside"
 * message explaining why, so the user isn't left wondering whether the panel
 * is broken.
 *
 * Pure presentational — no hooks, no side effects.
 */

import { memo } from 'react';
import type { PlaybookRule, RegimeVerdict, SessionPhase } from './types';
import { Tooltip } from '../ui/Tooltip';
import { TOOLTIP } from './copy/tooltips';

export interface PlaybookPanelProps {
  rules: PlaybookRule[];
  verdict: RegimeVerdict;
  phase: SessionPhase;
  /** Zero-gamma unavailable is a common cause of STAND_ASIDE; show it if so. */
  esZeroGammaKnown: boolean;
}

// ── Presentation metadata ────────────────────────────────────────────

const DIRECTION_META: Record<
  PlaybookRule['direction'],
  { label: string; icon: string; className: string; title: string }
> = {
  LONG: {
    label: 'LONG',
    icon: '▲',
    className: 'bg-emerald-500/15 text-emerald-400',
    title: 'Long bias — enter from the bid side.',
  },
  SHORT: {
    label: 'SHORT',
    icon: '▼',
    className: 'bg-red-500/15 text-red-400',
    title: 'Short bias — enter from the offer side.',
  },
  EITHER: {
    label: 'EITHER',
    icon: '◆',
    className: 'bg-white/10 text-muted',
    title: 'Direction-agnostic — trade the level, not a side.',
  },
};

// ── Helpers ───────────────────────────────────────────────────────────

function fmtEs(value: number | null): string {
  return value === null ? '—' : value.toFixed(2);
}

function standAsideReason(
  verdict: RegimeVerdict,
  phase: SessionPhase,
  esZeroGammaKnown: boolean,
): string {
  if (phase === 'PRE_OPEN' || phase === 'POST_CLOSE') {
    return 'Outside RTH — SPX-derived ES levels are unreliable when cash is closed.';
  }
  if (!esZeroGammaKnown) {
    return 'Zero-gamma unavailable — waiting for a clean basis + strike ladder.';
  }
  if (verdict === 'STAND_ASIDE') {
    return 'Spot is inside the transition band around zero-gamma — no side has structural edge right now.';
  }
  return 'No active rules for the current regime and phase.';
}

// ── Component ─────────────────────────────────────────────────────────

export const PlaybookPanel = memo(function PlaybookPanel({
  rules,
  verdict,
  phase,
  esZeroGammaKnown,
}: PlaybookPanelProps) {
  if (rules.length === 0) {
    return (
      <div
        className="border-edge bg-surface-alt rounded-lg border p-4 text-center"
        aria-label="Playbook rules"
      >
        <div
          className="font-mono text-[12px] font-semibold tracking-wider uppercase"
          style={{ color: 'var(--color-tertiary)' }}
        >
          Stand aside — no setups active
        </div>
        <div
          className="mt-1 font-mono text-[11px]"
          style={{ color: 'var(--color-secondary)' }}
        >
          {standAsideReason(verdict, phase, esZeroGammaKnown)}
        </div>
      </div>
    );
  }

  return (
    <div
      className="border-edge bg-surface-alt rounded-lg border"
      aria-label="Playbook rules"
    >
      {/* Header row */}
      <div
        className="border-edge grid grid-cols-[68px_1fr_80px_80px_80px_1fr] items-center gap-2 border-b px-3 py-1.5 font-mono text-[9px] font-semibold tracking-wider uppercase"
        style={{ color: 'var(--color-tertiary)' }}
      >
        <span>Direction</span>
        <Tooltip content={TOOLTIP.playbookColumn.condition} side="bottom">
          <span className="cursor-help">Condition</span>
        </Tooltip>
        <Tooltip content={TOOLTIP.playbookColumn.entry} side="bottom">
          <span className="w-full cursor-help text-right">Entry</span>
        </Tooltip>
        <Tooltip content={TOOLTIP.playbookColumn.target} side="bottom">
          <span className="w-full cursor-help text-right">Target</span>
        </Tooltip>
        <Tooltip content={TOOLTIP.playbookColumn.stop} side="bottom">
          <span className="w-full cursor-help text-right">Stop</span>
        </Tooltip>
        <Tooltip content={TOOLTIP.playbookColumn.sizing} side="bottom">
          <span className="cursor-help">Sizing</span>
        </Tooltip>
      </div>

      {/* Rule rows */}
      <ul className="divide-edge divide-y">
        {rules.map((rule) => {
          const dm = DIRECTION_META[rule.direction];
          return (
            <li
              key={rule.id}
              className="grid grid-cols-[68px_1fr_80px_80px_80px_1fr] items-center gap-2 px-3 py-2 text-[11px]"
            >
              <Tooltip content={TOOLTIP.direction[rule.direction]} side="top">
                <span
                  className={`inline-flex cursor-help items-center justify-center gap-1 rounded px-1.5 py-0.5 font-mono font-bold ${dm.className}`}
                >
                  <span aria-hidden="true">{dm.icon}</span>
                  <span>{dm.label}</span>
                </span>
              </Tooltip>
              <span
                className="font-mono"
                style={{ color: 'var(--color-primary)' }}
              >
                {rule.condition}
              </span>
              <span
                className="text-right font-mono font-semibold tabular-nums"
                style={{ color: 'var(--color-primary)' }}
              >
                {fmtEs(rule.entryEs)}
              </span>
              <span
                className="text-right font-mono tabular-nums"
                style={{ color: 'var(--color-secondary)' }}
              >
                {fmtEs(rule.targetEs)}
              </span>
              <span
                className="text-right font-mono tabular-nums"
                style={{ color: 'var(--color-secondary)' }}
              >
                {fmtEs(rule.stopEs)}
              </span>
              <span
                className="font-mono text-[10px]"
                style={{ color: 'var(--color-secondary)' }}
              >
                {rule.sizingNote}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
});

export default PlaybookPanel;
