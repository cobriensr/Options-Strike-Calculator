/**
 * Constants and presentation metadata for the GexLandscape module.
 * Tailwind class names, labels, tooltips, and numeric thresholds live here.
 */

import { classSignal } from '../../utils/gex-classification';
import type { BiasMetrics, Direction, GexClassification } from './types';

/** Max points from spot to include in the table (≈20 strikes at 5-pt intervals). */
export const PRICE_WINDOW = 50;

/**
 * Points from spot within which a strike is considered "at money".
 * Sized for SPX's 5pt strike grid → 25pt band ≈ ±5 strikes. Phase 3 of
 * the MM swap (docs/superpowers/specs/gex-landscape-mm-swap-2026-05-12.md)
 * narrowed this panel to SPX-only; multi-ticker support and the
 * `BAND_BY_TICKER` lookup were removed because the MM data source
 * (periscope_snapshots) only captures SPX 0DTE.
 */
export const SPX_SPOT_BAND = 25;

// `DRIFT_PTS_THRESHOLD` and `DRIFT_CONSISTENCY_THRESHOLD` were moved to
// `src/utils/price-trend.ts` so the server-side regime cron can import
// the same constants without pulling in the whole GexLandscape module.
// Re-exported here for backward compatibility with any consumers that
// still read them from this location.
export {
  DRIFT_PTS_THRESHOLD,
  DRIFT_CONSISTENCY_THRESHOLD,
} from '../../utils/price-trend';

export interface ClassMeta {
  badge: string;
  badgeBg: string;
  badgeText: string;
  rowBg: string;
  signal: (dir: Direction) => string;
}

/**
 * Gamma-sign palette: two non-evaluative hues, sky = taker-long γ and
 * violet = taker-short γ, applied the same way above and below spot. On
 * GEXBot taker flow only the sign is known, so colour carries the sign and
 * nothing else; the UW-era green = safe / amber, red = danger reading is
 * gone (owner decision D1 revised, 2026-10-29).
 */
export const GAMMA_SIGN_CLASSES = {
  long: {
    color: 'text-sky-400',
    bg: 'bg-sky-500/15',
    border: 'border-sky-500/30',
  },
  short: {
    color: 'text-violet-400',
    bg: 'bg-violet-500/15',
    border: 'border-violet-500/30',
  },
} as const;

/** Hex forms of the two hues, for inline `style` colours. */
export const GAMMA_SIGN_HEX = { long: '#38bdf8', short: '#a78bfa' } as const;

/** Hue for a gamma value (zero counts as long, as in `classify`). */
export function gammaSignHex(value: number): string {
  return value >= 0 ? GAMMA_SIGN_HEX.long : GAMMA_SIGN_HEX.short;
}

/**
 * Hue for a Δ% trend cell, above or below spot alike. Δ% is
 * (current − prior) / |prior|, so a positive change moved the value toward
 * taker-long (sky) and a negative one toward taker-short (violet).
 */
export function trendColor(value: number | null): string {
  if (value === null) return 'var(--color-muted)';
  return gammaSignHex(value);
}

/**
 * Class badges and row tints: the hue is the gamma sign; a positive charm
 * gets the stronger tint, the same way for both signs.
 */
export const CLASS_META: Record<GexClassification, ClassMeta> = {
  'max-launchpad': {
    badge: 'Takers −γ +charm',
    badgeBg: 'bg-violet-500/25',
    badgeText: 'text-violet-400',
    rowBg: 'bg-violet-500/5',
    signal: (dir) => classSignal('max-launchpad', dir),
  },
  'fading-launchpad': {
    badge: 'Takers −γ −charm',
    badgeBg: 'bg-violet-500/10',
    badgeText: 'text-violet-300',
    rowBg: '',
    signal: (dir) => classSignal('fading-launchpad', dir),
  },
  'sticky-pin': {
    badge: 'Takers +γ +charm',
    badgeBg: 'bg-sky-500/25',
    badgeText: 'text-sky-400',
    rowBg: 'bg-sky-500/5',
    signal: (dir) => classSignal('sticky-pin', dir),
  },
  'weakening-pin': {
    badge: 'Takers +γ −charm',
    badgeBg: 'bg-sky-500/10',
    badgeText: 'text-sky-300',
    rowBg: '',
    signal: (dir) => classSignal('weakening-pin', dir),
  },
};

/**
 * Per-class tooltip. GEXBot values are classified taker flow in the
 * vendor's taker-side sign (owner decision D1 revised, 2026-10-29), so each
 * tooltip states which side traders hold and makes no market-maker claim.
 * The class ids keep their UW-era names; only the display text changed.
 */
export const CLS_TOOLTIP: Record<GexClassification, string> = {
  'max-launchpad':
    "In GEXBot's taker-side sign, traders (takers) are net short gamma and net long charm at this strike.",
  'fading-launchpad':
    "In GEXBot's taker-side sign, traders (takers) are net short gamma and net short charm at this strike.",
  'sticky-pin':
    "In GEXBot's taker-side sign, traders (takers) are net long gamma and net long charm at this strike.",
  'weakening-pin':
    "In GEXBot's taker-side sign, traders (takers) are net long gamma and net short charm at this strike.",
};

export interface VerdictMeta {
  label: string;
  color: string;
  bg: string;
  border: string;
  desc: string;
}

/**
 * Verdict display text. `computeBias` still classifies by where the
 * largest-|γ| strike sits (above / below / within 25 pts of spot) and the
 * sign of the window's net gamma, plus the 30-min price-drift override.
 * ▲ / ▼ mark where the strike sits; ↑ / ↓ are kept for price moves. On
 * GEXBot taker flow the labels say exactly that and nothing more: the
 * UW-era readings ("MMs will pull price toward it", "dealers amplify
 * moves") do not apply (owner decision D1 revised, 2026-10-29). Verdict ids
 * keep their old names.
 */
const LONG_DESC = 'net taker gamma is positive (traders net long gamma)';
const SHORT_DESC = 'net taker gamma is negative (traders net short gamma)';
const ABOVE = 'Largest |γ| strike is more than 25 pts above spot';
const BELOW = 'Largest |γ| strike is more than 25 pts below spot';
const AT_SPOT = 'Largest |γ| strike is within 25 pts of spot';

export const VERDICT_META: Record<BiasMetrics['verdict'], VerdictMeta> = {
  'gex-pull-up': {
    label: '▲ TOP ABOVE · LONG γ',
    ...GAMMA_SIGN_CLASSES.long,
    desc: `${ABOVE}; ${LONG_DESC}`,
  },
  'gex-pull-down': {
    label: '▼ TOP BELOW · LONG γ',
    ...GAMMA_SIGN_CLASSES.long,
    desc: `${BELOW}; ${LONG_DESC}`,
  },
  'breakout-risk-up': {
    label: '▲ TOP ABOVE · SHORT γ',
    ...GAMMA_SIGN_CLASSES.short,
    desc: `${ABOVE}; ${SHORT_DESC}`,
  },
  'breakdown-risk-down': {
    label: '▼ TOP BELOW · SHORT γ',
    ...GAMMA_SIGN_CLASSES.short,
    desc: `${BELOW}; ${SHORT_DESC}`,
  },
  rangebound: {
    label: '● TOP AT SPOT · LONG γ',
    ...GAMMA_SIGN_CLASSES.long,
    desc: `${AT_SPOT}; ${LONG_DESC}`,
  },
  volatile: {
    label: '● TOP AT SPOT · SHORT γ',
    ...GAMMA_SIGN_CLASSES.short,
    desc: `${AT_SPOT}; ${SHORT_DESC}`,
  },
  'gex-floor-below': {
    label: '▼ TOP BELOW · LONG γ',
    ...GAMMA_SIGN_CLASSES.long,
    desc: `${BELOW}; ${LONG_DESC}`,
  },
  'drifting-down': {
    label: '↓ DRIFTING DOWN',
    color: 'text-orange-400',
    bg: 'bg-orange-500/15',
    border: 'border-orange-500/30',
    desc: `${AT_SPOT} and ${LONG_DESC}, but price has drifted lower over 30m`,
  },
  'drifting-up': {
    label: '↑ DRIFTING UP',
    color: 'text-teal-400',
    bg: 'bg-teal-500/15',
    border: 'border-teal-500/30',
    desc: `${AT_SPOT} and ${LONG_DESC}, but price has drifted higher over 30m`,
  },
};

/** Shared tail for every verdict tooltip: what the numbers are. */
const VERDICT_TOOLTIP_TAIL =
  'Computed from GEXBot gamma in its taker-side sign over the strikes within ±50 pts of spot. It describes taker positioning; it is not a forecast of where price goes.';

/** The largest-|γ| strike's position, in tooltip wording. */
const TOP_ABOVE =
  'The strike with the largest absolute gamma sits more than 25 pts above spot';
const TOP_BELOW =
  'The strike with the largest absolute gamma sits more than 25 pts below spot';
const TOP_AT_SPOT =
  'The strike with the largest absolute gamma sits within 25 pts of spot';

export const VERDICT_TOOLTIP: Record<BiasMetrics['verdict'], string> = {
  'gex-pull-up': `${TOP_ABOVE}, and ${LONG_DESC}. ${VERDICT_TOOLTIP_TAIL}`,
  'gex-pull-down': `${TOP_BELOW}, and ${LONG_DESC}. ${VERDICT_TOOLTIP_TAIL}`,
  'breakout-risk-up': `${TOP_ABOVE}, and ${SHORT_DESC}. ${VERDICT_TOOLTIP_TAIL}`,
  'breakdown-risk-down': `${TOP_BELOW}, and ${SHORT_DESC}. ${VERDICT_TOOLTIP_TAIL}`,
  rangebound: `${TOP_AT_SPOT}, and ${LONG_DESC}. ${VERDICT_TOOLTIP_TAIL}`,
  volatile: `${TOP_AT_SPOT}, and ${SHORT_DESC}. ${VERDICT_TOOLTIP_TAIL}`,
  'gex-floor-below': `${TOP_BELOW}, and ${LONG_DESC}. ${VERDICT_TOOLTIP_TAIL}`,
  'drifting-down': `${TOP_AT_SPOT}, and ${LONG_DESC}, but price has moved lower consistently over the last 30 minutes. ${VERDICT_TOOLTIP_TAIL}`,
  'drifting-up': `${TOP_AT_SPOT}, and ${LONG_DESC}, but price has moved higher consistently over the last 30 minutes. ${VERDICT_TOOLTIP_TAIL}`,
};
