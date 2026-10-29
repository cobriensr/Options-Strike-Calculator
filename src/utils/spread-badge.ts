import type { SpreadLeg, SpreadShape } from '../types/spread-legs';

const SHAPE_WORDS: Record<SpreadShape, string> = {
  vertical: 'vertical',
  calendar: 'calendar',
  diagonal: 'diagonal',
  straddle: 'straddle',
  combo: 'combo',
  butterfly: 'butterfly',
  three_leg: '3-leg',
  four_leg: '4-leg',
  four_leg_multi_expiry: '4-leg roll',
  complex: 'complex',
  unpaired: 'leg vs stock/futures',
  other: 'multi-leg',
};

/**
 * One-line description of a spread: optional call/put word (only when every
 * leg shares a type), the shape word, then unique strikes low to high.
 * e.g. `call vertical 726/727`, `combo 890/940`.
 */
export function describeSpread(shape: SpreadShape, legs: SpreadLeg[]): string {
  const types = new Set(legs.map((l) => l.optionType));
  let typeWord = '';
  if (types.size === 1) typeWord = types.has('C') ? 'call' : 'put';

  const strikes = [...new Set(legs.map((l) => l.strike))]
    .sort((a, b) => a - b)
    .join('/');

  return [typeWord, SHAPE_WORDS[shape], strikes]
    .filter((part) => part !== '')
    .join(' ');
}
