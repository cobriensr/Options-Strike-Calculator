/**
 * Tile colours shared by the GEXBot summary tiles (DealerStateSummaryStrip,
 * NetVannaTile, ExpectedMoveTile). Moved out of the strip unchanged: `long`
 * is emerald, `short` is rose, `unknown` is the neutral tile.
 */

import type { GammaSign } from './types';

export interface TileTone {
  container: string;
  accent: string;
  headline: string;
}

export function toneClasses(sign: GammaSign): TileTone {
  if (sign === 'long') {
    return {
      container: 'border-emerald-500/30 bg-emerald-500/5',
      accent: 'bg-emerald-400',
      headline: 'text-emerald-300',
    };
  }
  if (sign === 'short') {
    return {
      container: 'border-rose-500/30 bg-rose-500/5',
      accent: 'bg-rose-400',
      headline: 'text-rose-300',
    };
  }
  return {
    container: 'border-white/10 bg-white/[0.02]',
    accent: 'bg-white/20',
    headline: 'text-tertiary',
  };
}
