/**
 * RegimeHeader — top-of-panel verdict + regime + phase + ES price strip.
 *
 * Renders five compact blocks that together answer "what are we doing right
 * now?":
 *   1. Big verdict tile (MEAN-REVERT / TREND-FOLLOW / STAND ASIDE) — colored.
 *   2. GEX regime badge (POS dampened / NEG trending / TRANSITIONING).
 *   3. Session phase badge (PRE_OPEN … POST_CLOSE, CT-based).
 *   4. ES price + ES-SPX basis in points.
 *   5. Zero-gamma distance in ES points, signed, color-coded by whether
 *      the direction is supportive of the active verdict.
 *
 * Pure presentational — all derivations are read off the hook return passed
 * in. Memoized so it only re-renders when the bias/level fields change, not
 * on every parent tick.
 */

import { memo } from 'react';
import type { UseFuturesGammaPlaybookReturn } from '../../hooks/useFuturesGammaPlaybook';
import type { GexRegime, RegimeVerdict, SessionPhase } from './types';

export interface RegimeHeaderProps {
  playbook: UseFuturesGammaPlaybookReturn;
}

// ── Static meta maps ──────────────────────────────────────────────────
//
// Kept outside the component so the objects aren't recreated on every
// render. Colors use the same theme-var palette as BiasPanel.

const VERDICT_META: Record<
  RegimeVerdict,
  { label: string; color: string; bg: string; border: string; desc: string }
> = {
  MEAN_REVERT: {
    label: 'MEAN-REVERT',
    color: 'text-sky-300',
    bg: 'bg-sky-500/10',
    border: 'border-sky-500/40',
    desc: 'Fade walls — dealer hedging dampens moves.',
  },
  TREND_FOLLOW: {
    label: 'TREND-FOLLOW',
    color: 'text-amber-300',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/40',
    desc: 'Trade breakouts — dealer hedging amplifies moves.',
  },
  STAND_ASIDE: {
    label: 'STAND ASIDE',
    color: 'text-muted',
    bg: 'bg-white/5',
    border: 'border-edge',
    desc: 'Ambiguous regime — wait for a clean signal.',
  },
};

const REGIME_META: Record<
  GexRegime,
  { label: string; color: string; title: string }
> = {
  POSITIVE: {
    label: '+GEX dampened',
    color: 'bg-sky-500/20 text-sky-400',
    title:
      'Dealers are net long gamma — they hedge against moves, tightening the intraday range.',
  },
  NEGATIVE: {
    label: '−GEX trending',
    color: 'bg-amber-500/20 text-amber-400',
    title:
      'Dealers are net short gamma — they hedge with moves, widening the range and accelerating breakouts.',
  },
  TRANSITIONING: {
    label: 'TRANSITIONING',
    color: 'bg-white/10 text-muted',
    title:
      'Spot sits inside the ±0.5% transition band around zero-gamma — no side has structural edge right now.',
  },
};

const PHASE_LABELS: Record<SessionPhase, string> = {
  PRE_OPEN: 'Pre-open',
  OPEN: 'Open',
  MORNING: 'Morning',
  LUNCH: 'Lunch',
  AFTERNOON: 'Afternoon',
  POWER: 'Power hour',
  CLOSE: 'Close',
  POST_CLOSE: 'Post-close',
};

// ── Helpers ───────────────────────────────────────────────────────────

function fmtSigned(points: number): string {
  const sign = points >= 0 ? '+' : '';
  return `${sign}${points.toFixed(2)}`;
}

/** Signed ES distance between the current price and the zero-gamma level. */
function zeroGammaDistance(
  esPrice: number | null,
  esZeroGamma: number | null,
): number | null {
  if (esPrice === null || esZeroGamma === null) return null;
  return esZeroGamma - esPrice;
}

/**
 * Color the zero-gamma distance by whether its sign is *supportive* of the
 * active verdict:
 *   - MEAN_REVERT: price below zero-gamma is a tailwind (bounces up off
 *     support). Green when distance > 0 (level above price), amber when < 0.
 *   - TREND_FOLLOW: negative regime — price below zero-gamma is a tailwind
 *     for downside trends. Green when distance < 0, amber when > 0.
 *   - STAND_ASIDE: no color; just neutral.
 */
function zeroGammaColor(
  distance: number | null,
  verdict: RegimeVerdict,
): string {
  if (distance === null || verdict === 'STAND_ASIDE') {
    return 'var(--color-muted)';
  }
  const supportive = verdict === 'MEAN_REVERT' ? distance > 0 : distance < 0;
  return supportive ? '#4ade80' : '#fbbf24';
}

// ── Component ─────────────────────────────────────────────────────────

export const RegimeHeader = memo(function RegimeHeader({
  playbook,
}: RegimeHeaderProps) {
  const { regime, verdict, phase, bias, esPrice, esSpxBasis } = playbook;

  const vm = VERDICT_META[verdict];
  const rm = REGIME_META[regime];
  const phaseLabel = PHASE_LABELS[phase];

  const zgDistance = zeroGammaDistance(esPrice, bias.esZeroGamma);
  const zgColor = zeroGammaColor(zgDistance, verdict);

  return (
    <div
      className={`mb-3 rounded-lg border p-3 ${vm.bg} ${vm.border}`}
      aria-label="Regime header"
    >
      <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-[auto_1fr_auto_auto]">
        {/* Big verdict tile */}
        <div
          className={`rounded border px-3 py-2 text-center ${vm.bg} ${vm.border}`}
          title={vm.desc}
        >
          <div
            className="mb-0.5 font-mono text-[9px] font-semibold tracking-wider uppercase"
            style={{ color: 'var(--color-tertiary)' }}
          >
            Verdict
          </div>
          <div
            className={`font-mono text-[15px] font-bold tracking-wide ${vm.color}`}
          >
            {vm.label}
          </div>
        </div>

        {/* Regime + phase badges + description */}
        <div className="flex flex-col justify-center gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`cursor-help rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${rm.color}`}
              title={rm.title}
            >
              {rm.label}
            </span>
            <span
              className="rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold"
              style={{
                background:
                  'color-mix(in srgb, var(--color-accent) 15%, transparent)',
                color: 'var(--color-accent)',
              }}
              title="Current trading session phase (CT-based)."
            >
              {phaseLabel.toUpperCase()}
            </span>
          </div>
          <span
            className="font-mono text-[11px]"
            style={{ color: 'var(--color-secondary)' }}
          >
            {vm.desc}
          </span>
        </div>

        {/* ES price + basis */}
        <div className="text-right">
          <div
            className="mb-0.5 font-mono text-[9px] font-semibold tracking-wider uppercase"
            style={{ color: 'var(--color-tertiary)' }}
          >
            ES Price
          </div>
          <div
            className="font-mono text-[15px] font-semibold tabular-nums"
            style={{ color: 'var(--color-primary)' }}
          >
            {esPrice === null ? '—' : esPrice.toFixed(2)}
          </div>
          <div
            className="font-mono text-[10px]"
            style={{ color: 'var(--color-secondary)' }}
            title="Live ES minus SPX basis at the displayed instant."
          >
            basis {esSpxBasis === null ? '—' : fmtSigned(esSpxBasis)}
          </div>
        </div>

        {/* Zero-gamma distance */}
        <div className="text-right">
          <div
            className="mb-0.5 font-mono text-[9px] font-semibold tracking-wider uppercase"
            style={{ color: 'var(--color-tertiary)' }}
          >
            ZG distance
          </div>
          <div
            className="font-mono text-[15px] font-semibold tabular-nums"
            style={{ color: zgColor }}
            title={
              zgDistance === null
                ? 'Zero-gamma unavailable (no ES basis or insufficient strikes).'
                : 'Signed ES points from current price to the zero-gamma level. Color reflects whether the direction supports the active verdict.'
            }
          >
            {zgDistance === null ? '—' : `${fmtSigned(zgDistance)} pts`}
          </div>
          <div
            className="font-mono text-[10px]"
            style={{ color: 'var(--color-secondary)' }}
          >
            {bias.esZeroGamma === null
              ? 'ZG —'
              : `ZG ${bias.esZeroGamma.toFixed(2)}`}
          </div>
        </div>
      </div>
    </div>
  );
});

export default RegimeHeader;
