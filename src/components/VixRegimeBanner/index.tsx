/**
 * VIX Regime Banner — permanent gate above short-gamma structures.
 *
 * Classifies the current VIX level into Calm / Normal / Elevated / Stress
 * and renders a color-coded banner with the specific "flat by" rule.
 * Rendered above the BWB Calculator + Results Section so it's the last
 * thing the user sees before deciding to sell an iron fly or BWB.
 *
 * Evidence: ml/docs/MOC-IMBALANCE-FINDING.md
 */

import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import { classifyVix, type RegimeSeverity } from './regime';

interface Props {
  /** Current VIX reading. Accepts string (from input) or number. */
  readonly vix: string | number | null | undefined;
}

/** Color palette keyed by severity — all via theme tokens so it adapts to dark/light. */
const palette: Record<
  RegimeSeverity,
  { accent: string; bg: string; border: string }
> = {
  ok: {
    accent: theme.green,
    bg: tint(theme.green, '0C'),
    border: tint(theme.green, '40'),
  },
  note: {
    accent: theme.caution,
    bg: tint(theme.caution, '0C'),
    border: tint(theme.caution, '40'),
  },
  warn: {
    // "warn" sits between caution (yellow-ish) and red. We tint red more
    // lightly here to visually differentiate it from danger.
    accent: theme.red,
    bg: tint(theme.red, '10'),
    border: tint(theme.red, '55'),
  },
  danger: {
    accent: theme.red,
    bg: tint(theme.red, '1C'),
    border: theme.red,
  },
};

export default function VixRegimeBanner({ vix }: Readonly<Props>) {
  const num = typeof vix === 'number' ? vix : Number.parseFloat(vix ?? '');
  if (!Number.isFinite(num) || num <= 0) return null;

  const regime = classifyVix(num);
  const p = palette[regime.severity];
  const isDanger = regime.severity === 'danger';

  return (
    <div
      role="note"
      aria-label={`VIX regime: ${regime.label}. ${regime.rule}.`}
      className={`mb-3 rounded-[10px] border p-3.5 ${isDanger ? 'animate-pulse' : ''}`}
      style={{ backgroundColor: p.bg, borderColor: p.border }}
      data-testid="vix-regime-banner"
      data-regime={regime.key}
    >
      <div className="flex items-start gap-3">
        <span
          className="shrink-0 rounded px-2 py-0.5 font-sans text-[11px] font-bold tracking-[0.1em] uppercase"
          style={{ backgroundColor: p.accent, color: theme.bg }}
        >
          VIX {num.toFixed(1)} {'\u00b7'} {regime.label}
        </span>
        <div className="min-w-0 flex-1">
          <p
            className="font-sans text-[13px] leading-snug font-semibold"
            style={{ color: p.accent }}
          >
            {regime.rule}
          </p>
          <p className="text-secondary mt-0.5 font-sans text-[11px] leading-snug">
            {regime.detail}
          </p>
        </div>
      </div>
    </div>
  );
}
