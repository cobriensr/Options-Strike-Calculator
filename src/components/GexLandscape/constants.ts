/**
 * Constants and presentation metadata for the GexLandscape module.
 * Tailwind class names, labels, tooltips, and numeric thresholds live here.
 */

import type { BiasMetrics, Direction, GexClassification } from './types';

/** Max points from spot to include in the table (≈20 strikes at 5-pt intervals). */
export const PRICE_WINDOW = 50;

/** Points from spot within which a strike is considered "at money". */
export const SPOT_BAND = 12;

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

export const CLASS_META: Record<GexClassification, ClassMeta> = {
  'max-launchpad': {
    badge: 'Max Launchpad',
    badgeBg: 'bg-amber-500/25',
    badgeText: 'text-amber-400',
    rowBg: 'bg-amber-500/5',
    signal: (dir) =>
      dir === 'ceiling'
        ? 'Ceiling Breakout Risk'
        : dir === 'floor'
          ? 'Floor Collapse Risk'
          : 'Launch Zone',
  },
  'fading-launchpad': {
    badge: 'Fading Launchpad',
    badgeBg: 'bg-yellow-600/20',
    badgeText: 'text-yellow-500/80',
    rowBg: 'bg-yellow-600/5',
    signal: (dir) =>
      dir === 'ceiling'
        ? 'Weakening Ceiling'
        : dir === 'floor'
          ? 'Weakening Floor'
          : 'Fading Launch',
  },
  'sticky-pin': {
    badge: 'Sticky Pin',
    badgeBg: 'bg-emerald-500/25',
    badgeText: 'text-emerald-400',
    rowBg: 'bg-emerald-500/5',
    signal: (dir) =>
      dir === 'ceiling'
        ? 'Hard Ceiling'
        : dir === 'floor'
          ? 'Hard Floor'
          : 'Pin Zone',
  },
  'weakening-pin': {
    badge: 'Weakening Pin',
    badgeBg: 'bg-emerald-500/10',
    badgeText: 'text-emerald-600',
    rowBg: '',
    signal: (dir) =>
      dir === 'ceiling'
        ? 'Softening Ceiling'
        : dir === 'floor'
          ? 'Softening Floor'
          : 'Weak Pin',
  },
};

export const CLS_TOOLTIP: Record<GexClassification, string> = {
  'max-launchpad':
    'Market makers will ADD fuel to a move here, not resist it — and that pressure grows as the day goes on. If price breaks through, expect acceleration, not a bounce.',
  'fading-launchpad':
    'Market makers will amplify moves here, but only early in the session. Their hedging pressure fades as the day wears on, so this level is most dangerous in the morning.',
  'sticky-pin':
    'Market makers are actively pushing back against any move through this level, and that resistance gets stronger as the day progresses. The most reliable wall on the board.',
  'weakening-pin':
    'Market makers are dampening moves here, but their ability to hold the line fades over time. Can act as support or resistance early in the day; less reliable into the close.',
};

export interface VerdictMeta {
  label: string;
  color: string;
  bg: string;
  border: string;
  desc: string;
}

export const VERDICT_META: Record<BiasMetrics['verdict'], VerdictMeta> = {
  'gex-pull-up': {
    label: '↑ GEX PULL',
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/15',
    border: 'border-emerald-500/30',
    desc: 'Largest GEX wall is above spot — MMs will pull price toward it',
  },
  'gex-pull-down': {
    label: '↓ GEX PULL',
    color: 'text-red-400',
    bg: 'bg-red-500/15',
    border: 'border-red-500/30',
    desc: 'Largest GEX wall is below spot — MMs will pull price toward it',
  },
  'breakout-risk-up': {
    label: '↑ BREAKOUT RISK',
    color: 'text-amber-400',
    bg: 'bg-amber-500/15',
    border: 'border-amber-500/30',
    desc: 'Neg GEX regime — dealers amplify moves; largest wall above spot may give',
  },
  'breakdown-risk-down': {
    label: '↓ BREAKDOWN RISK',
    color: 'text-orange-400',
    bg: 'bg-orange-500/15',
    border: 'border-orange-500/30',
    desc: 'Neg GEX regime — dealers amplify moves; largest wall below spot may give',
  },
  rangebound: {
    label: '● RANGE-BOUND',
    color: 'text-sky-400',
    bg: 'bg-sky-500/15',
    border: 'border-sky-500/30',
    desc: 'Positive GEX regime — dealers counter moves; price pinned near largest wall',
  },
  volatile: {
    label: '⚡ VOLATILE',
    color: 'text-amber-400',
    bg: 'bg-amber-500/15',
    border: 'border-amber-500/30',
    desc: 'Negative GEX regime — dealers amplify moves in both directions; follow breakouts',
  },
  'gex-floor-below': {
    label: '↑ FLOOR BELOW',
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/15',
    border: 'border-emerald-500/30',
    desc: 'Largest GEX wall is below spot — acting as support floor; price has upside freedom',
  },
  'drifting-down': {
    label: '↓ DRIFTING DOWN',
    color: 'text-orange-400',
    bg: 'bg-orange-500/15',
    border: 'border-orange-500/30',
    desc: 'Positive GEX but price grinding lower — dealers dampening, not stopping the move',
  },
  'drifting-up': {
    label: '↑ DRIFTING UP',
    color: 'text-teal-400',
    bg: 'bg-teal-500/15',
    border: 'border-teal-500/30',
    desc: 'Positive GEX but price grinding higher — dealers dampening, not stopping the move',
  },
};

export const VERDICT_TOOLTIP: Record<BiasMetrics['verdict'], string> = {
  'gex-pull-up':
    'The biggest GEX wall is above current price. MMs are long gamma there — as price rises toward it, they buy shares to stay hedged, which helps pull price up. Watch your upside drift targets for where price may go.',
  'gex-pull-down':
    'The biggest GEX wall is below current price. MMs are long gamma there — as price falls toward it, they sell shares to stay hedged, which helps pull price down. Watch your downside drift targets for where price may go.',
  'breakout-risk-up':
    'Total GEX is negative — MMs are short gamma and amplify moves instead of dampening them. The biggest concentration is above spot. If price breaks through that level, dealers buy more and add fuel to the rally.',
  'breakdown-risk-down':
    'Total GEX is negative — MMs are short gamma and amplify moves instead of dampening them. The biggest concentration is below spot. If price breaks through that level, dealers sell more and add fuel to the decline.',
  rangebound:
    'Total GEX is positive and the biggest wall is close to spot. MMs are countering moves from both sides — selling into rallies, buying into dips. Expect a choppy day. Fade moves toward the edges rather than chasing breakouts.',
  volatile:
    'Total GEX is negative and the biggest concentration is near spot. MMs amplify moves without a clear directional pull. A breakout in either direction can accelerate fast. Wait for a clear move before committing to a direction.',
  'gex-floor-below':
    'The biggest GEX wall is below current price and acting as a support floor — dealers are net long gamma there and will buy dips toward it. Price has already broken above it and has upside freedom toward ceiling targets. Watch for the ceiling drift targets above as the next magnetic levels.',
  'drifting-down':
    'GEX is positive (dealers are dampening moves), but price has been grinding lower despite that support. The GEX walls are slowing the decline, not stopping it. Downside drift targets show where price is heading. Consider this a warning that range-bound conditions are failing to hold.',
  'drifting-up':
    'GEX is positive (dealers are dampening moves), but price has been grinding higher despite that resistance. The GEX walls are slowing the rally, not stopping it. Upside drift targets show where price is heading. Consider this a warning that range-bound conditions are failing to hold.',
};
