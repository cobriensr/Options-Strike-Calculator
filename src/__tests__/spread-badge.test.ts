import { describe, expect, it } from 'vitest';
import { describeSpread } from '../utils/spread-badge';
import type { SpreadLeg, SpreadShape } from '../types/spread-legs';

function leg(
  optionType: 'C' | 'P',
  strike: number,
  expiry = '2026-10-28',
): SpreadLeg {
  return { optionType, strike, expiry, size: 1, price: 1, tradeCode: null };
}

describe('describeSpread', () => {
  it('describes a call vertical', () => {
    expect(describeSpread('vertical', [leg('C', 727), leg('C', 726)])).toBe(
      'call vertical 726/727',
    );
  });

  it('describes a put butterfly', () => {
    expect(
      describeSpread('butterfly', [
        leg('P', 145),
        leg('P', 135),
        leg('P', 140),
      ]),
    ).toBe('put butterfly 135/140/145');
  });

  it('dedupes strikes across expiries on a calendar', () => {
    expect(
      describeSpread('calendar', [
        leg('P', 215, '2026-10-26'),
        leg('P', 215, '2026-10-28'),
      ]),
    ).toBe('put calendar 215');
  });

  it('omits the type word for mixed legs', () => {
    expect(describeSpread('combo', [leg('C', 940), leg('P', 890)])).toBe(
      'combo 890/940',
    );
  });

  it('keeps a .5 strike and drops .0', () => {
    expect(describeSpread('vertical', [leg('C', 927.5), leg('C', 930)])).toBe(
      'call vertical 927.5/930',
    );
  });

  it('sorts strikes numerically, not lexically', () => {
    expect(describeSpread('vertical', [leg('C', 1000), leg('C', 95)])).toBe(
      'call vertical 95/1000',
    );
  });

  it('shows the shape alone when there are no legs', () => {
    expect(describeSpread('complex', [])).toBe('complex');
  });

  const words: [SpreadShape, string][] = [
    ['vertical', 'vertical'],
    ['calendar', 'calendar'],
    ['diagonal', 'diagonal'],
    ['straddle', 'straddle'],
    ['combo', 'combo'],
    ['butterfly', 'butterfly'],
    ['three_leg', '3-leg'],
    ['four_leg', '4-leg'],
    ['four_leg_multi_expiry', '4-leg roll'],
    ['complex', 'complex'],
    ['unpaired', 'leg vs stock/futures'],
    ['other', 'multi-leg'],
  ];
  it.each(words)('maps %s to "%s"', (shape, word) => {
    expect(describeSpread(shape, [leg('C', 100)])).toBe(`call ${word} 100`);
  });
});
