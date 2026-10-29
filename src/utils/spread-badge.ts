import type { SpreadLeg, SpreadShape } from '../types/spread-legs';

const SHAPE_WORDS: Partial<Record<SpreadShape, string>> = {
  three_leg: '3-leg',
  four_leg: '4-leg',
  four_leg_multi_expiry: '4-leg roll',
  unpaired: 'leg vs stock/futures',
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

  return [typeWord, SHAPE_WORDS[shape] ?? shape, strikes]
    .filter((part) => part !== '')
    .join(' ');
}
