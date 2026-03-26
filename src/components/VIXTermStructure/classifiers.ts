import { theme } from '../../themes';

export type Signal = 'calm' | 'normal' | 'elevated' | 'extreme';

export interface RatioResult {
  readonly ratio: number;
  readonly signal: Signal;
  readonly label: string;
  readonly color: string;
  readonly advice: string;
}

export interface VvixResult {
  readonly value: number;
  readonly signal: Signal;
  readonly label: string;
  readonly color: string;
  readonly advice: string;
}

/** Ratio thresholds for signal classification */
const VIX1D_THRESHOLDS = {
  calm: 0.85,
  normal: 1.15,
  elevated: 1.5,
} as const;

const VIX9D_THRESHOLDS = {
  calm: 0.9,
  normal: 1.1,
  elevated: 1.25,
} as const;

const VVIX_THRESHOLDS = {
  stable: 80,
  normal: 100,
  unstable: 120,
} as const;

export function classifyVix1dRatio(ratio: number): RatioResult {
  if (ratio < VIX1D_THRESHOLDS.calm) {
    return {
      ratio,
      signal: 'calm',
      label: 'CALM',
      color: theme.green,
      advice:
        'Today expected quieter than average. Full position size, standard deltas.',
    };
  }
  if (ratio < VIX1D_THRESHOLDS.normal) {
    return {
      ratio,
      signal: 'normal',
      label: 'NORMAL',
      color: theme.accent,
      advice: 'Typical day. Follow regime guide delta ceiling.',
    };
  }
  if (ratio < VIX1D_THRESHOLDS.elevated) {
    return {
      ratio,
      signal: 'elevated',
      label: 'ELEVATED',
      color: theme.caution,
      advice:
        'Market pricing above-average move today. Widen deltas or reduce size.',
    };
  }
  return {
    ratio,
    signal: 'extreme',
    label: 'EVENT RISK',
    color: theme.red,
    advice:
      'Major event expected (CPI, FOMC, NFP?). Consider sitting out or minimal size.',
  };
}

export function classifyVix9dRatio(ratio: number): RatioResult {
  if (ratio < VIX9D_THRESHOLDS.calm) {
    return {
      ratio,
      signal: 'calm',
      label: 'CONTANGO',
      color: theme.green,
      advice: 'Near-term vol below 30-day. Favorable term structure.',
    };
  }
  if (ratio < VIX9D_THRESHOLDS.normal) {
    return {
      ratio,
      signal: 'normal',
      label: 'FLAT',
      color: theme.accent,
      advice: 'Neutral term structure. No additional signal.',
    };
  }
  if (ratio < VIX9D_THRESHOLDS.elevated) {
    return {
      ratio,
      signal: 'elevated',
      label: 'INVERTED',
      color: theme.caution,
      advice: 'Near-term stress building. Caution over next 1\u20132 weeks.',
    };
  }
  return {
    ratio,
    signal: 'extreme',
    label: 'STEEP INVERSION',
    color: theme.red,
    advice: 'Significant near-term fear. Defensive posture warranted.',
  };
}

export function classifyVvix(vvix: number): VvixResult {
  if (vvix < VVIX_THRESHOLDS.stable) {
    return {
      value: vvix,
      signal: 'calm',
      label: 'STABLE',
      color: theme.green,
      advice:
        'VIX is calm and unlikely to spike. Favorable for selling premium.',
    };
  }
  if (vvix < VVIX_THRESHOLDS.normal) {
    return {
      value: vvix,
      signal: 'normal',
      label: 'NORMAL',
      color: theme.accent,
      advice: 'Standard VIX volatility. No additional signal.',
    };
  }
  if (vvix < VVIX_THRESHOLDS.unstable) {
    return {
      value: vvix,
      signal: 'elevated',
      label: 'UNSTABLE',
      color: theme.caution,
      advice: 'VIX could spike mid-session. Tighten deltas or reduce size.',
    };
  }
  return {
    value: vvix,
    signal: 'extreme',
    label: 'DANGER',
    color: theme.red,
    advice:
      'VIX is highly volatile \u2014 significant whipsaw risk. Consider sitting out.',
  };
}
