import { describe, it, expect } from 'vitest';
import {
  classSignal,
  type GexClassification,
  type Direction,
} from '../../utils/gex-classification';

const CLASSES: GexClassification[] = [
  'max-launchpad',
  'fading-launchpad',
  'sticky-pin',
  'weakening-pin',
];
const DIRECTIONS: Direction[] = ['ceiling', 'floor', 'atm'];

describe('classSignal', () => {
  // Owner decision D1 revised (2026-10-29): the GexLandscape data is GEXBot
  // taker flow, so the signal describes the taker side and position only;
  // the UW-era breakout / pin / floor predictions are gone.
  it.each([
    ['max-launchpad', 'ceiling', 'Taker-short γ above spot'],
    ['max-launchpad', 'floor', 'Taker-short γ below spot'],
    ['max-launchpad', 'atm', 'Taker-short γ at spot'],
    ['fading-launchpad', 'ceiling', 'Taker-short γ above spot'],
    ['fading-launchpad', 'floor', 'Taker-short γ below spot'],
    ['fading-launchpad', 'atm', 'Taker-short γ at spot'],
    ['sticky-pin', 'ceiling', 'Taker-long γ above spot'],
    ['sticky-pin', 'floor', 'Taker-long γ below spot'],
    ['sticky-pin', 'atm', 'Taker-long γ at spot'],
    ['weakening-pin', 'ceiling', 'Taker-long γ above spot'],
    ['weakening-pin', 'floor', 'Taker-long γ below spot'],
    ['weakening-pin', 'atm', 'Taker-long γ at spot'],
  ] as const)('%s at %s reads "%s"', (cls, dir, label) => {
    expect(classSignal(cls, dir)).toBe(label);
  });

  it('gives each (gamma side × direction) pair its own label', () => {
    const labels = new Set<string>();
    for (const cls of CLASSES) {
      for (const dir of DIRECTIONS) labels.add(classSignal(cls, dir));
    }
    expect(labels.size).toBe(6);
  });

  it('makes no dealer, market-maker or price-path prediction', () => {
    for (const cls of CLASSES) {
      for (const dir of DIRECTIONS) {
        expect(classSignal(cls, dir)).not.toMatch(
          /market.?maker|dealer|\bMM|breakout|collapse|launch|pin|hard|soft|weak|ceiling|floor|risk/i,
        );
      }
    }
  });
});
