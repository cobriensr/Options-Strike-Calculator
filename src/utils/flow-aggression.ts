/**
 * flow-aggression — classifies options-flow alerts by ask-side ratio into
 * aggressive (buyer paying up), absorbed (seller filling at bid — often
 * hedging), or mixed. EDA showed these populations behave very differently,
 * so the UI bifurcates them visually and computes directional lean from the
 * aggressive subset only.
 *
 * Thresholds are tunable here — change them and every consumer
 * (OptionsFlowTable row tint + badge, FlowDirectionalRollup split counts)
 * reclassifies automatically.
 */

// Thresholds tunable here; update and everything downstream re-classifies.
export const AGGRESSION_THRESHOLDS = {
  AGGRESSIVE: 0.7,
  ABSORBED: 0.3,
} as const;

export type Aggression = 'aggressive' | 'absorbed' | 'mixed';

/**
 * Classify a strike's ask-side ratio into an aggression bucket.
 *
 * Returns `null` when `askSideRatio` is `null` (missing data). Before this
 * guard, a null-coerced-to-zero ratio was tagged "absorbed", making
 * truly-absorbed rows visually indistinguishable from rows where the ratio
 * was simply unavailable. Callers should treat a `null` return the same as
 * `'mixed'` — quiet, no badge, no row tint.
 */
export function classifyAggression(
  askSideRatio: number | null,
): Aggression | null {
  if (askSideRatio === null) return null;
  if (askSideRatio >= AGGRESSION_THRESHOLDS.AGGRESSIVE) return 'aggressive';
  if (askSideRatio <= AGGRESSION_THRESHOLDS.ABSORBED) return 'absorbed';
  return 'mixed';
}

export const AGGRESSION_LABEL: Record<Aggression, string> = {
  aggressive: 'AGG',
  absorbed: 'ABS',
  mixed: '—',
};

export const AGGRESSION_TOOLTIP: Record<Aggression, string> = {
  aggressive: 'Buyer paying at ask (directional bet)',
  absorbed: 'Seller filling at bid (often hedging)',
  mixed: 'Mixed — unclear directional intent',
};
